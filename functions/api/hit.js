// Public pageview beacon. Not under /api/admin/ — no auth required.
//
// Records: ts, path, referrer (origin only — never the full third-party URL),
// country (request.cf.country), ip_hash, ua_class (bucketed mobile|tablet|desktop|bot,
// never the raw UA).
//
// IP hashing — daily-rotating salt, derived not stored:
// SHA-256(dayStamp | ip | ADMIN_SECRET) truncated to 8 bytes. Daily rotation supports
// "uniques today" while being deliberately not correlatable across days.
//
// Write-per-pageview is fine at this traffic level (D1 free tier: 100k writes/day).
// Batching would need a Durable Object or Queue, neither bound to this Pages project.
// Mitigation when hitting the ceiling: Math.random() < 1/N sampling.
// ctx.waitUntil() the insert and return 204 immediately.

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

export async function onRequest(context) {
  const { request, env, waitUntil } = context;
  if (request.method !== 'POST') return new Response(null, { status: 405 });

  let body;
  try { body = await request.json(); } catch (_) {
    return new Response(null, { status: 400 });
  }

  const ua = classifyUA(request.headers.get('User-Agent'));
  if (ua === 'bot') return new Response(null, { status: 204 });

  const db = env.ORBIT_DB;
  if (!db) return new Response(null, { status: 204 });

  const path = body.path || '/';
  const referrer = body.ref || '';
  const country = request.cf?.country || '';
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const dayStamp = new Date().toISOString().slice(0, 10);

  const salt = env.ADMIN_SECRET || 'default-salt';
  const enc = new TextEncoder();
  const hashBuf = await crypto.subtle.digest(
    'SHA-256',
    enc.encode(`${dayStamp}|${ip}|${salt}`),
  );
  const ipHash = Array.from(new Uint8Array(hashBuf).slice(0, 8))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  waitUntil(
    db.prepare(
      'INSERT INTO page_views (ts, path, referrer, country, ip_hash, ua_class) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(Date.now(), path, referrer, country, ipHash, ua).run()
      .catch(() => {}),
  );

  return new Response(null, { status: 204 });
}
