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
 * @param {string} [opts.citation] header citation; defaults to the Space-Track
 *   string. /api/space-weather passes SWPC_CITATION — its body carries no
 *   Space-Track data, so attributing it to USSPACECOM in the header would be
 *   a licence-relevant lie in the other direction.
 */
export function json(body, { status = 200, maxAge = 0, citation = CITATION } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS,
      [CITATION_HEADER]: citation,
      'Cache-Control': maxAge ? `public, max-age=${maxAge}` : 'no-store',
    },
  });
}

export const preflight = () => new Response(null, { status: 204, headers: CORS });

/**
 * Wrap a handler so its response is served from, and written to, the edge cache.
 *
 * **The `maxAge` values passed to json() above do nothing on their own.**
 * Cloudflare does not edge-cache a Function response just because it carries a
 * Cache-Control header — a Function runs on every request unless something
 * explicitly puts its response into the Cache API. Every D1-backed endpoint
 * here shipped a `maxAge` and none of them were ever cached; each call ran the
 * query again. tle.js has always done this correctly and is the model.
 *
 * This matters because D1 bills rows SCANNED, not returned, and the catalog
 * queries are far more expensive than they look — see _ratelimit.js for the
 * measured numbers. Collapsing N identical requests into one D1 hit is the
 * single largest cost lever in this package, and unlike rate limiting it makes
 * the endpoint faster rather than more restrictive.
 *
 * Only 200s carrying a positive `max-age` are stored: a 503 from an unbound D1
 * or a `no-store` error body must never be pinned at the edge for an hour.
 *
 * `caches` is absent in Node and can be absent under `wrangler dev`, so its
 * absence degrades to "just run the handler" rather than throwing.
 *
 * @param {object} context the Pages Function context (needs request + waitUntil)
 * @param {() => Promise<Response>} handler
 */
export async function cached(context, handler) {
  const { request } = context;
  const cache = globalThis.caches && globalThis.caches.default;

  // Vary-free by construction: these endpoints ignore cookies and auth, and the
  // full URL (query string included) is the whole cache key.
  if (!cache || request.method !== 'GET') return handler();

  const hit = await cache.match(request);
  if (hit) return hit;

  const response = await handler();

  const cc = response.headers.get('Cache-Control') || '';
  const maxAge = /max-age=(\d+)/.exec(cc);
  if (response.status === 200 && maxAge && Number(maxAge[1]) > 0 && !/no-store/.test(cc)) {
    // waitUntil so the caller is not blocked on the cache write. The response
    // must be cloned — a Response body can only be read once, and the cache
    // consumes it.
    const put = cache.put(request, response.clone());
    if (context.waitUntil) context.waitUntil(put); else await put;
  }
  return response;
}

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

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function safeParse(s) {
  if (s == null) return null;
  try { return JSON.parse(s); } catch (_) { return s; }
}

/**
 * Read-through: an R2 artifact if present and parseable, else a D1 fallback.
 *
 * summary.js / feed.js / analytics.js each read a flat R2 object first — one
 * GET instead of the GROUP BY(s) the artifact was built from — and only fall
 * back to querying D1 directly when the artifact is missing or corrupt (the
 * window between applying the schema and the first daily ingest run, or a
 * write that got interrupted). A corrupt artifact must not take the endpoint
 * down, so the JSON.parse failure falls through rather than throwing.
 *
 * @param {object} env
 * @param {string} r2Key
 * @param {number} artifactMaxAge cache seconds for a hit
 * @param {() => Promise<object>} fallback builds the D1-derived body; the
 *   caller is responsible for marking it `stale: true` and adding a `note`
 * @param {(artifact: object) => object} [transform] applied to a parsed
 *   artifact before `stale: false` is added (e.g. feed.js slicing to `limit`)
 * @param {object} [opts]
 * @param {string} [opts.citation] passed through to json(); space-weather.js
 *   uses this to put the SWPC attribution in the header on both paths
 */
export async function artifactOrDb(env, r2Key, artifactMaxAge, fallback, transform = (a) => a, { citation } = {}) {
  if (env && env.ORBIT_R2) {
    const object = await env.ORBIT_R2.get(r2Key);
    if (object) {
      try {
        const artifact = JSON.parse(await object.text());
        return json({ ...transform(artifact), stale: false }, { maxAge: artifactMaxAge, citation });
      } catch (_) {
        // A corrupt artifact must not take the endpoint down — fall through to D1.
      }
    }
  }

  const unbound = requireDb(env);
  if (unbound) return unbound;

  return json(await fallback(), { maxAge: 60, citation });
}

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
