// Shared helpers for the /spacetrack/ catalog endpoints (plan 33 wave 3).
//
// The leading underscore keeps this out of Pages' file-based routing.
//
// These read D1 directly, which the globe's hot path deliberately never does —
// group bundles are flat R2 object reads. Dossiers and searches are different:
// they are one row or a few dozen, driven by a click or a keystroke, and
// pre-rendering every possible query is not a thing you can do.

import { CITATION, CITATION_HEADER } from './_orbit.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

/**
 * @param {object} body
 * @param {object} [opts]
 * @param {number} [opts.status]
 * @param {number} [opts.maxAge] seconds; omit for no-store
 */
export function json(body, { status = 200, maxAge = 0 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS,
      [CITATION_HEADER]: CITATION,
      'Cache-Control': maxAge ? `public, max-age=${maxAge}` : 'no-store',
    },
  });
}

export const preflight = () => new Response(null, { status: 204, headers: CORS });

/**
 * Guard for an unbound D1. The Pages project can be deployed before the binding
 * exists, and `undefined.prepare` is a 500 that says nothing useful.
 */
export function requireDb(env) {
  if (!env || !env.ORBIT_DB) {
    return json({ error: 'The orbit catalog is not configured on this deployment.' },
                { status: 503 });
  }
  return null;
}

/** Every response body carries the citation, not just the header. */
export const withCitation = (payload) => ({ citation: CITATION, ...payload });

/**
 * Parse a Space-Track epoch as UTC.
 *
 * `DECAY_EPOCH` is `varchar(24)` upstream, not a datetime. Two things about the
 * real values, both learned the hard way:
 *
 *  1. There is **no timezone**, and `Date.parse()` on a zone-less
 *     `2026-07-26 04:12:00` is implementation-defined — V8 reads it as *local*
 *     time, which is enough to move a `ceil()`'d day count by one on any host
 *     that is not UTC.
 *  2. **The hour is not zero-padded.** Production sends `1957-12-01 0:00:00`,
 *     and that is not a valid ISO time, so rewriting the string to
 *     `1957-12-01T0:00:00Z` and handing it back to `Date.parse()` yields NaN.
 *     Every row of `/api/decay-watch` is that shape; a version of this function
 *     that reconstructed a string silently nulled all 200 countdowns in
 *     production before this note existed.
 *
 * So the components are read explicitly and assembled with `Date.UTC`, rather
 * than a string being repaired well enough to hand to a lenient parser.
 *
 * @returns {number} epoch ms, or NaN when the value is not a recognisable epoch
 */
const ST_EPOCH =
  /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.(\d+))?)?)?$/;

export function parseEpochUTC(value) {
  if (value == null || value === '') return NaN;
  const s = String(value).trim();
  // Anything that already carries a zone is unambiguous — let Date.parse have it.
  if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(s)) return Date.parse(s);
  const m = ST_EPOCH.exec(s);
  if (!m) return Date.parse(s);
  return Date.UTC(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0),
    m[7] ? Math.round(Number(`0.${m[7]}`) * 1000) : 0,
  );
}
