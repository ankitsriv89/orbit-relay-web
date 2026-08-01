import { comparePassword, mintToken, setCookie, adminJson } from '../_admin.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.ADMIN_SECRET || !env.ADMIN_PASSWORD) {
    return adminJson({ error: 'Admin is not configured on this deployment.' }, 503);
  }

  let body;
  try { body = await request.json(); } catch (_) {
    return adminJson({ error: 'invalid JSON body' }, 400);
  }

  if (!body?.password || typeof body.password !== 'string') {
    return adminJson({ error: 'password required' }, 400);
  }

  const valid = await comparePassword(env, body.password);
  if (!valid) return adminJson({ error: 'invalid password' }, 401);

  const now = Date.now();
  const token = await mintToken(env, { sub: 'admin', iat: now, exp: now + 12 * 60 * 60 * 1000 });

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': setCookie(token),
      'Cache-Control': 'no-store',
    },
  });
}
