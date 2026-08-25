/**
 * SATCAT ingest — the daily job, delta-only.
 *
 * SATCAT carries what GP does not: the human-readable launch site, the launch
 * piece breakdown, RCS values, the comment codes, and — crucially — the DECAY
 * date for objects that have left orbit and therefore vanished from our
 * `decay_date/null-val` GP query without ever announcing themselves.
 *
 * **Delta by FILE number, not by date.** `FILE` is Space-Track's own upload
 * batch id and it only ever increases, so `FILE/>{lastFile}` is an exact
 * "everything since I last looked" cursor with no window to get wrong and no
 * clock skew to reason about. The high-water mark lives in KV.
 *
 * Documented rate is 1/day after 1700 UTC, which is why the cron sits at 17:20.
 */

import { Q, queryStream } from './spacetrack.js';
import { streamJsonRows } from './jsonstream.js';
import { recordEvents, BATCH_SIZE } from './derive.js';

const CURSOR_KEY = 'satcat:file';

/**
 * Without a cursor the query returns the whole catalogue including decayed
 * objects (~60k rows). That is the bootstrap case and it is allowed — it just
 * must not be mistaken for a delta, so change-diffing is skipped above this
 * size rather than emitting 60,000 "changed" events on first run.
 */
const DIFF_LIMIT = 2000;

const SATCAT_COLUMNS = [
  'NORAD_CAT_ID', 'OBJECT_NUMBER', 'INTLDES', 'OBJECT_ID', 'SATNAME',
  'OBJECT_NAME', 'OBJECT_TYPE', 'COUNTRY', 'LAUNCH', 'SITE', 'DECAY',
  'PERIOD', 'INCLINATION', 'APOGEE', 'PERIGEE', 'RCSVALUE', 'RCS_SIZE',
  'LAUNCH_YEAR', 'LAUNCH_NUM', 'LAUNCH_PIECE', 'CURRENT', 'COMMENT',
  'COMMENTCODE', 'FILE', 'updated_at',
];

const SATCAT_NUMERIC = new Set([
  'NORAD_CAT_ID', 'OBJECT_NUMBER', 'PERIOD', 'INCLINATION', 'APOGEE', 'PERIGEE',
  'RCSVALUE', 'LAUNCH_YEAR', 'LAUNCH_NUM', 'COMMENTCODE', 'FILE',
]);

const UPSERT_SQL = (() => {
  const cols = SATCAT_COLUMNS.join(', ');
  const holes = SATCAT_COLUMNS.map(() => '?').join(', ');
  const sets = SATCAT_COLUMNS.filter((c) => c !== 'NORAD_CAT_ID')
    .map((c) => `${c} = excluded.${c}`).join(', ');
  return `INSERT INTO satcat (${cols}) VALUES (${holes})
          ON CONFLICT(NORAD_CAT_ID) DO UPDATE SET ${sets}`;
})();

function toValues(row, now) {
  return SATCAT_COLUMNS.map((c) => {
    if (c === 'updated_at') return now;
    const v = row[c];
    if (v === undefined || v === null || v === '') return null;
    if (SATCAT_NUMERIC.has(c)) {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    return v;
  });
}

/** Fields whose change is worth a feed entry. The rest churn without meaning. */
const WATCHED = ['OBJECT_NAME', 'DECAY', 'CURRENT', 'COUNTRY', 'RCS_SIZE'];

/**
 * Columns compared to decide whether a row actually changed and is worth
 * writing. Everything in SATCAT_COLUMNS except the two that are metadata
 * about the write itself, not the record: `FILE` is Space-Track's upload
 * batch id (bumps even on a byte-identical re-send) and `updated_at` is our
 * own ingest timestamp — comparing either would make every row look changed
 * every run, defeating the point.
 */
const COMPARE_COLS = SATCAT_COLUMNS.filter((c) => c !== 'FILE' && c !== 'updated_at');

export async function ingestSatcat(env) {
  const now = new Date().toISOString();

  // Fall back to the table's own high-water mark if KV was cleared — the
  // cursor is a cache, not the source of truth, so losing it must degrade to a
  // slightly larger delta rather than to a full re-download.
  let cursor = await env.ORBIT_KV.get(CURSOR_KEY);
  if (cursor == null) {
    const row = await env.ORBIT_DB.prepare('SELECT MAX(FILE) AS f FROM satcat').first();
    cursor = row && row.f != null ? String(row.f) : '0';
  }

  const { resp, finish } = await queryStream(env, 'satcat', Q.satcatFrom(cursor));

  let rows = 0;
  let maxFile = Number(cursor) || 0;
  let batch = [];
  const events = [];
  const decayed = [];
  let written = 0;

  const flush = async () => {
    if (!batch.length) return;
    // Diff before the upsert overwrites what we are comparing against. Below
    // DIFF_LIMIT this also decides what actually needs writing — a delta pull
    // routinely re-sends rows SATCAT has not touched since our last run, and
    // writing those unconditionally was pure waste (the same issue fixed for
    // the GP/objects upsert — see CLAUDE.md's D1 usage note).
    let toWrite = batch;
    if (rows <= DIFF_LIMIT) {
      const previous = await previousRows(env, batch.map((r) => Number(r.NORAD_CAT_ID)));
      toWrite = [];
      for (const r of batch) {
        const prev = previous.get(Number(r.NORAD_CAT_ID));
        if (!prev) { toWrite.push(r); continue; }   // brand new to SATCAT
        const changed = COMPARE_COLS.filter((f) => fieldChanged(f, prev[f], r[f]));
        if (!changed.length) continue;              // identical to what's stored — skip
        toWrite.push(r);
        const changes = changed
          .filter((f) => WATCHED.includes(f))
          .map((f) => ({ field: f, from: prev[f] ?? null, to: r[f] ?? null }));
        if (changes.length) {
          events.push({
            ts: now,
            kind: 'satcat_change',
            norad: Number(r.NORAD_CAT_ID),
            title: `${r.OBJECT_NAME || r.SATNAME || 'Object'} — catalog record updated`,
            detail: { changes },
          });
        }
      }
    }
    if (toWrite.length) {
      await env.ORBIT_DB.batch(
        toWrite.map((r) => env.ORBIT_DB.prepare(UPSERT_SQL).bind(...toValues(r, now))));
      written += toWrite.length;
    }
    batch = [];
  };

  for await (const r of streamJsonRows(resp.body)) {
    if (!r || r.NORAD_CAT_ID == null) continue;
    rows++;
    const f = Number(r.FILE);
    if (Number.isFinite(f) && f > maxFile) maxFile = f;
    if (r.DECAY) decayed.push([r.DECAY, Number(r.NORAD_CAT_ID)]);
    batch.push(r);
    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();
  await finish(rows);

  // SATCAT is where a decay becomes visible to us for objects that simply stop
  // appearing in the GP query (which filters decay_date/null-val). Without this
  // write they would sit in `objects` forever with a NULL DECAY_DATE and keep
  // being served in the group bundles as if still on orbit.
  const marked = await markDecayed(env, decayed);

  await recordEvents(env.ORBIT_DB, events);
  if (maxFile > Number(cursor)) await env.ORBIT_KV.put(CURSOR_KEY, String(maxFile));

  return { rows, written, cursor: maxFile, changes: events.length, marked };
}

/**
 * Compares a stored value (typed — REAL/INTEGER read back from D1) against
 * the raw upstream value (always a string) for the given column. Numeric
 * columns must be compared as numbers: D1 stores 65.10 as 65.1, so a raw
 * String() comparison against the upstream "65.10" would call every row with
 * a trailing-zero decimal "changed" on every run, forever.
 */
function fieldChanged(col, stored, incoming) {
  if (SATCAT_NUMERIC.has(col)) {
    const a = stored === null || stored === undefined ? null : Number(stored);
    const b = incoming === null || incoming === undefined || incoming === '' ? null : Number(incoming);
    return a !== b;
  }
  return norm(stored) !== norm(incoming);
}

function norm(v) {
  return v === undefined || v === null || v === '' ? null : String(v);
}

async function previousRows(env, ids) {
  if (!ids.length) return new Map();
  // Batch size is 40, comfortably inside D1's 100-bound-parameter cap.
  const holes = ids.map(() => '?').join(',');
  const { results } = await env.ORBIT_DB
    .prepare(`SELECT ${COMPARE_COLS.join(', ')}, NORAD_CAT_ID FROM satcat
              WHERE NORAD_CAT_ID IN (${holes})`)
    .bind(...ids)
    .all();
  return new Map((results || []).map((r) => [Number(r.NORAD_CAT_ID), r]));
}

async function markDecayed(env, pairs) {
  if (!pairs.length) return 0;
  const sql = `UPDATE objects SET DECAY_DATE = ?
               WHERE NORAD_CAT_ID = ? AND DECAY_DATE IS NULL`;
  let n = 0;
  for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
    const slice = pairs.slice(i, i + BATCH_SIZE);
    await env.ORBIT_DB.batch(slice.map((p) => env.ORBIT_DB.prepare(sql).bind(...p)));
    n += slice.length;
  }
  return n;
}
