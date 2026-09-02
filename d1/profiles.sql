-- Object profiles schema — D1 `orbit-profiles`, binding PROFILE_DB.
--
--   wrangler d1 execute orbit-profiles --local  --file d1/profiles.sql
--   wrangler d1 execute orbit-profiles --remote --file d1/profiles.sql
--
-- The descriptive knowledge base: what an object IS, as opposed to where it is.
-- Deliberately a SECOND database rather than more tables in `orbit-catalog` —
-- D1 cannot join across databases, so this is a real cost (the API layer
-- composes /api/object's response from two reads) accepted to keep enrichment
-- writes away from the hard-won read budget documented in
-- .claude/rules/ingest-d1.md. The write side is workers/orbit-profiles/; Pages
-- Functions read this and never write it.
--
-- Every statement is idempotent — this file is re-runnable as a migration.
--
-- One departure from orbit-catalog: this database is not read-cost optimised.
-- 28k rows behind indexed filters is noise against 25B row reads/mo. But that
-- is a property of the paid plan, not of the workload — the query discipline in
-- .claude/rules/ingest-d1.md still applies here, and a plan change is not a
-- licence to reintroduce unindexed GROUP BY scans.
--
-- Data sources: only those in `sources` below — NSSDCA and NASA imagery (public
-- domain), GCAT (CC-BY), Space-Track SATCAT (blanket approval, citation
-- required). Share-alike sources are excluded on purpose; see the spec.

-- ── sources ────────────────────────────────────────────────────────────────
-- THE ENFORCEMENT MECHANISM, not a lookup table. Ingest calls assertAllowed()
-- and refuses to write any field whose source_id is absent from here, so a
-- source that has not been licence-reviewed cannot physically enter the
-- database. This is the most important invariant in this schema: the licensing
-- position (facts are not copyrightable, a curated compilation is) only holds
-- if provenance is complete, and it is only complete if unknown sources are
-- impossible rather than merely discouraged.
--
-- `priority` breaks conflicts when two sources disagree about the same field —
-- higher wins, ties by id ascending so a re-run is deterministic (facts.js).
-- `attribution_text` is what the UI must render wherever a field from this
-- source is shown; GCAT's CC-BY obligation is discharged by displaying it.
CREATE TABLE IF NOT EXISTS sources (
  id               TEXT PRIMARY KEY,   -- nssdca | gcat | spacetrack-satcat | nasa-imagery
  name             TEXT NOT NULL,
  url              TEXT,
  license          TEXT NOT NULL,      -- public-domain | CC-BY-4.0 | spacetrack-blanket
  attribution_text TEXT NOT NULL,      -- rendered by the UI, verbatim
  priority         INTEGER NOT NULL DEFAULT 0,
  retrieved_at     TEXT
);

-- ── profiles ───────────────────────────────────────────────────────────────
-- The structured spine: one row per catalogued object, keyed by the same NORAD
-- id `objects.NORAD_CAT_ID` uses in the other database — that integer is the
-- only join key between the two, and the composition in functions/api/ depends
-- on it staying an INTEGER for the Alpha-5 reason d1/orbit.sql explains.
--
-- `cospar` is the match key against NSSDCA and GCAT, canonicalised to 1998-067A
-- form by match.js. Matching is on COSPAR and never on name — "ISS (NAUKA)" and
-- "ISS DEB" both substring-match "ISS" (functions/api/object/[norad].js:11-13).
--
-- `prose` + `prose_tier` hold the rendered description. Tier 2 is deterministic
-- templated text with no model call; Tier 3 is generated from verified Tier 1
-- facts and only survives if validate.js finds no numeral the facts do not
-- support. A rejected Tier 3 sentence falls back to Tier 2, so this column is
-- never empty and never carries an unverified number.
--
-- `operator_name` here is a SOURCED fact with a row in profile_fields; it is
-- not the same thing as objects.operator, which is our own inference from the
-- object name and is badged as derived wherever it is shown.
CREATE TABLE IF NOT EXISTS profiles (
  norad             INTEGER PRIMARY KEY,
  cospar            TEXT,      -- canonical 1998-067A form
  official_name     TEXT,
  mission_summary   TEXT,
  operator_name     TEXT,
  owner_country     TEXT,
  bus               TEXT,
  manufacturer      TEXT,
  launch_mass_kg    REAL,
  power_w           REAL,
  design_life_years REAL,
  mission_type      TEXT,
  status            TEXT,
  prose             TEXT,
  prose_tier        INTEGER,   -- 2 = templated, 3 = generated and validated
  updated_at        TEXT
);

-- The five dimensions the encyclopedia filters and orders by.
CREATE INDEX IF NOT EXISTS idx_profiles_country  ON profiles(owner_country);
CREATE INDEX IF NOT EXISTS idx_profiles_type     ON profiles(mission_type);
CREATE INDEX IF NOT EXISTS idx_profiles_operator ON profiles(operator_name);
CREATE INDEX IF NOT EXISTS idx_profiles_status   ON profiles(status);
CREATE INDEX IF NOT EXISTS idx_profiles_cospar   ON profiles(cospar);

-- ── profile_fields ─────────────────────────────────────────────────────────
-- Provenance sidecar: one row per populated field of `profiles`, carrying which
-- source it came from and how confident the match was. This is what lets the UI
-- render "launch mass: 6,161 kg (NSSDCA)" and what makes the database
-- auditable. A sidecar rather than inline columns because 15 spine fields would
-- otherwise mean 15 extra provenance columns.
--
-- PRIMARY KEY (norad, field) is load-bearing: without it a re-run appends a
-- second provenance row instead of replacing the first, and the UI would then
-- have to guess which citation is current.
CREATE TABLE IF NOT EXISTS profile_fields (
  norad       INTEGER NOT NULL,
  field       TEXT NOT NULL,      -- a column name of `profiles`
  source_id   TEXT NOT NULL,      -- must exist in `sources` — enforced in facts.js
  source_url  TEXT,
  confidence  REAL,
  updated_at  TEXT,
  PRIMARY KEY (norad, field)
);

CREATE INDEX IF NOT EXISTS idx_profile_fields_norad  ON profile_fields(norad);
CREATE INDEX IF NOT EXISTS idx_profile_fields_source ON profile_fields(source_id);

-- ── images ─────────────────────────────────────────────────────────────────
-- R2 holds the bytes (profiles/<norad>/primary.webp and .../thumb.webp); this
-- table holds the keys and the credit line. `license` and `credit` are stored
-- per image rather than inherited from `sources` because a public-domain source
-- can still host an image whose credit differs from the source's own.
CREATE TABLE IF NOT EXISTS images (
  norad       INTEGER NOT NULL,
  r2_key      TEXT NOT NULL,
  thumb_key   TEXT,
  width       INTEGER,
  height      INTEGER,
  credit      TEXT,
  license     TEXT,
  source_url  TEXT,
  is_primary  INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT,
  PRIMARY KEY (norad, r2_key)
);

CREATE INDEX IF NOT EXISTS idx_images_norad ON images(norad);

-- ── ingest_checkpoints ─────────────────────────────────────────────────────
-- Resumability is a requirement, not a nicety: a 28k-object pass runs for
-- tens of minutes as an Actions job, and a run that dies at object 14,000 must
-- restart at 14,000 rather than re-doing the work (and, for Tier 3, re-spending
-- the model budget). Keyed by stage — match | facts | prose | images — each
-- holding the last NORAD that completed that stage.
CREATE TABLE IF NOT EXISTS ingest_checkpoints (
  stage        TEXT PRIMARY KEY,   -- match | facts | prose | images
  last_norad   INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT
);
