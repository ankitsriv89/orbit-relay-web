// Shared rate limiting for the public /api/* surface.
//
// The leading underscore keeps this out of Pages' file-based routing.
//
// WHY THIS EXISTS — the cost, measured rather than guessed:
//
// D1 bills rows SCANNED, not rows returned. Against the real schema with a
// production-shaped 31,944-row catalog, one /api/search costs:
//
//   /api/search?q=starlink   27,381 rows examined (86% of the catalog) x2
//   /api/search?facets=1     27,381 rows examined x5
//   /api/object/25544             1 row
//
// The driver is `DECAY_DATE IS NULL`, present on EVERY search regardless of
// the query text — `idx_objects_decay` matches it, so the query plan reads as
// "SEARCH ... USING INDEX", but the predicate selects 27,381 of 31,944 rows.
// It is an index seek that then walks most of the table. A bare /api/search
// with no parameters costs the same as a text search.
//
// Caching (see cached() in _catalog.js) is the primary defence and does far
// more good than this does: it collapses N identical calls into one D1 hit.
// Rate limiting covers what caching structurally cannot — a caller generating
// unique query strings, where every request is a cache miss by construction.
//
// FAILS OPEN, deliberately. An absent binding means no limiting, not a 503.
// This is the opposite of admin/_middleware.js, where absent secrets are a 503
// — and the difference is the point: admin guards ACCESS, so degrading to
// "no auth required" would be a security hole. This guards COST, so degrading
// to "no limit" is a billing risk, and taking the public API down to avoid a
// billing risk is the worse failure.

import { CITATION, CITATION_HEADER } from './_orbit.js';

/**
 * 30 requests/minute per IP.
 *
 * Deliberately generous relative to any human: /spacetrack/ fires at most a
 * handful of calls per interaction, so a person browsing hard stays an order
 * of magnitude under this. It is set where a runaway script or an agent in a
 * retry loop is capped without a real visitor ever meeting it.
 *
 * The window is fixed at 60s by Cloudflare's binding — it accepts only 10 or
 * 60 for `period` — so `requestsPerMinute` IS the configured limit, not a
 * rate derived from some other window. wrangler.toml's `simple.limit` must
 * match this number; api-throttle.test.mjs pins both.
 */
export const RATE_LIMIT = {
  requestsPerMinute: 30,
  windowSeconds: 60,
};

// /api/hit and /api/feedback are the only POSTs here and the only endpoints
// that WRITE to D1 — one INSERT per call. They must not share a budget with
// the read endpoints: a visitor hitting the read limit would otherwise stop
// their own analytics beacon or feedback submission, and an abusive beacon
// would consume the budget for real reads.
const WRITE_PATHS = new Set(['/api/hit', '/api/feedback']);

/**
 * The bucket key for a request: one budget per IP per class.
 *
 * CF-Connecting-IP is set by Cloudflare's edge and cannot be spoofed by the
 * client (unlike X-Forwarded-For, which is caller-supplied and must never be
 * trusted for this). Absent it — local dev, or a test — everything shares one
 * bucket, which is correct for a single developer.
 */
function bucketKey(request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const { pathname } = new URL(request.url);
  const cls = WRITE_PATHS.has(pathname) ? 'write' : 'read';
  return `${cls}:${ip}`;
}

/**
 * A 429 that a client can actually act on.
 *
 * An opaque edge block teaches a caller nothing — it retries immediately and
 * stays blocked. Retry-After plus the RateLimit-* headers are what let a
 * well-behaved client back off correctly, and a JSON body keeps the shape
 * every other endpoint here returns.
 *
 * The citation rides on this too. It is a condition of the USSPACECOM
 * redistribution approval and does not lapse because a response was refused.
 */
export function rateLimitResponse() {
  return new Response(JSON.stringify({
    error: `Rate limit exceeded — ${RATE_LIMIT.requestsPerMinute} requests per minute per IP.`,
    retry_after_seconds: RATE_LIMIT.windowSeconds,
    limit: RATE_LIMIT.requestsPerMinute,
  }), {
    status: 429,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      [CITATION_HEADER]: CITATION,
      'Retry-After': String(RATE_LIMIT.windowSeconds),
      'RateLimit-Limit': String(RATE_LIMIT.requestsPerMinute),
      'RateLimit-Remaining': '0',
      'RateLimit-Reset': String(RATE_LIMIT.windowSeconds),
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * @returns {Promise<Response|null>} a 429 to return, or null to proceed.
 */
export async function checkLimit(env, request) {
  const limiter = env && env.API_RATE_LIMITER;
  if (!limiter || typeof limiter.limit !== 'function') return null; // fail open

  try {
    const { success } = await limiter.limit({ key: bucketKey(request) });
    return success ? null : rateLimitResponse();
  } catch (_) {
    // A limiter that throws must not take the endpoint with it — same reason
    // as the missing-binding case above.
    return null;
  }
}
