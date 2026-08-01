import { comparePassword, mintToken, setCookie, adminJson } from '../_admin.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.ADMIN_SECRET || !env.ADMIN_PASSWORD) {
    return adminJson({ error: 'Admin is not configured on this deployment.' }, 503);
  }

  let body;
  try { body = await request.json(); } catch (_) {
    return adminJson({ error: 'Request body must be valid JSON.' }, 400);
  }

  if (!body?.password || typeof body.password !== 'string') {
    return adminJson({ error: 'Password is required.' }, 400);
  }

  const valid = await comparePassword(env, body.password);
  if (!valid) return adminJson({ error: 'Incorrect password.' }, 401);

  const now = Date.now();
  const token = await mintToken(env, { sub: 'admin', iat: now, exp: now + 12 * 60 * 60 * 1000 });

  // adminJson so the success path carries the citation header like every
  // other API response; the Set-Cookie rides along via extraHeaders.
  return adminJson({ ok: true }, 200, { 'Set-Cookie': setCookie(token) });
}
