// Cloudflare Pages Function — Mars Sim telemetry ingest (plan 24).
//
//   POST /api/telemetry   body: { events: [{ name, ts?, props? }, ...],
//                                  anon_id, session_id, app_version, platform }
//
// Anonymous, consent-gated product analytics for the Mars Sim game (web +
// bundled Android WebView). Writes each event to the D1 `events` table. The
// server — not the client — stamps receive time and derives coarse country
// from `request.cf.country` (no GPS, no device/advertising id ever). Public
// ingest (no auth), hardened only by size/count caps + an event-name allowlist.
//
// Inert-until-configured (same spirit as cloudsync.js): if the TELEMETRY_DB
// binding is absent, it 204s and drops the batch instead of erroring, so the
// site keeps working before D1 is provisioned. See d1/telemetry.sql for setup.

const ALLOWED_EVENTS = new Set([
  'app_open', 'session_start', 'session_end',
  'site_enter', 'mission_complete', 'sample_collected',
  'js_error', 'context_lost',
]);

const MAX_BODY_BYTES = 32 * 1024; // reject oversized payloads outright
const MAX_EVENTS = 50;            // per batch
const MAX_PROPS_CHARS = 2048;     // per-event props JSON cap

const CORS = {
  // Public anonymous ingest, no cookies/credentials — `*` is fine and covers
  // the Pages origin plus the Capacitor WebView (https://localhost).
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const noContent = () => new Response(null, { status: 204, headers: CORS });

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  // Size guard before we read/parse anything.
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY_BYTES) return noContent();

  let body;
  try {
    body = await request.json();
  } catch {
    return noContent(); // malformed — drop silently, never 500 a beacon
  }

  const events = Array.isArray(body?.events) ? body.events.slice(0, MAX_EVENTS) : [];
  if (!events.length) return noContent();

  // Binding not provisioned yet → accept-and-drop so the client never errors.
  const db = env.TELEMETRY_DB;
  if (!db) return noContent();

  const ts = Date.now();
  const country = request.cf?.country ?? null;
  const anonId = str(body.anon_id, 64);
  const sessionId = str(body.session_id, 64);
  const appVersion = str(body.app_version, 32);
  const platform = str(body.platform, 16);

  const stmts = [];
  for (const e of events) {
    const name = str(e?.name, 40);
    if (!name || !ALLOWED_EVENTS.has(name)) continue; // drop unknown events
    let props = null;
    if (e && e.props != null) {
      try { props = JSON.stringify(e.props).slice(0, MAX_PROPS_CHARS); } catch { props = null; }
    }
    stmts.push(
      db.prepare(
        `INSERT INTO events (id, ts, anon_id, session_id, app_version, platform, country, name, props)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(crypto.randomUUID(), ts, anonId, sessionId, appVersion, platform, country, name, props)
    );
  }

  if (stmts.length) {
    try { await db.batch(stmts); } catch { /* best-effort ingest — never surface to the client */ }
  }
  return noContent();
}

/** Coerce to a bounded string or null (defends the DB from junk/oversized fields). */
function str(v, max) {
  if (typeof v !== 'string' || !v) return null;
  return v.length > max ? v.slice(0, max) : v;
}
