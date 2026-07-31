/**
 * GP (OMM) ingest — the 6-hourly job that keeps the elsets current.
 *
 * One upstream call. The response is streamed and upserted in fixed-size
 * batches, so peak memory is one batch (40 rows) rather than the whole delta:
 * a 6.7-hour window returns most of the ~28k active catalog because 18 SPCS
 * regenerates elsets continuously, and buffering that would exceed a Worker's
 * memory limit. See jsonstream.js.
 *
 * The window MUST match the cron. `now-0.042` is the docs' 1-hour example; on a
 * 6-hour schedule it would silently drop five hours of elsets every run, and
 * the failure would be invisible in the data. Q.gpDelta() uses now-0.28.
 */

import { Q, queryStream } from './spacetrack.js';
import { streamJsonRows } from './jsonstream.js';
import {
  GP_PREDICATES, deriveObjectRow, upsertObjects, recordEvents, BATCH_SIZE,
} from './derive.js';

/**
 * Circuit breaker. A normal delta is a few thousand to ~28k rows. Anything past
 * this means the query lost its window predicate and we are pulling history —
 * stop rather than spend the invocation and hammer D1.
 */
const MAX_ROWS = 40000;

/**
 * @param {object} env
 * @param {object} [opts]
 * @param {boolean} [opts.full]  use the 10-day full-catalog query instead of the
 *                               delta. Only for a manual reseed — the normal
 *                               seed path is scripts/bootstrap.mjs, which runs
 *                               outside the Worker CPU limit.
 * @returns {Promise<{rows:number, written:number, newObjects:number}>}
 */
export async function ingestGP(env, { full = false } = {}) {
  const now = new Date().toISOString();
  const path = full ? Q.gpFull(GP_PREDICATES) : Q.gpDelta(GP_PREDICATES);

  const { resp, finish } = await queryStream(env, 'gp', path);

  let rows = 0;
  let written = 0;
  let batch = [];

  for await (const gp of streamJsonRows(resp.body)) {
    if (!gp || gp.NORAD_CAT_ID == null) continue;
    rows++;
    if (rows > MAX_ROWS) {
      throw new Error(
        `GP ingest aborted at ${MAX_ROWS} rows — the delta window is missing ` +
        `or upstream returned history. Path: ${path}`);
    }
    batch.push(deriveObjectRow(gp, now));
    if (batch.length >= BATCH_SIZE) {
      written += await upsertObjects(env.ORBIT_DB, batch);
      batch = [];
    }
  }
  if (batch.length) written += await upsertObjects(env.ORBIT_DB, batch);

  await finish(rows);

  const newObjects = await recordNewObjects(env, now);
  return { rows, written, newObjects };
}

/**
 * Objects catalogued since our last run.
 *
 * `first_seen` is set on INSERT and deliberately left out of the upsert's
 * DO UPDATE SET list, so it holds the run timestamp of the ingest that first
 * saw an object and never changes afterwards. Every row of this run carries the
 * same `now`, which turns "what is new" into one equality query instead of a
 * pre-ingest snapshot of 28k ids held in memory for the diff.
 *
 * The event is `SATCAT_DEBUT`-shaped: a first *elset* sighting. An object can
 * appear in SATCAT before it has a public elset, so wave 4's feed should read
 * this as "started being tracked", not "launched".
 */
async function recordNewObjects(env, now) {
  const { results } = await env.ORBIT_DB
    .prepare(`SELECT NORAD_CAT_ID, OBJECT_NAME, OBJECT_ID, OBJECT_TYPE,
                     COUNTRY_CODE, LAUNCH_DATE, regime, operator
              FROM objects WHERE first_seen = ?`)
    .bind(now)
    .all();

  const fresh = results || [];
  if (!fresh.length) return 0;

  // A bootstrap run marks all ~28k rows as first-seen. Emitting an event each
  // would bury the feed under one meaningless flood, so the seed is recorded as
  // a single event instead.
  if (fresh.length > 500) {
    await recordEvents(env.ORBIT_DB, [{
      ts: now,
      kind: 'catalog_seed',
      norad: null,
      title: `Catalog seeded — ${fresh.length} objects`,
      detail: { count: fresh.length },
    }]);
    return fresh.length;
  }

  await recordEvents(env.ORBIT_DB, fresh.map((r) => ({
    ts: now,
    kind: 'new_object',
    norad: r.NORAD_CAT_ID,
    title: `${r.OBJECT_NAME || 'Unnamed object'} entered the catalog`,
    detail: {
      object_id: r.OBJECT_ID,
      type: r.OBJECT_TYPE,
      country: r.COUNTRY_CODE,
      launch_date: r.LAUNCH_DATE,
      regime: r.regime,
      operator: r.operator,
    },
  })));
  return fresh.length;
}
