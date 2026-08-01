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
