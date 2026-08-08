/**
 * ingest-spaceweather.js — NOAA SWPC reducers + ingest (plan 34 §3.4).
 *
 *     node workers/orbit-ingest/test/space-weather.test.mjs
 *
 * Everything upstream is inline fixtures shaped from the live SWPC endpoints
 * (verified 2026-08-08): the 3-hour Kp file, the 3-day forecast file and the
 * F10.7 file. `fetch` is injected, so the suite never touches the network.
 *
 * What this catches:
 *
 *   - upstream scalars coming back as strings (the Space-Track lesson) being
 *     stored as text and breaking every numeric comparison downstream;
 *   - SWPC's zone-less time_tags being parsed as LOCAL time, which shifts a
 *     `keepDays` cutoff by a day on any non-UTC host — the same class of bug
 *     parseEpochUTC exists for, against a provider that zero-pads properly;
 *   - an empty upstream day wiping the table (the boxscore empty-guard);
 *   - one series failing and taking the other two down with it — the daily
 *     job's partial-data-beats-skipped-run discipline applied per kind;
 *   - the DELETE and the reload escaping one transaction, leaving the kind
 *     half-empty on a mid-batch failure;
 *   - the artifact shape drifting from what the endpoint's D1 fallback
 *     rebuilds — the two bundles' one contract, pinned by the round-trip test.
 */
import assert from 'node:assert/strict';

import { fakeDB, fakeR2 } from './fakes.mjs';
import {
  ingestSpaceWeather, reduceKp3h, reduceKpForecast, reduceF107,
  buildSpaceWeatherArtifact, SWPC_KP_3H, SWPC_KP_FOR, SWPC_F107,
} from '../src/ingest-spaceweather.js';
import { SWPC_CITATION } from '../src/derive.js';

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS  ' + name); }
  catch (e) { results.push(false); console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); }
}

/* ── Fixtures, shaped from the live endpoints ───────────────────────────── */

const KP_3H = [
  { time_tag: '2026-08-07T21:00:00', Kp: 1.33, a_running: 5, station_count: 8 },
  { time_tag: '2026-08-07T18:00:00', Kp: '0.67', a_running: '4', station_count: 8 },
  { time_tag: '2026-08-07T15:00:00', Kp: 1, a_running: 4, station_count: 8 },
  // Stale row, ~10 days back — must be dropped by the 7-day window.
  { time_tag: '2026-07-28T00:00:00', Kp: 4.33, a_running: 30, station_count: 8 },
];

const FORECAST = [
  { time_tag: '2026-08-07T21:00:00', kp: 1.33, observed: 'observed', noaa_scale: null },
  { time_tag: '2026-08-08T00:00:00', kp: 2.0, observed: 'forecast', noaa_scale: null },
  { time_tag: '2026-08-08T03:00:00', kp: '3.33', observed: 'forecast', noaa_scale: 2 },
];

const F107 = [
  { time_tag: '2026-08-06T22:00:00', frequency: 2800, flux: 100, reporting_schedule: 'Afternoon', ninety_day_mean: null },
  { time_tag: '2026-08-07T20:00:00', frequency: 2800, flux: 97, reporting_schedule: 'Noon', avg_begin_date: '2026-05-10T20:00:00', ninety_day_mean: 132, rec_count: 90 },
  { time_tag: '2026-08-07T22:00:00', frequency: 2800, flux: '95', reporting_schedule: 'Afternoon', ninety_day_mean: null },
];

const NOW_MS = Date.UTC(2026, 7, 8, 12, 0, 0);

/* ── Reducers ────────────────────────────────────────────────────────────── */

console.log('\n-- reducers --');

await test('reduceKp3h coerces numeric scalars and sorts oldest-first', () => {
  const out = reduceKp3h(KP_3H, { nowMs: NOW_MS });
  assert.equal(out.length, 3, 'the stale row is dropped');
  assert.deepEqual(out.map((r) => r.time_tag),
    ['2026-08-07T15:00:00', '2026-08-07T18:00:00', '2026-08-07T21:00:00']);
  assert.equal(out[1].kp, 0.67, 'string Kp coerced');
  assert.equal(out[1].ap, 4, 'string a_running coerced');
  assert.equal(out[2].kp, 1.33);
  assert.equal(typeof out[0].kp, 'number');
});

await test('the keepDays cutoff is computed in UTC, not host-local time', () => {
  // Zone-less time_tags must parse as UTC: with NOW = 2026-08-08T12:00:00Z the
  // cutoff is 2026-08-01T12:00:00Z, so a row at 06:00Z is 7.25 days back
  // (dropped), one at 12:00Z is exactly the boundary (kept) and one at 18:00Z
  // is inside. A Date.parse that read the tags as host-LOCAL time would shift
  // the boundary by the host's offset and flip one of these.
  const rows = [
    { time_tag: '2026-08-01T06:00:00', Kp: 1, a_running: 4, station_count: 8 }, // 7.25d back
    { time_tag: '2026-08-01T12:00:00', Kp: 1, a_running: 4, station_count: 8 }, // 7.0d back
    { time_tag: '2026-08-01T18:00:00', Kp: 1, a_running: 4, station_count: 8 }, // 6.75d back
  ];
  const out = reduceKp3h(rows, { nowMs: NOW_MS, keepDays: 7 });
  assert.deepEqual(out.map((r) => r.time_tag),
    ['2026-08-01T12:00:00', '2026-08-01T18:00:00']);
});

await test('reduceKpForecast marks observed vs forecast and keeps the scale', () => {
  const out = reduceKpForecast(FORECAST);
  assert.equal(out.length, 3);
  assert.equal(out[0].observed, true);
  assert.equal(out[1].observed, false);
  assert.equal(out[2].kp, 3.33, 'string kp coerced');
  assert.equal(out[2].noaa_scale, 2);
});

await test('reduceF107 keeps only rows with a finite flux, latest wins upstream', () => {
  const out = reduceF107(F107);
  assert.equal(out.length, 3);
  assert.equal(out[2].flux, 95, 'string flux coerced');
  assert.equal(out[2].ninety_day_mean, null);
  assert.equal(out[1].ninety_day_mean, 132);
});

/* ── Artifact shape ──────────────────────────────────────────────────────── */

console.log('\n-- buildSpaceWeatherArtifact --');

await test('current folds the latest Kp row and the latest F10.7 observation', () => {
  const kp3h = reduceKp3h(KP_3H, { nowMs: NOW_MS });
  const forecast = reduceKpForecast(FORECAST);
  const f107 = reduceF107(F107);
  const a = buildSpaceWeatherArtifact({ kp3h, forecast, f107, generatedAt: '2026-08-08T12:00:00.000Z' });
  assert.equal(a.current.kp, 1.33);
  assert.equal(a.current.ap, 5);
  assert.equal(a.current.station_count, 8);
  assert.equal(a.current.f107, 95);
  assert.equal(a.current.f107_90day, 132);
  assert.equal(a.kp_history.length, kp3h.length);
  assert.deepEqual(a.kp_history[0], { t: '2026-08-07T15:00:00', kp: 1 });
  assert.deepEqual(a.kp_forecast[2], { t: '2026-08-08T03:00:00', kp: 3.33, observed: false });
  assert.equal(a.swpc_citation, SWPC_CITATION);
});

await test('a missing series leaves null fields, never a dropped key', () => {
  const a = buildSpaceWeatherArtifact({ kp3h: [], forecast: [], f107: null });
  assert.equal(a.current.kp, null);
  assert.equal(a.current.f107, null);
  assert.equal(a.f107, null);
  assert.deepEqual(a.kp_history, []);
  assert.deepEqual(a.kp_forecast, []);
});

await test('f107_90day is the latest row that carries a mean, not the latest row', () => {
  // SWPC attaches the 90-day mean to some reports (the Noon one) and not
  // others (Morning/Afternoon), so the newest observation usually has
  // ninety_day_mean: null. The mean moves once a day; the correct value is
  // the most recent one KNOWN, even if an older row holds it.
  const f107 = reduceF107(F107);
  const a = buildSpaceWeatherArtifact({ kp3h: [], forecast: [], f107 });
  assert.equal(a.current.f107, 95, 'flux comes from the latest row');
  assert.equal(a.current.f107_90day, 132, 'mean comes from the latest row that has one');
});

/* ── Ingest ──────────────────────────────────────────────────────────────── */

function fetchFor(payloads) {
  return async (url) => new Response(JSON.stringify(payloads[url] ?? []), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeEnv() {
  const db = fakeDB();
  const r2 = fakeR2();
  const env = { ORBIT_DB: db, ORBIT_R2: r2 };
  return { db, r2, env };
}

console.log('\n-- ingestSpaceWeather --');

await test('three series are fetched, replaced and written as one artifact', async () => {
  const { db, r2, env } = makeEnv();
  const res = await ingestSpaceWeather(env, {
    fetchImpl: fetchFor({
      [SWPC_KP_3H]: KP_3H,
      [SWPC_KP_FOR]: FORECAST,
      [SWPC_F107]: F107,
    }),
  });

  assert.deepEqual(res.kinds, { kp_3h: 3, kp_forecast: 3, f107: 3 });

  // Delete + reload in ONE batch → a mid-batch failure rolls the kind back.
  const batch = db.executed.filter((e) => e.batched);
  assert.equal(batch.filter((e) => /DELETE FROM space_weather/.test(e.sql)).length, 3);
  assert.equal(batch.filter((e) => /INSERT INTO space_weather/.test(e.sql)).length, 9);

  // The f107 row stores flux in `value`; the Kp kinds store kp.
  const inserts = batch.filter((e) => /INSERT INTO space_weather/.test(e.sql));
  const f107Row = inserts.find((e) => e.args[0] === 'f107' && e.args[1] === '2026-08-07T22:00:00');
  assert.equal(f107Row.args[2], 95);
  assert.equal(JSON.parse(f107Row.args[3]).ninety_day_mean, null);
  const kpRow = inserts.find((e) => e.args[0] === 'kp_3h' && e.args[1] === '2026-08-07T21:00:00');
  assert.equal(kpRow.args[2], 1.33);
  assert.deepEqual(JSON.parse(kpRow.args[3]), { ap: 5, station_count: 8 });

  // Artifact lands on R2 with the citation inside.
  const put = r2.puts.get('space-weather/latest.json');
  assert.ok(put, 'artifact written');
  const artifact = JSON.parse(put.body);
  assert.equal(artifact.current.kp, 1.33);
  assert.equal(artifact.swpc_citation, SWPC_CITATION);
  assert.equal(put.opts.httpMetadata.contentType, 'application/json; charset=utf-8');
});

await test('an all-empty upstream writes nothing (the boxscore empty-guard)', async () => {
  const { db, r2, env } = makeEnv();
  const res = await ingestSpaceWeather(env, { fetchImpl: fetchFor({}) });
  assert.equal(res.rows, 0);
  assert.equal(db.executed.filter((e) => /space_weather/.test(e.sql)).length, 0);
  assert.equal(r2.puts.size, 0);
});

await test('one failed series does not take the other two down', async () => {
  const { db, r2, env } = makeEnv();
  const res = await ingestSpaceWeather(env, {
    fetchImpl: async (url) => {
      if (url === SWPC_KP_FOR) return new Response('not json at all', { status: 200 });
      return fetchFor({ [SWPC_KP_3H]: KP_3H, [SWPC_F107]: F107 })(url);
    },
  });
  assert.deepEqual(res.kinds, { kp_3h: 3, f107: 3 });
  assert.equal(res.errors.length, 1);
  const batch = db.executed.filter((e) => e.batched);
  assert.equal(batch.filter((e) => /DELETE/.test(e.sql)).length, 2);
  const artifact = JSON.parse(r2.puts.get('space-weather/latest.json').body);
  assert.deepEqual(artifact.kp_forecast, []);
  assert.equal(artifact.current.kp, 1.33, 'the good series still fed `current`');
});

await test('an HTTP failure upstream is a per-kind error, not a throw', async () => {
  const { db, r2, env } = makeEnv();
  const res = await ingestSpaceWeather(env, {
    fetchImpl: async (url) => (url === SWPC_F107
      ? new Response('', { status: 503 })
      : fetchFor({ [SWPC_KP_3H]: KP_3H, [SWPC_KP_FOR]: FORECAST })(url)),
  });
  assert.deepEqual(res.kinds, { kp_3h: 3, kp_forecast: 3 });
  const artifact = JSON.parse(r2.puts.get('space-weather/latest.json').body);
  assert.equal(artifact.current.f107, null);
});

/* ── Summary ─────────────────────────────────────────────────────────────── */

console.log(`\n-- space-weather: ${results.filter(Boolean).length}/${results.length} checks --`);
if (results.some((r) => !r)) process.exitCode = 1;
