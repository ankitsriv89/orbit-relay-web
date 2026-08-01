import { verifyToken, readCookie, adminJson } from '../_admin.js';

const PUBLIC = new Set(['/api/admin/login', '/api/admin/logout']);

export async function onRequest(context) {
  const { request, env, next } = context;
  const { pathname } = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });

  // Misconfiguration is a 503, never an open door. This precedes the allowlist
  // deliberately: absent secrets must not degrade to "no auth required".
  if (!env.ADMIN_SECRET || !env.ADMIN_PASSWORD) {
    return adminJson({ error: 'Admin is not configured on this deployment.' }, 503);
  }
  if (PUBLIC.has(pathname)) return next();

  const claims = await verifyToken(env, readCookie(request, 'orbit_admin'));
  if (!claims) return adminJson({ error: 'Session expired or missing — log in again.' }, 401);
  context.data.admin = claims;
  return next();
}
