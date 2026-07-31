// Cloudflare Pages Function — the signal feed for /spacetrack/ (plan 33 wave 4).
//
//   GET /api/feed?limit=100
//
// Space-Track has no "what changed" endpoint, so every event here was DERIVED
// by the ingest Worker diffing a run against what D1 already held: new
// catalog entries (`new_object`), decays, reentry predictions
// (`reentry_predicted`) and catalog record changes (`satcat_change`). See
// `workers/orbit-ingest/src/derive.js` (`recordEvents`) for how a row lands.
//
// Reads the R2 artifact (`feed/latest.json`, regenerated after every ingest)
// first — a flat object GET, same discipline as summary.js — and falls back
// to querying `events` directly in D1 when the artifact is missing or corrupt.

import { json, preflight, requireDb, withCitation } from './_catalog.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return preflight();

  const url = new URL(request.url);
  const limit = clamp(Number.parseInt(url.searchParams.get('limit'), 10) || DEFAULT_LIMIT,
                       1, MAX_LIMIT);

  if (env && env.ORBIT_R2) {
    const object = await env.ORBIT_R2.get('feed/latest.json');
    if (object) {
      try {
        const artifact = JSON.parse(await object.text());
        return json({ ...artifact, events: (artifact.events || []).slice(0, limit), stale: false },
                    { maxAge: 300 });
      } catch (_) {
        // A corrupt artifact must not take the feed down — fall through to D1.
      }
    }
  }

  const unbound = requireDb(env);
  if (unbound) return unbound;

  const { results } = await env.ORBIT_DB
    .prepare(`SELECT ts, kind, NORAD_CAT_ID, title, detail
              FROM events ORDER BY ts DESC, id DESC LIMIT ?`)
    .bind(limit)
    .all();

  return json(withCitation({
    generated_at: new Date().toISOString(),
    events: (results || []).map((r) => ({
      ts: r.ts,
      kind: r.kind,
      norad: r.NORAD_CAT_ID,
      title: r.title,
      detail: safeParse(r.detail),
    })),
    stale: true,
    note: 'Feed artifact not built yet — read live from D1.',
  }), { maxAge: 60 });
}

function safeParse(s) {
  if (s == null) return null;
  try { return JSON.parse(s); } catch (_) { return s; }
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
