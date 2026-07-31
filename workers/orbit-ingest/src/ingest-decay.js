/**
 * Decay and reentry ingest.
 *
 * Two feeds land in the same table, told apart by SOURCE:
 *   - the **daily** current-messages pull (`MSG_EPOCH/>now-1`), 1/day; and
 *   - the **weekly** 60-day prediction pull (`source/60day_msg`), documented as
 *     1/week on Wednesdays after 1700 UTC, which is why the third cron is
 *     `25 17 * * 3`.
 *
 * Both are small — tens of rows — so they use the buffering `query()` rather
 * than the streaming path.
 *
 * DECAY_EPOCH is a varchar upstream, not a datetime. It is stored as text and
 * parsed at read time; assuming ISO-8601 here would quietly produce Invalid
 * Date on the reentry countdown.
 */

import { Q, query } from './spacetrack.js';
import { recordEvents, BATCH_SIZE } from './derive.js';

const DECAY_COLUMNS = [
  'NORAD_CAT_ID', 'OBJECT_NUMBER', 'OBJECT_NAME', 'INTLDES', 'OBJECT_ID',
  'RCS', 'RCS_SIZE', 'COUNTRY', 'MSG_EPOCH', 'DECAY_EPOCH', 'SOURCE',
  'MSG_TYPE', 'PRECEDENCE', 'updated_at',
];

const DECAY_NUMERIC = new Set(['NORAD_CAT_ID', 'OBJECT_NUMBER', 'RCS', 'PRECEDENCE']);

// Keyed on (NORAD_CAT_ID, MSG_EPOCH): a re-run of the same day's pull updates
// in place instead of duplicating, which is what makes the job safely
// retryable after a partial failure.
const UPSERT_SQL = (() => {
  const cols = DECAY_COLUMNS.join(', ');
  const holes = DECAY_COLUMNS.map(() => '?').join(', ');
  const sets = DECAY_COLUMNS
    .filter((c) => c !== 'NORAD_CAT_ID' && c !== 'MSG_EPOCH')
    .map((c) => `${c} = excluded.${c}`).join(', ');
  return `INSERT INTO decay (${cols}) VALUES (${holes})
          ON CONFLICT(NORAD_CAT_ID, MSG_EPOCH) DO UPDATE SET ${sets}`;
})();

function toValues(row, now) {
  return DECAY_COLUMNS.map((c) => {
    if (c === 'updated_at') return now;
    const v = row[c];
    if (v === undefined || v === null || v === '') return null;
    if (DECAY_NUMERIC.has(c)) {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    return v;
  });
}

const PREDICTION_SOURCE = '60day_msg';

/**
 * @param {object} env
 * @param {'daily'|'60day'} kind
 */
export async function ingestDecay(env, kind = 'daily') {
  const now = new Date().toISOString();
  const prediction = kind === '60day';
  const rows = await query(env, 'decay', prediction ? Q.decay60Day() : Q.decayDaily());
  if (!rows.length) return { rows: 0, events: 0, marked: 0 };

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const slice = rows.slice(i, i + BATCH_SIZE);
    await env.ORBIT_DB.batch(
      slice.map((r) => env.ORBIT_DB.prepare(UPSERT_SQL).bind(...toValues(r, now))));
  }

  // Only messages we have not already turned into an event produce one. The
  // UNIQUE(kind, NORAD, ts) constraint would dedupe a same-second replay, but
  // the daily window overlaps by design, so filter on the message's own epoch
  // rather than relying on the constraint to absorb yesterday's rows.
  const seen = await alreadyReported(env, rows.map((r) => Number(r.NORAD_CAT_ID)),
                                     prediction ? 'reentry_predicted' : 'decay');

  const events = rows
    .filter((r) => !seen.has(`${Number(r.NORAD_CAT_ID)}|${r.MSG_EPOCH}`))
    .map((r) => ({
      ts: now,
      kind: prediction ? 'reentry_predicted' : 'decay',
      norad: Number(r.NORAD_CAT_ID),
      title: prediction
        ? `${r.OBJECT_NAME || 'Object'} — reentry predicted ${r.DECAY_EPOCH || ''}`.trim()
        : `${r.OBJECT_NAME || 'Object'} decayed`,
      detail: {
        object_id: r.OBJECT_ID,
        country: r.COUNTRY,
        rcs_size: r.RCS_SIZE,
        msg_epoch: r.MSG_EPOCH,
        decay_epoch: r.DECAY_EPOCH,
        msg_type: r.MSG_TYPE,
        source: r.SOURCE,
      },
    }));

  await recordEvents(env.ORBIT_DB, events);

  // A prediction is not a decay: only the actual-decay feed writes DECAY_DATE
  // back onto the object, which is what removes it from the group bundles.
  const marked = prediction ? 0 : await markDecayed(env, rows);

  return { rows: rows.length, events: events.length, marked };
}

/**
 * Which (NORAD, MSG_EPOCH) pairs we have already announced. The detail blob is
 * JSON text, so this is a LIKE probe rather than a join — cheap at the tens of
 * rows these feeds carry, and it avoids a second table just to remember.
 */
async function alreadyReported(env, ids, kind) {
  const out = new Set();
  if (!ids.length) return out;
  const { results } = await env.ORBIT_DB
    .prepare(`SELECT NORAD_CAT_ID, detail FROM events
              WHERE kind = ? ORDER BY id DESC LIMIT 1000`)
    .bind(kind)
    .all();
  for (const r of results || []) {
    try {
      const d = JSON.parse(r.detail || '{}');
      if (d.msg_epoch) out.add(`${Number(r.NORAD_CAT_ID)}|${d.msg_epoch}`);
    } catch (_) { /* a malformed blob just means we may re-announce once */ }
  }
  return out;
}

async function markDecayed(env, rows) {
  const pairs = rows
    .filter((r) => r.SOURCE !== PREDICTION_SOURCE && r.DECAY_EPOCH)
    .map((r) => [String(r.DECAY_EPOCH).slice(0, 10), Number(r.NORAD_CAT_ID)]);
  if (!pairs.length) return 0;

  const sql = `UPDATE objects SET DECAY_DATE = ?
               WHERE NORAD_CAT_ID = ? AND DECAY_DATE IS NULL`;
  for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
    const slice = pairs.slice(i, i + BATCH_SIZE);
    await env.ORBIT_DB.batch(slice.map((p) => env.ORBIT_DB.prepare(sql).bind(...p)));
  }
  return pairs.length;
}
