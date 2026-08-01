// Shared auth helpers for the /api/admin/* endpoints.
//
// The leading underscore keeps this out of Pages' file-based routing.
//
// Cookie format: v1.<b64url(payload)>.<b64url(hmac)>
// Payload: { sub, iat, exp } — 12h TTL.
// HMAC-SHA256 via crypto.subtle with key derived from ADMIN_SECRET.
//
// Do NOT reuse json() from _catalog.js — it hardcodes Access-Control-Allow-Origin: *,
// which is incompatible with credentialed requests. adminJson() has no CORS headers
// and Cache-Control: no-store. Same-origin only.

import { CITATION, CITATION_HEADER } from './_orbit.js';

const COOKIE_NAME = 'orbit_admin';
const TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// ── base64url helpers ──────────────────────────────────────────────────────

function b64uEncode(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64uDecode(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

// ── key derivation ─────────────────────────────────────────────────────────

const keyCache = new Map();

async function getKey(secret) {
  if (keyCache.has(secret)) return keyCache.get(secret);
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false,
    ['sign', 'verify'],
  );
  keyCache.set(secret, key);
  return key;
}

// ── token mint / verify ────────────────────────────────────────────────────

export async function mintToken(env, claims) {
  const key = await getKey(env.ADMIN_SECRET);
  const payload = b64uEncode(
    new TextEncoder().encode(JSON.stringify(claims)),
  );
  const sig = b64uEncode(
    await crypto.subtle.sign('HMAC', key, b64uDecode(payload)),
  );
  return `v1.${payload}.${sig}`;
}

export async function verifyToken(env, token) {
  if (!env?.ADMIN_SECRET || typeof token !== 'string') return null;
  const [v, p, s] = token.split('.');
  if (v !== 'v1' || !p || !s) return null;
  let bytes, sig;
  try { bytes = b64uDecode(p); sig = b64uDecode(s); } catch (_) { return null; }
  // crypto.subtle.verify IS the constant-time compare.
  if (!await crypto.subtle.verify('HMAC', await getKey(env.ADMIN_SECRET), sig, bytes)) return null;
  let claims;
  try { claims = JSON.parse(new TextDecoder().decode(bytes)); } catch (_) { return null; }
  // Expiry is checked ONLY after the signature verifies — an unsigned payload's exp
  // is attacker-controlled and must never influence control flow.
  if (typeof claims?.exp !== 'number' || claims.exp < Date.now()) return null;
  return claims;
}

// ── password compare (constant-time via HMAC) ─────────────────────────────

export async function comparePassword(env, candidate) {
  if (!env?.ADMIN_PASSWORD || typeof candidate !== 'string') return false;
  const key = await getKey(env.ADMIN_SECRET);
  const a = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(env.ADMIN_PASSWORD)));
  const b = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(candidate)));
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ── cookie helpers ─────────────────────────────────────────────────────────

export function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  const pair = header.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return pair ? pair.slice(name.length + 1) : null;
}

export function setCookie(value) {
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`;
}

export function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

// ── response helper (NO CORS — same-origin only) ───────────────────────────

export function adminJson(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      // Same licence condition as every other response: the admin pages surface
      // Space-Track-derived counts and must carry the citation.
      [CITATION_HEADER]: CITATION,
      ...extraHeaders,
    },
  });
}
