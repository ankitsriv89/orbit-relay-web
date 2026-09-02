// Shared helpers for the object-profile endpoints.
//
// The leading underscore keeps this out of Pages' file-based routing.
//
// The profile knowledge base lives in a SECOND D1 (`orbit-profiles`, bound
// PROFILE_DB) because D1 cannot join across databases — see d1/profiles.sql.
// Composition therefore happens here, in the API layer: `/api/object/<norad>`
// adds a `profile` key alongside its existing catalog reads.
//
// Two callers, opposite needs:
//
//   - `/api/object/<norad>` has a complete, useful answer WITHOUT a profile, so
//     a profile failure must be invisible to it. profileFor() never throws and
//     never propagates a D1 error — PROFILE_DB unbound or the row missing both
//     return null, and the dossier behaves exactly as it did before profiles
//     existed. Never a 500.
//
//   - `/api/profile/<norad>` IS the profile, so it 503s honestly via
//     requireProfileDb() when it cannot serve one.

import { json } from './_catalog.js';

/**
 * 503 when PROFILE_DB is unbound — for the endpoint that REQUIRES a profile.
 * @returns {Response|null}
 */
export function requireProfileDb(env) {
  if (!env || !env.PROFILE_DB) {
    return json({ error: 'Object profiles are not configured on this deployment.' },
                { status: 503 });
  }
  return null;
}

const PROFILE_SQL = 'SELECT * FROM profiles WHERE norad = ?';
const FIELDS_SQL = `
  SELECT field, source_id, source_url, confidence
  FROM profile_fields WHERE norad = ? ORDER BY field`;
const IMAGES_SQL = `
  SELECT r2_key, thumb_key, credit, license, source_url, is_primary
  FROM images WHERE norad = ? ORDER BY is_primary DESC, r2_key`;

/**
 * The composable read. Never throws, never 500s.
 * @returns {Promise<{profile: object, fields: object[], images: object[]}|null>}
 *   null when PROFILE_DB is unbound OR the profiles row is missing OR the read
 *   errors — the caller cannot tell those apart, and does not need to.
 */
export async function profileFor(env, norad) {
  if (!env || !env.PROFILE_DB) return null;
  try {
    const profile = await env.PROFILE_DB.prepare(PROFILE_SQL).bind(norad).first();
    if (!profile) return null;
    const [fields, images] = await Promise.all([
      env.PROFILE_DB.prepare(FIELDS_SQL).bind(norad).all(),
      env.PROFILE_DB.prepare(IMAGES_SQL).bind(norad).all(),
    ]);
    return {
      profile,
      fields: fields.results || [],
      images: (images.results || []).map((im) => ({ ...im, is_primary: !!im.is_primary })),
    };
  } catch (_err) {
    // A profile failure must be invisible to the dossier. The one endpoint that
    // needs to know uses requireProfileDb() up front, not this.
    return null;
  }
}
