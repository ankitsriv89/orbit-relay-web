// Cloudflare Pages Function — one object's dossier.
//
//   GET /api/object/25544
//
// Joins the three tables that describe an object from different angles:
// `objects` is the live elset (GP), `satcat` is the catalog record (launch
// site, RCS value, decay), and `decay` holds reentry predictions. They overlap
// deliberately — GP and SATCAT disagree on field names for the same quantity,
// and where they do, GP wins because it is the fresher of the two.
//
// The ISS is NORAD 25544. Nothing here matches on the string "ISS" or "ZARYA":
// names change, and "ISS (NAUKA)" / "ISS DEB" would both match a substring
// test — audit finding M-19.

import { json, preflight, requireDb, withCitation } from '../_catalog.js';

const SQL = `
  SELECT
    o.NORAD_CAT_ID, o.OBJECT_NAME, o.OBJECT_ID, o.OBJECT_TYPE, o.COUNTRY_CODE,
    o.RCS_SIZE, o.SITE, o.LAUNCH_DATE, o.DECAY_DATE,
    o.EPOCH, o.CREATION_DATE, o.MEAN_MOTION, o.ECCENTRICITY, o.INCLINATION,
    o.RA_OF_ASC_NODE, o.ARG_OF_PERICENTER, o.MEAN_ANOMALY, o.BSTAR,
    o.SEMIMAJOR_AXIS, o.PERIOD, o.APOAPSIS, o.PERIAPSIS,
    o.REV_AT_EPOCH, o.TLE_LINE1, o.TLE_LINE2,
    o.regime, o.launch_year, o.debris_family, o.operator, o.first_seen, o.updated_at,
    s.SATNAME     AS satcat_name,
    s.LAUNCH      AS satcat_launch,
    s.SITE        AS satcat_site,
    s.RCSVALUE    AS satcat_rcs_m2,
    s.APOGEE      AS satcat_apogee,
    s.PERIGEE     AS satcat_perigee,
    s.PERIOD      AS satcat_period,
    s.COUNTRY     AS satcat_country,
    s.COMMENT     AS satcat_comment
  FROM objects o
  LEFT JOIN satcat s ON s.NORAD_CAT_ID = o.NORAD_CAT_ID
  WHERE o.NORAD_CAT_ID = ?`;

// Most recent prediction wins; the 60-day and daily messages both land here.
const DECAY_SQL = `
  SELECT MSG_EPOCH, DECAY_EPOCH, SOURCE, MSG_TYPE, PRECEDENCE, RCS
  FROM decay WHERE NORAD_CAT_ID = ?
  ORDER BY MSG_EPOCH DESC LIMIT 5`;

const EVENTS_SQL = `
  SELECT ts, kind, title, detail FROM events
  WHERE NORAD_CAT_ID = ? ORDER BY ts DESC, id DESC LIMIT 20`;

export async function onRequest(context) {
  const { request, env, params } = context;
  if (request.method === 'OPTIONS') return preflight();

  const unbound = requireDb(env);
  if (unbound) return unbound;

  // Alpha-5 is why the catalog number is an integer everywhere in this project;
  // anything non-numeric is a client bug, not a lookup that might succeed.
  //
  // The whole segment must be digits. `Number.parseInt` alone accepts trailing
  // garbage — "25544; DROP TABLE objects" parses to 25544 — so a malformed path
  // would answer 200 with a real dossier and hide the caller's bug. (The value
  // is bound, so that was never an injection; it was a lookup that should have
  // been a 400.)
  const raw = String(params.norad || '');
  if (!/^\d+$/.test(raw)) {
    return json({ error: 'norad must be a positive integer' }, { status: 400 });
  }
  const norad = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(norad) || norad <= 0) {
    return json({ error: 'norad must be a positive integer' }, { status: 400 });
  }

  const object = await env.ORBIT_DB.prepare(SQL).bind(norad).first();
  if (!object) {
    return json({ error: `No catalogued object with NORAD ${norad}.` }, { status: 404 });
  }

  const [decay, events] = await Promise.all([
    env.ORBIT_DB.prepare(DECAY_SQL).bind(norad).all(),
    env.ORBIT_DB.prepare(EVENTS_SQL).bind(norad).all(),
  ]);

  return json(withCitation({
    object: {
      ...object,
      // APOAPSIS/PERIAPSIS (GP) and APOGEE/PERIGEE (SATCAT) are the same
      // quantity under different names, and both are ALTITUDES above the
      // surface rather than radii. Naming them once, unambiguously, keeps that
      // out of the frontend — getting it wrong puts the ISS at ~6800 km.
      apogee_km:  object.APOAPSIS  ?? object.satcat_apogee  ?? null,
      perigee_km: object.PERIAPSIS ?? object.satcat_perigee ?? null,
      // `operator` is OUR inference from the name, not a Space-Track field.
      operator_derived: object.operator != null,
    },
    decay: (decay.results || []).map((d) => ({ ...d, predicted: true })),
    events: (events.results || []).map((e) => ({
      ...e, detail: safeParse(e.detail),
    })),
  }), { maxAge: 300 });
}

function safeParse(s) {
  if (s == null) return null;
  try { return JSON.parse(s); } catch (_) { return s; }
}
