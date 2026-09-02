/**
 * Facts with provenance — writes `profiles` + `profile_fields`.
 *
 * resolveConflicts() is pure: two sources disagreeing on a field is expected,
 * higher sources.priority wins, ties break on source_id ascending so a re-run
 * cannot reorder the output, and the losers are returned as data rather than
 * logged here — the caller decides what to do with them.
 *
 * writeFacts() is the enforcement point: assertAllowed() runs on EVERY fact
 * before any write, so a fact from a non-allowlisted source aborts the whole
 * write loudly. The composite PK (norad, field) from d1/profiles.sql makes a
 * re-run replace provenance instead of appending a second row.
 */
import { SOURCES, assertAllowed } from './sources.js';

/** @typedef {{value: any, source_id: string, source_url: string, confidence: number}} Fact */

/** Priority for a source_id; an unknown id sorts last (writeFacts rejects it anyway). */
const priorityOf = (id) => (SOURCES[id] ? SOURCES[id].priority : 0);

/** Higher priority first; then source_id ascending for a stable, re-runnable order. */
function byPreference(a, b) {
  return priorityOf(b.source_id) - priorityOf(a.source_id)
    || (a.source_id < b.source_id ? -1 : a.source_id > b.source_id ? 1 : 0);
}

/**
 * @param {Record<string, Fact[]>} candidatesByField
 * @returns {{fields: Record<string, Fact>, conflicts: Array<{field, kept, dropped}>}}
 */
export function resolveConflicts(candidatesByField) {
  const fields = {};
  const conflicts = [];

  for (const [field, candidates] of Object.entries(candidatesByField || {})) {
    const ranked = [...(candidates || [])].sort(byPreference);
    if (!ranked.length) continue;
    fields[field] = ranked[0];
    if (ranked.length > 1) {
      conflicts.push({ field, kept: ranked[0], dropped: ranked.slice(1) });
    }
  }

  return { fields, conflicts };
}

const PROFILE_UPSERT = (cols) => `
  INSERT INTO profiles (norad, ${cols.join(', ')}, updated_at)
  VALUES (?, ${cols.map(() => '?').join(', ')}, ?)
  ON CONFLICT(norad) DO UPDATE SET
    ${cols.map((c) => `${c} = excluded.${c}`).join(',\n    ')},
    updated_at = excluded.updated_at
`;

const FIELD_UPSERT = `
  INSERT INTO profile_fields (norad, field, source_id, source_url, confidence, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(norad, field) DO UPDATE SET
    source_id = excluded.source_id,
    source_url = excluded.source_url,
    confidence = excluded.confidence,
    updated_at = excluded.updated_at
`;

/**
 * Writes one `profiles` row + one `profile_fields` row per populated field.
 * assertAllowed() is called on every fact FIRST — a rejected source aborts
 * before any statement runs.
 * @param {object} db
 * @param {number} norad
 * @param {{fields: Record<string, Fact>}} resolved
 * @param {object} spine  the profiles column set (cospar, official_name, …, status)
 * @returns {Promise<{profiles: number, fields: number}>}
 */
export async function writeFacts(db, norad, resolved, spine) {
  const entries = Object.entries(resolved.fields || {});
  for (const [, fact] of entries) assertAllowed(fact.source_id);

  const now = new Date().toISOString();
  const cols = Object.keys(spine);
  const statements = [
    db.prepare(PROFILE_UPSERT(cols)).bind(norad, ...cols.map((c) => spine[c] ?? null), now),
  ];
  for (const [field, fact] of entries) {
    statements.push(
      db.prepare(FIELD_UPSERT).bind(norad, field, fact.source_id, fact.source_url ?? null,
        fact.confidence ?? null, now),
    );
  }

  await db.batch(statements);
  return { profiles: 1, fields: entries.length };
}
