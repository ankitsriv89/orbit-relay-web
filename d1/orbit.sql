-- Orbit catalog schema (plan 33 wave 2) — D1 `orbit-catalog`, binding ORBIT_DB.
--
--   wrangler d1 execute orbit-catalog --local  --file d1/orbit.sql
--   wrangler d1 execute orbit-catalog --remote --file d1/orbit.sql
--
-- D1 is the queryable source of truth: deltas are cheap upserts and it answers
-- "search by name", "group by country", "dossier for NORAD 25544" natively. R2
-- holds the pre-rendered artifacts the globe actually reads, regenerated after
-- each ingest, so the hot path is a flat object read and never a query.
--
-- Every statement is idempotent — this file is re-runnable as a migration.
--
-- Data source: Space-Track.org (USSPACECOM). Redistribution of TLE/OMM, SATCAT
-- and decay data is under express blanket approval CONDITIONED ON CITATION, so
-- anything serving from these tables must carry the attribution string.

-- ── objects ────────────────────────────────────────────────────────────────
-- One row per catalogued object, upserted from the GP (OMM) class. Column
-- names mirror Space-Track's own predicates so the ingest mapping stays a
-- straight rename-free copy; derived columns are lowercase to mark them ours.
--
-- Field names and types are taken from `modeldef/class/gp` (captured in
-- fixtures/modeldef_gp.json), not inferred — see test/schema.test.mjs, which
-- fails if this table names a column the API does not actually return.
--
-- NORAD_CAT_ID is a true INTEGER, not the TLE-format string: above 100,000
-- Space-Track emits Alpha-5, which silently corrupts satnum in satellite.js.
-- This is why the ingest requests format/json rather than format/tle.
--
-- Omitted from GP's 40 fields, deliberately: CCSDS_OMM_VERS, COMMENT,
-- ORIGINATOR, CENTER_NAME, REF_FRAME, TIME_SYSTEM, MEAN_ELEMENT_THEORY — all
-- constant OMM envelope metadata, identical on every row.
CREATE TABLE IF NOT EXISTS objects (
  NORAD_CAT_ID      INTEGER PRIMARY KEY,
  OBJECT_NAME       TEXT,
  OBJECT_ID         TEXT,     -- international designator, e.g. 1999-025A
  OBJECT_TYPE       TEXT,     -- Payload | Rocket Body | Debris | Unknown
  COUNTRY_CODE      TEXT,     -- registering state, NOT the operator (see `operator`)
  RCS_SIZE          TEXT,     -- Small | Medium | Large
  SITE              TEXT,     -- launch site code
  LAUNCH_DATE       TEXT,
  DECAY_DATE        TEXT,     -- NULL while on orbit; the ingest filters on this

  EPOCH             TEXT,
  CREATION_DATE     TEXT,     -- drives the delta window; see idx_objects_creation
  MEAN_MOTION       REAL,
  ECCENTRICITY      REAL,
  INCLINATION       REAL,
  RA_OF_ASC_NODE    REAL,
  ARG_OF_PERICENTER REAL,
  MEAN_ANOMALY      REAL,
  BSTAR             REAL,
  MEAN_MOTION_DOT   REAL,
  MEAN_MOTION_DDOT  REAL,
  SEMIMAJOR_AXIS    REAL,     -- km from Earth's centre
  PERIOD            REAL,     -- minutes
  -- GP calls these APOAPSIS/PERIAPSIS; SATCAT calls the same quantities
  -- APOGEE/PERIGEE. Both are ALTITUDES above the surface, not radii —
  -- verified against the fixtures: SEMIMAJOR_AXIS - 6378.137 equals
  -- (APOAPSIS + PERIAPSIS) / 2 exactly, and GP agrees with SATCAT sub-km.
  APOAPSIS          REAL,
  PERIAPSIS         REAL,

  EPHEMERIS_TYPE      INTEGER,
  CLASSIFICATION_TYPE TEXT,
  ELEMENT_SET_NO      INTEGER,
  REV_AT_EPOCH        INTEGER,
  GP_ID               INTEGER, -- Space-Track's own row id for this elset
  FILE                INTEGER, -- upload batch identifier

  TLE_LINE0         TEXT,     -- "0 VANGUARD 1" — name line of the 3LE
  TLE_LINE1         TEXT,     -- kept verbatim: satellite.js consumes these
  TLE_LINE2         TEXT,

  -- Derived at ingest (Tier B in the plan). Free — computed from the row above,
  -- costing zero extra API calls, which is why partition views stay cheap.
  regime            TEXT,     -- LEO | MEO | GEO | HEO, from PERIOD + ECCENTRICITY
  launch_year       INTEGER,
  debris_family     TEXT,     -- INTLDES prefix, e.g. 1999-025 isolates Fengyun-1C
  operator          TEXT,     -- OUR INFERENCE from OBJECT_NAME, not authoritative

  first_seen        TEXT,     -- when WE first ingested it, for the signal feed
  updated_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_objects_creation  ON objects(CREATION_DATE);
CREATE INDEX IF NOT EXISTS idx_objects_type      ON objects(OBJECT_TYPE);
CREATE INDEX IF NOT EXISTS idx_objects_country   ON objects(COUNTRY_CODE);
CREATE INDEX IF NOT EXISTS idx_objects_regime    ON objects(regime);
CREATE INDEX IF NOT EXISTS idx_objects_operator  ON objects(operator);
CREATE INDEX IF NOT EXISTS idx_objects_family    ON objects(debris_family);
CREATE INDEX IF NOT EXISTS idx_objects_decay     ON objects(DECAY_DATE);
-- Name search is a prefix LIKE; NOCASE keeps it index-usable.
CREATE INDEX IF NOT EXISTS idx_objects_name      ON objects(OBJECT_NAME COLLATE NOCASE);

-- ── satcat ─────────────────────────────────────────────────────────────────
-- The satellite catalogue proper. Pulled once a day, delta only, by FILE
-- number — `class/satcat/file/>{lastFile}` — with the high-water mark kept in
-- KV. Carries the fields GP does not, chiefly the human-readable launch site.
-- All 24 fields from modeldef/class/satcat. Note APOGEE/PERIGEE here vs
-- APOAPSIS/PERIAPSIS in GP — same quantity, different class, and the reason
-- this table does not simply reuse the objects column names.
CREATE TABLE IF NOT EXISTS satcat (
  NORAD_CAT_ID   INTEGER PRIMARY KEY,
  OBJECT_NUMBER  INTEGER,
  INTLDES        TEXT,
  OBJECT_ID      TEXT,
  SATNAME        TEXT,
  OBJECT_NAME    TEXT,
  OBJECT_TYPE    TEXT,
  COUNTRY        TEXT,
  LAUNCH         TEXT,
  SITE           TEXT,
  DECAY          TEXT,
  PERIOD         REAL,
  INCLINATION    REAL,
  APOGEE         REAL,       -- altitude above the surface, km
  PERIGEE        REAL,
  RCSVALUE       INTEGER,
  RCS_SIZE       TEXT,
  LAUNCH_YEAR    INTEGER,
  LAUNCH_NUM     INTEGER,
  LAUNCH_PIECE   TEXT,
  CURRENT        TEXT,       -- 'Y' | 'N'
  COMMENT        TEXT,
  COMMENTCODE    INTEGER,
  FILE           INTEGER,    -- the delta cursor
  updated_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_satcat_file ON satcat(FILE);

-- ── decay ──────────────────────────────────────────────────────────────────
-- Decay and reentry messages. Two feeds land here: the daily current-messages
-- pull and the weekly 60-day prediction pull, told apart by `source`.
-- All 13 fields from modeldef/class/decay. DECAY_EPOCH is a varchar upstream,
-- not a datetime, so it is stored as text and parsed at read time rather than
-- assumed to be ISO-8601.
CREATE TABLE IF NOT EXISTS decay (
  NORAD_CAT_ID   INTEGER,
  OBJECT_NUMBER  INTEGER,
  OBJECT_NAME    TEXT,
  INTLDES        TEXT,
  OBJECT_ID      TEXT,
  RCS            INTEGER,
  RCS_SIZE       TEXT,
  COUNTRY        TEXT,
  MSG_EPOCH      TEXT,
  DECAY_EPOCH    TEXT,
  SOURCE         TEXT,        -- 60day_msg for the weekly prediction feed
  MSG_TYPE       TEXT,
  PRECEDENCE     INTEGER,
  updated_at     TEXT,
  PRIMARY KEY (NORAD_CAT_ID, MSG_EPOCH)
);

CREATE INDEX IF NOT EXISTS idx_decay_epoch  ON decay(DECAY_EPOCH);
CREATE INDEX IF NOT EXISTS idx_decay_source ON decay(SOURCE);

-- ── boxscore ───────────────────────────────────────────────────────────────
-- Per-country tallies, refreshed daily. Small enough to truncate and reload,
-- so there is no delta cursor here.
CREATE TABLE IF NOT EXISTS boxscore (
  COUNTRY               TEXT,
  SPADOC_CD             TEXT,
  ORBITAL_TBA           INTEGER,
  ORBITAL_PAYLOAD_COUNT INTEGER,
  ORBITAL_ROCKET_BODY_COUNT INTEGER,
  ORBITAL_DEBRIS_COUNT  INTEGER,
  ORBITAL_TOTAL_COUNT   INTEGER,
  DECAYED_PAYLOAD_COUNT INTEGER,
  DECAYED_ROCKET_BODY_COUNT INTEGER,
  DECAYED_DEBRIS_COUNT  INTEGER,
  DECAYED_TOTAL_COUNT   INTEGER,
  COUNTRY_TOTAL         INTEGER,
  updated_at            TEXT,
  PRIMARY KEY (COUNTRY, SPADOC_CD)
);

-- ── events ─────────────────────────────────────────────────────────────────
-- The signal feed. Every row is DERIVED by diffing an ingest against what we
-- already held — Space-Track has no "what changed" endpoint, so this table is
-- the reason the ingest keeps history rather than overwriting blindly.
CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL,      -- when we detected it, ISO-8601
  kind         TEXT NOT NULL,      -- new_object | decay | reentry_predicted | satcat_change
  NORAD_CAT_ID INTEGER,
  title        TEXT,
  detail       TEXT,               -- JSON blob, shape varies by kind
  UNIQUE (kind, NORAD_CAT_ID, ts)  -- re-running an ingest must not duplicate
);

CREATE INDEX IF NOT EXISTS idx_events_ts   ON events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);

-- ── api_calls ──────────────────────────────────────────────────────────────
-- The safety rail. Every outbound Space-Track request is logged here BEFORE it
-- is sent, and the ingest hard-aborts if it would exceed 25 calls in any
-- rolling hour (the documented ceiling is 30/min and 300/hour, and breaching
-- the per-class retrieval rates is grounds for account suspension).
--
-- This exists because a runaway loop must not be able to get the account
-- suspended — suspension is real and manual to reverse.
CREATE TABLE IF NOT EXISTS api_calls (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,   -- epoch ms, for cheap rolling-window counting
  class    TEXT,               -- gp | satcat | decay | boxscore | tip | auth
  url      TEXT,
  status   INTEGER,            -- NULL until the response lands
  rows     INTEGER,
  ms       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_api_calls_ts ON api_calls(ts DESC);
