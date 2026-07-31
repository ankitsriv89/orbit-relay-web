// Cloudflare Pages Function — Orbital Relay TLE proxy.
//
//   GET /api/tle?source=celestrak&group=<group>
//
// Celestrak sends no CORS header, so the browser can't fetch it directly; this
// runs server-side (no CORS) and caches each group via the Cloudflare Cache API
// (~6h). On a throttle/empty upstream it falls back to the shipped baseline file
// under /orbit/data/tle/<source>/<group>.txt, so the page never goes blank.
//
// source=spacetrack reads the R2 bundle the orbit-ingest Worker regenerates
// after each ingest (`tle/spacetrack/<group>.txt`). That is a flat object read,
// never a D1 query — the globe's hot path must not touch the database. The
// Space-Track citation is a condition of the redistribution approval and rides
// on every one of those responses.

import { CITATION_HEADER, CITATION } from './_orbit.js';

const ALLOWED_GROUPS = new Set([
  'stations', 'starlink', 'gps-ops', 'glo-ops', 'galileo', 'beidou',
  'qianfan', 'hulianwang', 'irnss', 'iridium-next', 'weather', 'geo',
  'resource', 'last-30-days', 'oneweb', 'sbas',
  'cosmos-2251-debris', 'cosmos-1408-debris', 'fengyun-1c-debris',
  'iridium-33-debris',
]);

const CACHE_TTL = 21600; // 6h

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

function text(status, body, cache, extra) {
  const headers = {
    'Content-Type': 'text/plain; charset=utf-8',
    ...CORS,
    ...extra,
  };
  if (cache) headers['Cache-Control'] = `public, max-age=${CACHE_TTL}`;
  return new Response(body, { status, headers });
}

function looksInvalid(t) {
  return !t || t.startsWith('GP data has not updated') ||
         t.includes('Invalid query') || t.trim().length < 10;
}

/**
 * Serve a group bundle from the R2 artifacts the ingest Worker maintains.
 *
 * No fallback to the Celestrak baseline files: they are a *different source*,
 * and quietly substituting them under `source=spacetrack` would put unattributed
 * third-party data behind the Space-Track citation. A missing bundle is
 * reported as missing.
 */
async function spacetrackBundle(env, group) {
  if (!env || !env.ORBIT_R2) {
    // The binding is absent — Pages is deployed but the R2 bucket was never
    // attached. Say so rather than 500ing on `undefined.get`.
    return text(503, 'Space-Track source is not configured on this deployment.');
  }

  const object = await env.ORBIT_R2.get(`tle/spacetrack/${group}.txt`);
  if (!object) {
    return text(404, `No Space-Track bundle for "${group}" yet — ` +
                     'the ingest Worker has not built one.');
  }

  const body = await object.text();
  if (looksInvalid(body)) {
    return text(502, 'Space-Track bundle is present but empty.');
  }

  return text(200, body, true, {
    [CITATION_HEADER]: CITATION,
    // R2 keeps the generation time on the object; surfacing it lets the HUD
    // show elset age, which matters at a 6-hourly cadence.
    'X-Generated-At': (object.customMetadata && object.customMetadata.generated) || '',
  });
}

export async function onRequest(context) {
  const { request, next, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(request.url);
  const source = (url.searchParams.get('source') || 'celestrak').toLowerCase();
  const group = (url.searchParams.get('group') || '').trim();

  if (!ALLOWED_GROUPS.has(group.toLowerCase())) {
    return text(400, 'Unknown or unsupported group.');
  }

  if (source === 'spacetrack') {
    return spacetrackBundle(env, group.toLowerCase());
  }
  if (source !== 'celestrak') {
    return text(400, 'Unknown source.');
  }

  // Serve from edge cache when warm.
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  // Live fetch from Celestrak (server-side, no CORS).
  let body = '';
  try {
    const upstream = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${encodeURIComponent(group)}&FORMAT=TLE`;
    const r = await fetch(upstream, {
      headers: { 'User-Agent': 'orbital-relay-tracker/1.0' },
      cf: { cacheTtl: CACHE_TTL, cacheEverything: true },
    });
    body = await r.text();
  } catch (_) {
    body = '';
  }

  // Fall back to the shipped baseline file if upstream throttled/empty.
  if (looksInvalid(body)) {
    try {
      const assetUrl = new URL(`/orbit/data/tle/celestrak/${group}.txt`, url.origin);
      const assetResp = await next(new Request(assetUrl));
      if (assetResp.ok) {
        const baseline = await assetResp.text();
        if (!looksInvalid(baseline)) return text(200, baseline, false);
      }
    } catch (_) { /* ignore */ }
    return text(502, 'Upstream returned no TLE data and no baseline available.');
  }

  const resp = text(200, body, true);
  context.waitUntil(cache.put(cacheKey, resp.clone()));
  return resp;
}
