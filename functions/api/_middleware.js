// Rate limiting for the whole public /api/* surface.
//
// Pages chains middleware parent-to-child: this runs for every /api/* request,
// and /api/admin/* then ALSO runs functions/api/admin/_middleware.js. This one
// must therefore stay purely about cost — authentication is that file's job,
// and adding auth concerns here would give the admin routes two opinions about
// who may call them.
//
// Ordering matters the other way too: an admin login attempt passes through
// here first, so a brute-force attempt against the password endpoint meets the
// rate limit before it reaches the password check.
//
// See _ratelimit.js for the measured cost this defends, and why it fails open.

import { checkLimit } from './_ratelimit.js';

export async function onRequest(context) {
  const { request, env, next } = context;

  // Preflights are free and must never be limited — a blocked OPTIONS breaks
  // CORS for a caller who has not yet made a real request.
  if (request.method === 'OPTIONS') return next();

  const limited = await checkLimit(env, request);
  if (limited) return limited;

  return next();
}
