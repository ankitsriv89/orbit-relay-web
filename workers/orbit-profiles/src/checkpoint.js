/**
 * Resumability — the last NORAD that completed each pipeline stage.
 *
 * A 28k-object pass runs for tens of minutes as an Actions job. A run that dies
 * at object 14,000 restarts at 14,000 rather than re-doing the work, and for
 * Tier 3 that also means not re-spending the model budget.
 *
 * The write must be durable before the work it covers is acknowledged — the
 * caller (src/index.js) checkpoints AFTER a chunk's D1 writes have returned, so
 * a crash between the two re-does that chunk (idempotent upserts) rather than
 * skipping it.
 *
 * Backed by the `ingest_checkpoints` table from d1/profiles.sql:
 *   stage TEXT PRIMARY KEY, last_norad INTEGER, updated_at TEXT
 */

export const STAGES = ['match', 'facts', 'prose', 'images'];

/** @returns {Promise<number>} last completed NORAD for `stage`, or 0 */
export async function readCheckpoint(db, stage) {
  const row = await db
    .prepare('SELECT last_norad FROM ingest_checkpoints WHERE stage = ?')
    .bind(stage)
    .first();
  const n = row && Number(row.last_norad);
  return Number.isFinite(n) ? n : 0;
}

/** @returns {Promise<void>} */
export async function writeCheckpoint(db, stage, norad) {
  await db.prepare(`
    INSERT INTO ingest_checkpoints (stage, last_norad, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(stage) DO UPDATE SET
      last_norad = excluded.last_norad,
      updated_at = excluded.updated_at
  `).bind(stage, norad, new Date().toISOString()).run();
}
