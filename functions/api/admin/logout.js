import { clearCookie, adminJson } from '../_admin.js';

export async function onRequestPost(context) {
  return adminJson({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
}
