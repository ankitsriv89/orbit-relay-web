// Cloudflare Pages Function — ranked reentry watch list (plan 33 wave 4).
//
//   GET /api/decay-watch?limit=50
//
// Ranks objects by their SOONEST predicted reentry, using each object's most
// recent decay message (a later 60-day or TIP prediction supersedes an earlier
// one — Space-Track revises DECAY_EPOCH as the estimate tightens). Excludes
// anything that has already actually decayed (`objects.DECAY_DATE`), since a
// stale prediction for an object we now know came down is noise, not a watch
// item.
//
// These are Space-Track's OWN predictions (60-day and TIP messages), not this
// project's derived conjunction screening — that lands in wave 5, badged
// `UNOFFICIAL — NOT FOR COLLISION AVOIDANCE`. This list carries no such badge
// because it redistributes an upstream prediction rather than deriving one.

import { json, preflight, requireDb, withCitation, parseEpochUTC } from './_catalog.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// One row per NORAD: the latest message for each object, joined back to its
// own table by (NORAD_CAT_ID, MAX(MSG_EPOCH)) rather than a window function —
// D1's SQLite build is not guaranteed to have them, and every other query in
// this package avoids them too.
// The `decay` table holds Space-Track's HISTORICAL decay messages as well as
// its forward predictions — Sputnik 1 is in there with DECAY_EPOCH
// `1957-12-01 0:00:00`. Without a lower bound this list, whose whole claim is
// "ranked by soonest predicted reentry", opened with three 1957 decays and a
// countdown of -25,076 days. `substr(...,1,10)` rather than a whole-string
// compare because DECAY_EPOCH is a `varchar(24)` in Space-Track's own format
// (`1957-12-01 0:00:00`, unpadded hour), not ISO-8601 — see parseEpochUTC.
const SQL = `
  SELECT d.NORAD_CAT_ID, d.OBJECT_NAME, d.COUNTRY, d.RCS_SIZE,
         d.DECAY_EPOCH, d.MSG_EPOCH, d.SOURCE, d.PRECEDENCE,
         o.OBJECT_TYPE, o.regime, o.operator, o.DECAY_DATE
  FROM decay d
  JOIN (
    SELECT NORAD_CAT_ID, MAX(MSG_EPOCH) AS latest
    FROM decay GROUP BY NORAD_CAT_ID
  ) latest ON latest.NORAD_CAT_ID = d.NORAD_CAT_ID AND latest.latest = d.MSG_EPOCH
  LEFT JOIN objects o ON o.NORAD_CAT_ID = d.NORAD_CAT_ID
  WHERE d.DECAY_EPOCH IS NOT NULL
    AND substr(d.DECAY_EPOCH, 1, 10) >= ?
    AND (o.DECAY_DATE IS NULL OR o.NORAD_CAT_ID IS NULL)
  ORDER BY d.DECAY_EPOCH ASC
  LIMIT ?`;

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return preflight();

  const unbound = requireDb(env);
  if (unbound) return unbound;

  const url = new URL(request.url);
  const limit = clamp(Number.parseInt(url.searchParams.get('limit'), 10) || DEFAULT_LIMIT,
                       1, MAX_LIMIT);

  const now = Date.now();
  // Today in UTC. A prediction whose epoch has already passed is history, not a
  // watch item — but "today" rather than "now" so an object due in a few hours
  // does not vanish from the list before it has actually come down.
  const from = new Date(now).toISOString().slice(0, 10);

  const { results } = await env.ORBIT_DB.prepare(SQL).bind(from, limit).all();

  const watch = (results || []).map((r) => {
    const t = parseEpochUTC(r.DECAY_EPOCH);
    return {
      norad: r.NORAD_CAT_ID,
      name: r.OBJECT_NAME || `NORAD ${r.NORAD_CAT_ID}`,
      country: r.COUNTRY,
      type: r.OBJECT_TYPE || null,
      regime: r.regime || null,
      rcs_size: r.RCS_SIZE,
      operator: r.operator || null,
      operator_derived: r.operator != null,
      decay_epoch: r.DECAY_EPOCH,
      msg_epoch: r.MSG_EPOCH,
      source: r.SOURCE,
      precedence: r.PRECEDENCE,
      // Ceiling, not round: "0 days" reads as "already down", so anything still
      // in the future through tomorrow shows as at least 1.
      days_until: Number.isNaN(t) ? null : Math.ceil((t - now) / 86400000),
    };
  });

  return json(withCitation({
    generated_at: new Date().toISOString(),
    note: "Space-Track's own reentry predictions (60-day / TIP messages), " +
          'ranked by soonest — not this project\'s derived conjunction screening.',
    watch,
  }), { maxAge: 300 });
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
