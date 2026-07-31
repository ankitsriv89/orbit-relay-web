-- Mars Sim telemetry — D1 schema (plan 24).
-- One row per gameplay/device event. No PII: `anon_id` is a random per-install
-- UUID minted client-side (telemetry.js), never a hardware/advertising id.
--
-- One-time setup (you run this — I have no Cloudflare account access):
--   wrangler d1 create mars-telemetry
--   # paste the printed database_id into wrangler.toml
--   wrangler d1 execute mars-telemetry --remote --file d1/telemetry.sql
--   # (drop --remote to seed the local dev DB for `wrangler pages dev`)

CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,   -- server-minted uuid
  ts          INTEGER NOT NULL,   -- server receive time (epoch ms)
  anon_id     TEXT,               -- per-install random uuid (mc-anon-id)
  session_id  TEXT,               -- per-launch id
  app_version TEXT,
  platform    TEXT,               -- 'android' | 'web'
  country     TEXT,               -- request.cf.country (coarse geo, no GPS)
  name        TEXT NOT NULL,      -- event name (server allowlist)
  props       TEXT                -- JSON string of event-specific fields
);

CREATE INDEX IF NOT EXISTS idx_events_ts   ON events (ts);
CREATE INDEX IF NOT EXISTS idx_events_name ON events (name);
CREATE INDEX IF NOT EXISTS idx_events_anon ON events (anon_id);
