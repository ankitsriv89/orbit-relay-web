/**
 * BOXSCORE ingest — per-country tallies, once a day after 1700 UTC.
 *
 * 122 rows and no delta cursor: the whole table is replaced each run. That is
 * the right shape here because boxscore rows have no identity beyond
 * (COUNTRY, SPADOC_CD) and a country dropping out of the report should drop out
 * of ours — an upsert-only strategy would leave a stale row behind forever.
 *
 * The delete and the reload go in ONE batch. D1 runs a batch as a transaction,
 * so a failure mid-reload rolls back rather than leaving the table empty and
 * the stats panel blank until tomorrow.
 */

import { Q, query } from './spacetrack.js';

const COLUMNS = [
  'COUNTRY', 'SPADOC_CD', 'ORBITAL_TBA', 'ORBITAL_PAYLOAD_COUNT',
  'ORBITAL_ROCKET_BODY_COUNT', 'ORBITAL_DEBRIS_COUNT', 'ORBITAL_TOTAL_COUNT',
  'DECAYED_PAYLOAD_COUNT', 'DECAYED_ROCKET_BODY_COUNT', 'DECAYED_DEBRIS_COUNT',
  'DECAYED_TOTAL_COUNT', 'COUNTRY_TOTAL', 'updated_at',
];

const TEXT = new Set(['COUNTRY', 'SPADOC_CD', 'updated_at']);

const INSERT_SQL =
  `INSERT INTO boxscore (${COLUMNS.join(', ')})
   VALUES (${COLUMNS.map(() => '?').join(', ')})
   ON CONFLICT(COUNTRY, SPADOC_CD) DO UPDATE SET ${
     COLUMNS.filter((c) => c !== 'COUNTRY' && c !== 'SPADOC_CD')
       .map((c) => `${c} = excluded.${c}`).join(', ')}`;

function toValues(row, now) {
  return COLUMNS.map((c) => {
    if (c === 'updated_at') return now;
    const v = row[c];
    if (v === undefined || v === null || v === '') return TEXT.has(c) ? null : 0;
    if (TEXT.has(c)) return String(v);
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  });
}

export async function ingestBoxscore(env) {
  const now = new Date().toISOString();
  const rows = await query(env, 'boxscore', Q.boxscore());

  // An empty response replaces nothing. Wiping the table on a bad upstream day
  // would turn a transient error into a visibly broken stats panel.
  if (!rows.length) return { rows: 0 };

  const stmts = [env.ORBIT_DB.prepare('DELETE FROM boxscore')];
  for (const r of rows) {
    stmts.push(env.ORBIT_DB.prepare(INSERT_SQL).bind(...toValues(r, now)));
  }
  await env.ORBIT_DB.batch(stmts);

  return { rows: rows.length };
}
