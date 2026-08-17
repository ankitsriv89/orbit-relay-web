// Public feedback beacon — bug reports, suggestions, general feedback from
// the floating widget (public/shared/feedback.js). Not under /api/admin/ —
// no auth required to submit, same as /api/hit.
//
// Same low-PII pattern as hit.js: path + a bucketed ua_class, never the raw
// User-Agent. email is optional and user-typed, so — unlike hit.js's
// ip_hash — it is stored as-is; it is only ever surfaced to an authenticated
// admin (functions/api/admin/feedback.js), never in a public response.
//
// Write-per-submission is fine at this traffic level, same reasoning as
// hit.js. This shares the WRITE_PATHS rate-limit bucket in _ratelimit.js so a
// feedback spammer cannot also exhaust the read budget for real API callers.

import { CITATION, CITATION_HEADER } from './_orbit.js';

const UA_PATTERNS = [
  [/bot\b|crawl|spider|slurp|mediapartners|facebookexternalhit/i, 'bot'],
  [/\bmobile\b|\bandroid\b|\bip(hone|od|ad)\b/i, 'mobile'],
  [/\btablet\b|\bipad\b/i, 'tablet'],
];

function classifyUA(ua) {
  if (!ua) return 'unknown';
  for (const [re, cls] of UA_PATTERNS) {
    if (re.test(ua)) return cls;
  }
  return 'desktop';
}

const KINDS = new Set(['bug', 'suggestion', 'feedback']);
const MESSAGE_MAX = 2000;
const EMAIL_MAX = 254;

function json(body, status, extraHeaders = {}) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      [CITATION_HEADER]: CITATION,
      ...extraHeaders,
    },
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return json(null, 204);
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405);

  let body;
  try { body = await request.json(); } catch (_) {
    return json({ error: 'Request body must be valid JSON.' }, 400);
  }

  const kind = KINDS.has(body?.kind) ? body.kind : 'feedback';

  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!message) return json({ error: 'message is required' }, 400);
  if (message.length > MESSAGE_MAX) {
    return json({ error: `message too long (${MESSAGE_MAX} char cap)` }, 400);
  }

  let email = '';
  if (typeof body?.email === 'string' && body.email.trim()) {
    email = body.email.trim().slice(0, EMAIL_MAX);
  }

  const path = typeof body?.path === 'string' ? body.path.slice(0, 512) : '';
  const uaClass = classifyUA(request.headers.get('User-Agent'));

  const db = env.ORBIT_DB;
  if (!db) return json({ error: 'Database not bound.' }, 503);

  context.waitUntil(
    db.prepare(
      'INSERT INTO feedback (ts, kind, message, email, path, ua_class) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(Date.now(), kind, message, email || null, path, uaClass).run()
      .catch(() => {}),
  );

  return json({ ok: true }, 200);
}
