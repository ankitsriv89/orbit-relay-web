// Cloudflare Pages Function — one object's profile, on its own.
//
//   GET /api/profile/25544
//
// This is what the /spacetrack/ inline panel (Task 10) loads. Unlike the
// `profile` key on /api/object/<norad>, this endpoint IS the profile, so it
// 503s honestly when PROFILE_DB is unbound and 404s when the row is absent —
// see functions/api/_profiles.js for why the two callers need opposite
// behaviours.

import { json, preflight, cached } from '../_catalog.js';
import { requireProfileDb, profileFor } from '../_profiles.js';

// Profiles change on a bulk-import cadence, not the 6-hourly GP one, so this
// holds far longer than the dossier's 300s. An hour is still short enough that
// a re-run's corrections show up the same day.
const MAX_AGE = 3600;

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return preflight();
  return cached(context, () => handle(context));
}

async function handle(context) {
  const { env, params } = context;

  const unbound = requireProfileDb(env);
  if (unbound) return unbound;

  // The whole segment must be digits — same reasoning as object/[norad].js:
  // Number.parseInt alone accepts "25544; DROP TABLE …" and would answer 200.
  const raw = String(params.norad || '');
  if (!/^\d+$/.test(raw)) {
    return json({ error: 'norad must be a positive integer' }, { status: 400 });
  }
  const norad = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(norad) || norad <= 0) {
    return json({ error: 'norad must be a positive integer' }, { status: 400 });
  }

  const found = await profileFor(env, norad);
  if (!found) {
    return json({ error: `No profile for NORAD ${norad}.` }, { status: 404 });
  }

  return json({
    profile: found.profile,
    fields: found.fields,
    images: found.images,
    operator_derived: true,
  }, { maxAge: MAX_AGE });
}
