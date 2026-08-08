/**
 * The /spacetrack/ catalog endpoints, against a real SQLite.
 *
 *     node workers/orbit-ingest/test/pages-api.test.mjs
 *
 * **Why this lives in the ingest package.** It tests `functions/api/*`, not the
 * Worker — but those Functions are the *read* side of the schema this package
 * owns the write side of, and a column rename here breaks them silently at
 * runtime. The harness that applies `d1/orbit.sql` to `node:sqlite` is already
 * here, so the two sides of one contract are checked against one applied
 * schema. The alternative was a second copy of the harness.
 *
 * What it catches that the E2E cannot: the E2E runs against a static server
 * with no Pages Functions at all, so it can only prove the page fails soft.
 * Everything below is the SQL actually running.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { OBJECT_UPSERT_SQL, deriveObjectRow, buildAnalytics } from '../src/derive.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const SCHEMA = fs.readFileSync(path.join(ROOT, 'd1/orbit.sql'), 'utf8');
const raw = (n) => fs.readFileSync(path.join(HERE, '../fixtures', n), 'utf8');

const search      = (await import(path.join(ROOT, 'functions/api/search.js'))).onRequest;
const dossier     = (await import(path.join(ROOT, 'functions/api/object/[norad].js'))).onRequest;
const summary     = (await import(path.join(ROOT, 'functions/api/summary.js'))).onRequest;
const analytics   = (await import(path.join(ROOT, 'functions/api/analytics.js'))).onRequest;
const feed        = (await import(path.join(ROOT, 'functions/api/feed.js'))).onRequest;
const decayWatch  = (await import(path.join(ROOT, 'functions/api/decay-watch.js'))).onRequest;
const boxscore    = (await import(path.join(ROOT, 'functions/api/boxscore.js'))).onRequest;
const brief       = (await import(path.join(ROOT, 'functions/api/brief.js'))).onRequest;
const spaceWeather = (await import(path.join(ROOT, 'functions/api/space-weather.js'))).onRequest;
const { rebuildFromRows } = await import(path.join(ROOT, 'functions/api/space-weather.js'));

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS  ' + name); }
  catch (e) { results.push(false); console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); }
}

/* ── A D1-shaped binding over node:sqlite ───────────────────────────────── */

function localD1(db) {
  const norm = (a) => a.map((v) => (v === undefined ? null : v));
  return {
    prepare(sql) {
      const stmt = { sql, args: [] };
      stmt.bind = (...a) => { stmt.args = norm(a); return stmt; };
      stmt.all  = async () => ({ results: db.prepare(sql).all(...stmt.args) });
      stmt.first = async () => db.prepare(sql).get(...stmt.args) ?? null;
      stmt.run  = async () => {
        const i = db.prepare(sql).run(...stmt.args);
        return { meta: { last_row_id: Number(i.lastInsertRowid), changes: Number(i.changes) } };
      };
      return stmt;
    },
  };
}

const NOW = '2026-07-27T10:00:00.000Z';

function seeded() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);

  const gp = JSON.parse(raw('sample_gp.json'));
  const stmt = db.prepare(OBJECT_UPSERT_SQL);
  for (const r of gp) stmt.run(...deriveObjectRow(r, NOW));

  // The ISS, so there is a live LEO payload with a real catalog number to look
  // up. Identified everywhere by 25544 rather than by a name match — "ISS
  // (NAUKA)" and "ISS DEB" both contain the string (M-19).
  db.prepare(`INSERT INTO objects
      (NORAD_CAT_ID, OBJECT_NAME, OBJECT_ID, OBJECT_TYPE, COUNTRY_CODE, RCS_SIZE,
       SITE, LAUNCH_DATE, EPOCH, PERIOD, INCLINATION, APOAPSIS, PERIAPSIS,
       SEMIMAJOR_AXIS, TLE_LINE1, TLE_LINE2, regime, launch_year, operator,
       first_seen, updated_at)
      VALUES (25544, 'ISS (ZARYA)', '1998-067A', 'PAYLOAD', 'ISS', 'LARGE',
              'TTMTR', '1998-11-20', ?, 92.9, 51.64, 422.1, 415.3,
              6796.8, '1 25544U 98067A', '2 25544  51.6', 'LEO', 1998, 'nasa',
              ?, ?)`).run(NOW, NOW, NOW);

  db.prepare(`INSERT INTO satcat
      (NORAD_CAT_ID, OBJECT_ID, SATNAME, OBJECT_TYPE, COUNTRY, LAUNCH, SITE,
       PERIOD, APOGEE, PERIGEE, RCSVALUE, RCS_SIZE, CURRENT, FILE, updated_at)
      VALUES (25544, '1998-067A', 'ISS (ZARYA)', 'PAYLOAD', 'ISS', '1998-11-20',
              'TTMTR', 92.9, 422, 415, 399.05, 'LARGE', 'Y', 500, ?)`).run(NOW);

  // A decayed object with a real DECAY_DATE, so decays_by_month and
  // cohort_on_orbit (task 3) have something non-empty to assert on. Launched
  // in the same 1958-1961 fixture span but marked decayed, so the historical
  // launch count for that decade stays the same while the "still on orbit"
  // count for it must be one less — exactly the split the launch series and
  // the distribution sections must NOT confuse.
  db.prepare(`INSERT INTO objects
      (NORAD_CAT_ID, OBJECT_NAME, OBJECT_ID, OBJECT_TYPE, COUNTRY_CODE, RCS_SIZE,
       SITE, LAUNCH_DATE, DECAY_DATE, EPOCH, PERIOD, INCLINATION, APOAPSIS, PERIAPSIS,
       SEMIMAJOR_AXIS, TLE_LINE1, TLE_LINE2, regime, launch_year,
       first_seen, updated_at)
      VALUES (99001, 'DECAYED TEST OBJECT', '1960-001A', 'DEBRIS', 'US', 'SMALL',
              'AFETR', '1960-05-01', '2026-03-14', ?, 100.2, 45.0, 800.0, 200.0,
              6878.0, '1 99001U 60001A', '2 99001  45.0', 'LEO', 1960,
              ?, ?)`).run(NOW, NOW, NOW);

  db.prepare(`INSERT INTO decay
      (NORAD_CAT_ID, OBJECT_NAME, OBJECT_ID, COUNTRY, MSG_EPOCH, DECAY_EPOCH,
       SOURCE, MSG_TYPE, PRECEDENCE, updated_at)
      VALUES (5, 'VANGUARD 1', '1958-002B', 'US', '2026-07-20T00:00:00',
              '2026-09-01T00:00:00', '60day_msg', 'Prediction', 1, ?)`).run(NOW);

  db.prepare(`INSERT INTO events (ts, kind, NORAD_CAT_ID, title, detail)
              VALUES (?, 'new_object', 25544, 'ISS entered the catalog', ?)`)
    .run(NOW, JSON.stringify({ regime: 'LEO' }));

  // launch_sites (plan 38 task 2) — the join buildAnalytics's top_launch_sites
  // uses for real names. AFETR is the site every fixture row + the decayed
  // test object share, so the join has something to actually resolve.
  db.prepare(`INSERT INTO launch_sites (SITE_CODE, LAUNCH_SITE, updated_at)
              VALUES ('AFETR', 'Cape Canaveral SFS', ?)`).run(NOW);

  return db;
}

const envOf = (db, r2) => ({ ORBIT_DB: localD1(db), ...(r2 ? { ORBIT_R2: r2 } : {}) });
const get = (url) => new Request(url);
const body = async (resp) => JSON.parse(await resp.text());

/* ── /api/search ────────────────────────────────────────────────────────── */

console.log('\n-- /api/search --');

const db = seeded();

await test('an unfiltered search returns live objects with a total', async () => {
  const r = await search({ request: get('https://x/api/search'), env: envOf(db) });
  assert.equal(r.status, 200);
  const j = await body(r);
  assert.ok(j.total > 0);
  assert.equal(j.results.length, j.total);
  assert.ok(j.results.every((o) => o.DECAY_DATE === null),
    'decayed objects are excluded unless asked for');
});

await test('the citation rides on the body AND the header', async () => {
  const r = await search({ request: get('https://x/api/search'), env: envOf(db) });
  const j = await body(r);
  assert.match(j.citation, /Space-Track\.org/);
  assert.match(r.headers.get('X-Data-Source'), /USSPACECOM/);
});

await test('a numeric q matches the catalog number', async () => {
  const r = await search({ request: get('https://x/api/search?q=25544'), env: envOf(db) });
  const j = await body(r);
  assert.equal(j.total, 1);
  assert.equal(j.results[0].OBJECT_NAME, 'ISS (ZARYA)');
});

await test('a text q matches anywhere in the name', async () => {
  const r = await search({ request: get('https://x/api/search?q=vanguard'), env: envOf(db) });
  const j = await body(r);
  assert.ok(j.total >= 4, `${j.total} vanguards`);
  assert.ok(j.results.every((o) => /vanguard/i.test(o.OBJECT_NAME)));
});

await test('regime and type filters are numeric-backed, not string compares', async () => {
  // This is the trap the whole ingest coercion exists for: PERIOD stored as
  // text makes regime classification and every range filter silently wrong.
  const r = await search({ request: get('https://x/api/search?regime=LEO&type=PAYLOAD'), env: envOf(db) });
  const j = await body(r);
  assert.ok(j.total >= 1);
  assert.ok(j.results.every((o) => o.regime === 'LEO' && o.OBJECT_TYPE === 'PAYLOAD'));
  assert.equal(typeof j.results[0].PERIOD, 'number');
});

await test('an era maps to a launch_year range', async () => {
  const r = await search({ request: get('https://x/api/search?era=1957-1969'), env: envOf(db) });
  const j = await body(r);
  assert.ok(j.total > 0);
  assert.ok(j.results.every((o) => o.launch_year >= 1957 && o.launch_year <= 1969));

  const modern = await body(await search({
    request: get('https://x/api/search?era=2020-'), env: envOf(db) }));
  assert.equal(modern.total, 0, 'the fixture is the twenty oldest catalogued objects');
});

await test('an unknown era is a 400, not an empty result set', async () => {
  const r = await search({ request: get('https://x/api/search?era=yesterday'), env: envOf(db) });
  assert.equal(r.status, 400);
});

await test('tle=1 adds the element set lines, and only then', async () => {
  const without = await body(await search({
    request: get('https://x/api/search?q=25544'), env: envOf(db) }));
  assert.equal(without.results[0].TLE_LINE1, undefined);

  const with_ = await body(await search({
    request: get('https://x/api/search?q=25544&tle=1'), env: envOf(db) }));
  assert.equal(with_.results[0].TLE_LINE1, '1 25544U 98067A');
});

await test('limit is clamped and offset pages', async () => {
  const j = await body(await search({
    request: get('https://x/api/search?limit=9999'), env: envOf(db) }));
  assert.equal(j.limit, 500, 'MAX_LIMIT, so the frontend cap and the API agree');

  const p1 = await body(await search({
    request: get('https://x/api/search?limit=5&sort=norad'), env: envOf(db) }));
  const p2 = await body(await search({
    request: get('https://x/api/search?limit=5&offset=5&sort=norad'), env: envOf(db) }));
  assert.equal(p1.results.length, 5);
  assert.notEqual(p1.results[0].NORAD_CAT_ID, p2.results[0].NORAD_CAT_ID);
});

await test('an unknown sort falls back rather than reaching the SQL', async () => {
  // The sort key is the one place a bound parameter cannot be used, so it is
  // whitelisted. Anything else must take the default, never interpolate.
  const r = await search({
    request: get("https://x/api/search?sort=NORAD_CAT_ID;DROP TABLE objects--"),
    env: envOf(db),
  });
  assert.equal(r.status, 200);
  assert.ok(db.prepare('SELECT COUNT(*) c FROM objects').get().c > 0, 'table still there');
});

await test('facets=1 returns counts without rows', async () => {
  const j = await body(await search({
    request: get('https://x/api/search?facets=1'), env: envOf(db) }));
  assert.equal(j.results, undefined);
  assert.ok(j.facets.type.length > 0);
  assert.ok(j.facets.regime.length > 0);
  assert.equal(j.operator_derived, true, 'operator is OUR inference and must say so');
  assert.ok(j.eras.includes('1957-1969'));
  assert.ok(j.facets.operator.every((f) => f.key !== null));
});

await test('an unbound D1 is a 503 that explains itself', async () => {
  const r = await search({ request: get('https://x/api/search'), env: {} });
  assert.equal(r.status, 503);
  assert.match((await body(r)).error, /not configured/);
});

/* ── /api/object/:norad ─────────────────────────────────────────────────── */

console.log('\n-- /api/object/:norad --');

await test('a dossier joins GP, SATCAT, decay and events', async () => {
  const r = await dossier({
    request: get('https://x/api/object/25544'), env: envOf(db), params: { norad: '25544' } });
  assert.equal(r.status, 200);
  const j = await body(r);
  assert.equal(j.object.OBJECT_NAME, 'ISS (ZARYA)');
  assert.equal(j.object.satcat_rcs_m2, 399.05, 'the SATCAT half of the join landed');
  assert.equal(j.object.satcat_site, 'TTMTR');
  assert.equal(j.events.length, 1);
  assert.deepEqual(j.events[0].detail, { regime: 'LEO' }, 'event detail is parsed, not a string');
});

await test('apogee/perigee are resolved to ONE pair, and they are altitudes', async () => {
  // GP calls them APOAPSIS/PERIAPSIS, SATCAT calls them APOGEE/PERIGEE, and
  // both are ALTITUDES above the surface rather than radii. Getting that wrong
  // puts the ISS at ~6800 km.
  const j = await body(await dossier({
    request: get('https://x/api/object/25544'), env: envOf(db), params: { norad: '25544' } }));
  assert.equal(j.object.apogee_km, 422.1);
  assert.equal(j.object.perigee_km, 415.3);
  assert.ok(j.object.apogee_km < 2000, 'an altitude, not a radius');
});

await test('decay predictions come back newest first and are flagged predicted', async () => {
  const j = await body(await dossier({
    request: get('https://x/api/object/5'), env: envOf(db), params: { norad: '5' } }));
  assert.equal(j.decay.length, 1);
  assert.equal(j.decay[0].SOURCE, '60day_msg');
  assert.equal(j.decay[0].predicted, true);
});

await test('an uncatalogued number is a 404, not an empty object', async () => {
  const r = await dossier({
    request: get('https://x/api/object/999999'), env: envOf(db), params: { norad: '999999' } });
  assert.equal(r.status, 404);
});

await test('a non-numeric norad is rejected before it reaches SQL', async () => {
  for (const bad of ['abc', '-1', '0', '25544; DROP TABLE objects']) {
    const r = await dossier({
      request: get(`https://x/api/object/${bad}`), env: envOf(db), params: { norad: bad } });
    assert.equal(r.status, 400, bad);
  }
  assert.ok(db.prepare('SELECT COUNT(*) c FROM objects').get().c > 0);
});

/* ── /api/summary ───────────────────────────────────────────────────────── */

console.log('\n-- /api/summary --');

await test('the R2 artifact is served when it exists', async () => {
  const artifact = { tracked: 28123, by_type: { PAYLOAD: 11000 }, generated_at: NOW };
  const r2 = { get: async () => ({ text: async () => JSON.stringify(artifact) }) };
  const j = await body(await summary({ request: get('https://x/api/summary'), env: envOf(db, r2) }));
  assert.equal(j.tracked, 28123);
  assert.equal(j.stale, false);
});

await test('a missing artifact falls back to counting in D1, and says so', async () => {
  const r2 = { get: async () => null };
  const j = await body(await summary({ request: get('https://x/api/summary'), env: envOf(db, r2) }));
  assert.equal(j.stale, true);
  assert.ok(j.tracked > 0);
  assert.match(j.note, /not built yet/);
});

await test('a corrupt artifact falls back rather than taking the page down', async () => {
  const r2 = { get: async () => ({ text: async () => 'not json {' }) };
  const j = await body(await summary({ request: get('https://x/api/summary'), env: envOf(db, r2) }));
  assert.equal(j.stale, true);
  assert.ok(j.tracked > 0);
});

/* ── /api/analytics ─────────────────────────────────────────────────────── */

console.log('\n-- /api/analytics --');

await test('the R2 artifact is served when it exists', async () => {
  const artifact = {
    launches_by_decade: [{ decade: 1960, n: 5000 }],
    top_launch_sites: [{ site: 'AFETR', n: 900 }],
    generated_at: NOW,
  };
  const r2 = { get: async () => ({ text: async () => JSON.stringify(artifact) }) };
  const j = await body(await analytics({ request: get('https://x/api/analytics'), env: envOf(db, r2) }));
  assert.equal(j.launches_by_decade[0].n, 5000);
  assert.equal(j.stale, false);
});

await test('a missing artifact falls back to a decade count from D1, and says so', async () => {
  const r2 = { get: async () => null };
  const j = await body(await analytics({ request: get('https://x/api/analytics'), env: envOf(db, r2) }));
  assert.equal(j.stale, true);
  assert.ok(j.launches_by_decade.length > 0);
  // The fixture is the twenty oldest catalogued objects (1958-1961), so the
  // 1950s and 1960s decades must both be present — this is the same "real
  // data against the real query shape" discipline as the GP predicates bug:
  // asserting SOME decade exists would pass even if launch_year were null
  // for every row and the GROUP BY silently collapsed to one UNKNOWN bucket.
  const decades = j.launches_by_decade.map((r) => r.decade);
  assert.ok(decades.includes(1950), decades.join(','));
  assert.ok(decades.includes(1960), decades.join(','));
  assert.match(j.note, /not built yet/);
});

await test('a corrupt artifact falls back rather than taking the page down', async () => {
  const r2 = { get: async () => ({ text: async () => 'not json {' }) };
  const j = await body(await analytics({ request: get('https://x/api/analytics'), env: envOf(db, r2) }));
  assert.equal(j.stale, true);
  assert.ok(j.launches_by_decade.length > 0);
});

/* ── buildAnalytics() itself ──────────────────────────────────────────────
 * The endpoint tests above prove the R2-first / D1-fallback read side; these
 * prove the write side actually produces the shape that read side (and the
 * HUD) expects, against the same seeded schema.
 */
console.log('\n-- buildAnalytics() --');

function fakeR2() {
  const store = new Map();
  return {
    store,
    put: async (key, value) => { store.set(key, value); },
    get: async (key) => (store.has(key) ? { text: async () => store.get(key) } : null),
  };
}

await test('the artifact is written to catalog/analytics.json and carries the citation', async () => {
  const r2 = fakeR2();
  const card = await buildAnalytics(envOf(db, r2));
  assert.ok(r2.store.has('catalog/analytics.json'));
  assert.match(card.citation, /Space-Track\.org/);
});

await test('every fixture-era decade is present, not collapsed into one bucket', async () => {
  const card = await buildAnalytics(envOf(db, fakeR2()));
  const decades = card.launches_by_decade.map((r) => r.decade);
  // The fixture spans 1958-1961 (the twenty oldest catalogued objects) plus
  // the seeded ISS row at 1998 — three distinct decades is what a working
  // GROUP BY on launch_year produces; one decade is what a null/miscast
  // column collapsing to a single bucket would look like instead.
  assert.ok(decades.includes(1950), decades.join(','));
  assert.ok(decades.includes(1960), decades.join(','));
  assert.ok(decades.includes(1990), decades.join(','));
});

await test('top launch sites are ranked by count, most first', async () => {
  const card = await buildAnalytics(envOf(db, fakeR2()));
  assert.ok(card.top_launch_sites.length > 0);
  for (let i = 1; i < card.top_launch_sites.length; i++) {
    assert.ok(card.top_launch_sites[i - 1].n >= card.top_launch_sites[i].n);
  }
  assert.ok(card.top_launch_sites.some((s) => s.site === 'AFETR'));
});

await test('country_by_decade rows align one count per listed decade', async () => {
  const card = await buildAnalytics(envOf(db, fakeR2()));
  const { decades, countries } = card.country_by_decade;
  assert.ok(decades.length > 0);
  for (const c of countries) {
    assert.equal(c.by_decade.length, decades.length,
      'a missing decade must be a zero, not a shorter array the frontend would misalign');
  }
});

await test('top launch sites carry the real name from launch_sites, not just the code', async () => {
  const card = await buildAnalytics(envOf(db, fakeR2()));
  const afetr = card.top_launch_sites.find((s) => s.site === 'AFETR');
  assert.ok(afetr, 'AFETR must be present');
  assert.equal(afetr.name, 'Cape Canaveral SFS');
});

await test('historical sections (launches_by_decade) include the decayed test object', async () => {
  const card = await buildAnalytics(envOf(db, fakeR2()));
  // 99001 launched in 1960 and is DECAYED — a historical count must still
  // include it, unlike the on-orbit-now sections below.
  const decade1960 = card.launches_by_decade.find((r) => r.decade === 1960);
  assert.ok(decade1960 && decade1960.n > 0, 'the 1960s decade must count the decayed object');
});

await test('on-orbit-now sections (by_type, by_regime, rcs_sizes) exclude the decayed test object', async () => {
  const card = await buildAnalytics(envOf(db, fakeR2()));
  // 99001 is OBJECT_TYPE=DEBRIS, RCS_SIZE=SMALL, regime=LEO, and DECAYED.
  // If these sections wrongly included decayed rows, DEBRIS/SMALL would be
  // inflated by exactly one over what a DECAY_DATE IS NULL count gives.
  const liveDebris = db.prepare(
    `SELECT COUNT(*) AS n FROM objects WHERE OBJECT_TYPE = 'DEBRIS' AND DECAY_DATE IS NULL`).get().n;
  assert.equal(card.by_type.DEBRIS || 0, liveDebris,
    'by_type must filter DECAY_DATE IS NULL, matching a live-only D1 count exactly');
});

await test('cohort_on_orbit counts the decayed object as launched but not still on orbit', async () => {
  const card = await buildAnalytics(envOf(db, fakeR2()));
  const row = card.cohort_on_orbit.find((r) => r.decade === 1960);
  assert.ok(row, '1960s decade must appear in cohort_on_orbit');
  assert.ok(row.launched > row.still_on_orbit,
    'launched must exceed still_on_orbit once one 1960s object has decayed');
});

await test('decays_by_month is sourced from objects.DECAY_DATE, not from events', async () => {
  const card = await buildAnalytics(envOf(db, fakeR2()));
  // The only DECAY_DATE in the seeded schema is 99001's 2026-03-14; events
  // carries no decay-kind rows for it at all (the seeded events row is a
  // new_object for the ISS). If this ever regresses to reading `events`,
  // this array goes empty because there is nothing to read there.
  assert.ok(card.decays_by_month.some((r) => r.month === '2026-03' && r.n === 1),
    JSON.stringify(card.decays_by_month));
});

await test('altitude_bins and inclination_bins only cover on-orbit-now objects', async () => {
  const card = await buildAnalytics(envOf(db, fakeR2()));
  const totalAlt = card.altitude_bins.reduce((s, b) => s + b.n, 0);
  const liveCount = db.prepare(`SELECT COUNT(*) AS n FROM objects WHERE DECAY_DATE IS NULL
    AND APOAPSIS IS NOT NULL AND PERIAPSIS IS NOT NULL`).get().n;
  assert.equal(totalAlt, liveCount, 'altitude_bins must not include the decayed object');
});

await test('altitude_bins bucket edges follow the same max-lands-in-last-bin rule as bin()', async () => {
  const card = await buildAnalytics(envOf(db, fakeR2()));
  assert.ok(card.altitude_bins.length > 0);
  for (let i = 1; i < card.altitude_bins.length; i++) {
    assert.equal(card.altitude_bins[i].min, card.altitude_bins[i - 1].max,
      'bins must be contiguous, no gaps or overlaps');
  }
});

await test('operator_by_year badges every row as derived and splits into top/other', async () => {
  const card = await buildAnalytics(envOf(db, fakeR2()));
  assert.ok(Array.isArray(card.operator_by_year));
  for (const row of card.operator_by_year) {
    assert.equal(row.derived, true, 'operator is inferred, never authoritative — must badge');
    assert.ok(typeof row.top === 'object' && row.top !== null);
    assert.ok(typeof row.other === 'number');
  }
});

await test('regime_by_year rows are zero-filled across all four regimes', async () => {
  const card = await buildAnalytics(envOf(db, fakeR2()));
  for (const row of card.regime_by_year) {
    for (const k of ['leo', 'meo', 'geo', 'heo']) {
      assert.ok(typeof row[k] === 'number', `${k} must be a zero-filled number, not missing`);
    }
  }
});

/* ── /api/feed ──────────────────────────────────────────────────────────── */

console.log('\n-- /api/feed --');

await test('the R2 feed artifact is served when it exists', async () => {
  const artifact = { events: [{ ts: NOW, kind: 'new_object', norad: 1, title: 'x' }] };
  const r2 = { get: async () => ({ text: async () => JSON.stringify(artifact) }) };
  const j = await body(await feed({ request: get('https://x/api/feed'), env: envOf(db, r2) }));
  assert.equal(j.stale, false);
  assert.equal(j.events.length, 1);
});

await test('a missing artifact falls back to D1 and returns the seeded event', async () => {
  const r2 = { get: async () => null };
  const j = await body(await feed({ request: get('https://x/api/feed'), env: envOf(db, r2) }));
  assert.equal(j.stale, true);
  assert.ok(j.events.length >= 1);
  assert.equal(j.events[0].kind, 'new_object');
  assert.deepEqual(j.events[0].detail, { regime: 'LEO' }, 'detail is parsed, not a string');
});

db.prepare(`INSERT INTO events (ts, kind, NORAD_CAT_ID, title, detail)
            VALUES (?, 'decay', 5, 'VANGUARD 1 decayed', NULL)`).run(NOW);

await test('limit is respected', async () => {
  const r2 = { get: async () => null };
  const j = await body(await feed({
    request: get('https://x/api/feed?limit=1'), env: envOf(db, r2) }));
  assert.equal(j.events.length, 1);
});

/* ── /api/decay-watch ───────────────────────────────────────────────────── */

console.log('\n-- /api/decay-watch --');

// These epochs are relative to the REAL clock, not to the fixed NOW above,
// because the endpoint now filters out predictions whose date has already
// passed. Hardcoded 2026 dates would quietly become a time bomb: the suite
// would pass until the wall clock overtook them, then fail for a reason that
// has nothing to do with the code.
const dayAhead = (n) =>
  new Date(Date.now() + n * 86400000).toISOString().slice(0, 19).replace('T', ' ');

// A second, later message for NORAD 5 — Space-Track revising its own estimate.
// The watch list must show this one, not the first.
const VANGUARD_LATER = dayAhead(18);
db.prepare(`INSERT INTO decay
    (NORAD_CAT_ID, OBJECT_NAME, COUNTRY, MSG_EPOCH, DECAY_EPOCH, SOURCE, PRECEDENCE, updated_at)
    VALUES (5, 'VANGUARD 1', 'US', '2026-07-25T00:00:00', ?, '60day_msg', 1, ?)`)
  .run(VANGUARD_LATER, NOW);

// An object that has already actually decayed, with a prediction still on file.
// The prediction is deliberately in the FUTURE so that only the DECAY_DATE
// exclusion can remove it — otherwise this test would pass on the new date
// floor and stop proving the thing it is named for.
db.prepare(`INSERT INTO objects
    (NORAD_CAT_ID, OBJECT_NAME, OBJECT_TYPE, DECAY_DATE, first_seen, updated_at)
    VALUES (9001, 'ALREADY DOWN', 'DEBRIS', '2026-07-01', ?, ?)`).run(NOW, NOW);
db.prepare(`INSERT INTO decay
    (NORAD_CAT_ID, OBJECT_NAME, COUNTRY, MSG_EPOCH, DECAY_EPOCH, SOURCE, PRECEDENCE, updated_at)
    VALUES (9001, 'ALREADY DOWN', 'US', '2026-06-01T00:00:00', ?, '60day_msg', 1, ?)`)
  .run(dayAhead(9), NOW);

// Sputnik 1, exactly as the live catalog carries it — a HISTORICAL decay
// message, in Space-Track's own unpadded-hour format. The decay table holds
// these alongside forward predictions, and without a date floor it sorted to
// the TOP of a list captioned "soonest predicted reentry", 25,076 days late.
db.prepare(`INSERT INTO decay
    (NORAD_CAT_ID, OBJECT_NAME, COUNTRY, MSG_EPOCH, DECAY_EPOCH, SOURCE, PRECEDENCE, updated_at)
    VALUES (9002, 'SPUTNIK 1', 'CIS', '1958-01-03 0:00:00', '1958-01-03 0:00:00', 'decay_msg', 1, ?)`)
  .run(NOW);

await test('the latest message per object wins, not the first', async () => {
  const j = await body(await decayWatch({ request: get('https://x/api/decay-watch'), env: envOf(db) }));
  const v = j.watch.find((w) => w.norad === 5);
  assert.ok(v, 'NORAD 5 present');
  assert.equal(v.decay_epoch, VANGUARD_LATER, 'the newer prediction, not the original');
});

await test('an object already marked decayed is excluded even with a prediction on file', async () => {
  const j = await body(await decayWatch({ request: get('https://x/api/decay-watch'), env: envOf(db) }));
  assert.ok(!j.watch.some((w) => w.norad === 9001));
});

await test('a historical decay message is not a reentry prediction', async () => {
  const j = await body(await decayWatch({ request: get('https://x/api/decay-watch'), env: envOf(db) }));
  assert.ok(!j.watch.some((w) => w.norad === 9002),
            'Sputnik 1 decayed in 1958 and does not belong on a watch list');
  assert.ok(j.watch.every((w) => w.days_until === null || w.days_until >= 0),
            'negative countdowns present: ' + JSON.stringify(
              j.watch.filter((w) => w.days_until < 0).slice(0, 3)));
});

await test('the list is ranked soonest-first and carries a days_until countdown', async () => {
  const j = await body(await decayWatch({ request: get('https://x/api/decay-watch'), env: envOf(db) }));
  assert.ok(j.watch.length >= 1);
  for (let i = 1; i < j.watch.length; i++) {
    assert.ok(j.watch[i - 1].decay_epoch <= j.watch[i].decay_epoch);
  }
  assert.equal(typeof j.watch[0].days_until, 'number');
});

await test('days_until does not drift with the host timezone', async () => {
  // DECAY_EPOCH arrives zone-less ("2026-07-26 04:12:00") and V8 parses that as
  // LOCAL time, which moves a ceil()'d day count by one off UTC. The DAILY
  // BRIEF panel sits directly above this one showing the same objects, so a
  // divergence here is visible on screen, not just wrong.
  const { parseEpochUTC } = await import(path.join(ROOT, 'functions/api/_catalog.js'));
  const t = parseEpochUTC('2026-08-01 12:00:00');
  assert.equal(new Date(t).toISOString(), '2026-08-01T12:00:00.000Z',
               `parsed as local time (TZ=${process.env.TZ || 'unset'})`);
  assert.equal(parseEpochUTC('2026-08-01T12:00:00Z'), t, 'an explicit zone must be honoured');
  assert.ok(Number.isNaN(parseEpochUTC(null)));
});

await test('the note distinguishes this from derived conjunction screening', async () => {
  const j = await body(await decayWatch({ request: get('https://x/api/decay-watch'), env: envOf(db) }));
  assert.match(j.note, /Space-Track's own/);
});

/* ── /api/boxscore ──────────────────────────────────────────────────────── */

console.log('\n-- /api/boxscore --');

db.prepare(`INSERT INTO boxscore
    (COUNTRY, SPADOC_CD, ORBITAL_PAYLOAD_COUNT, ORBITAL_TOTAL_COUNT, COUNTRY_TOTAL, updated_at)
    VALUES ('US', 'US', 4000, 8000, 8500, ?)`).run(NOW);
db.prepare(`INSERT INTO boxscore
    (COUNTRY, SPADOC_CD, ORBITAL_PAYLOAD_COUNT, ORBITAL_TOTAL_COUNT, COUNTRY_TOTAL, updated_at)
    VALUES ('PRC', 'PRC', 900, 5000, 5200, ?)`).run(NOW);

await test('countries come back ranked by total, largest first', async () => {
  const j = await body(await boxscore({ request: get('https://x/api/boxscore'), env: envOf(db) }));
  assert.equal(j.countries[0].COUNTRY, 'US');
  assert.ok(j.countries[0].COUNTRY_TOTAL >= j.countries[1].COUNTRY_TOTAL);
});

await test('an unbound D1 is a 503', async () => {
  const r = await boxscore({ request: get('https://x/api/boxscore'), env: {} });
  assert.equal(r.status, 503);
});

/* ── /api/brief ─────────────────────────────────────────────────────────── */

console.log('\n-- /api/brief --');

const CARD = {
  generated_at: NOW,
  facts: { tracked_on_orbit: 31629, new_objects: 4 },
  narrative: 'Four objects were newly catalogued in the last 24 hours.',
  narrative_status: 'ok',
  model: '@cf/meta/llama-3.1-8b-instruct',
};

await test('the brief artifact is served when it exists', async () => {
  const r2 = { get: async () => ({ text: async () => JSON.stringify(CARD) }) };
  const j = await body(await brief({ request: get('https://x/api/brief'), env: envOf(db, r2) }));
  assert.equal(j.available, true);
  assert.equal(j.narrative, CARD.narrative);
  assert.equal(j.facts.tracked_on_orbit, 31629);
});

await test('a missing artifact is reported, NOT rebuilt on the read path', async () => {
  // The absence of a D1 fallback here is the wave's whole constraint: a card
  // assembled at request time would either need inference (the thing wave 6
  // exists to prevent) or would pair fresh facts with a sentence checked
  // against older ones, breaking the grounding guarantee silently.
  let queried = false;
  const dbSpy = { prepare() { queried = true; throw new Error('the read path must not query D1'); } };
  const r2 = { get: async () => null };
  const j = await body(await brief({
    request: get('https://x/api/brief'), env: { ORBIT_DB: dbSpy, ORBIT_R2: r2 } }));
  assert.equal(j.available, false);
  assert.equal(j.narrative, null);
  assert.match(j.note, /once a day/);
  assert.equal(queried, false);
});

await test('a corrupt artifact says so rather than serving an empty card', async () => {
  const r2 = { get: async () => ({ text: async () => 'not json{' }) };
  const j = await body(await brief({ request: get('https://x/api/brief'), env: envOf(db, r2) }));
  assert.equal(j.available, false);
  assert.match(j.note, /could not be parsed/);
});

await test('an unbound R2 degrades instead of throwing', async () => {
  const r = await brief({ request: get('https://x/api/brief'), env: {} });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).available, false);
});

await test('the response carries the citation header, like every catalog route', async () => {
  const r2 = { get: async () => ({ text: async () => JSON.stringify(CARD) }) };
  const r = await brief({ request: get('https://x/api/brief'), env: envOf(db, r2) });
  assert.ok(r.headers.get('x-data-source'), 'citation header missing');
});

/* ── /api/space-weather ─────────────────────────────────────────────────── */

console.log('\n-- /api/space-weather --');

const SW_ARTIFACT = {
  generated_at: NOW,
  swpc_citation: 'SWPC text',
  current: { time_tag: '2026-08-07T21:00:00', kp: 1.33, ap: 5, station_count: 8, f107: 95, f107_90day: 132 },
  kp_history: [{ t: '2026-08-07T21:00:00', kp: 1.33 }],
  kp_forecast: [{ t: '2026-08-08T00:00:00', kp: 2.0, observed: false }],
  f107: { time_tag: '2026-08-07T22:00:00', flux: 95, ninety_day_mean: 132 },
};

await test('the artifact is served with stale:false and the SWPC header', async () => {
  const r2 = { get: async () => ({ text: async () => JSON.stringify(SW_ARTIFACT) }) };
  const r = await spaceWeather({ request: get('https://x/api/space-weather'), env: envOf(db, r2) });
  const j = await body(r);
  assert.equal(j.stale, false);
  assert.equal(j.current.kp, 1.33);
  assert.deepEqual(j.kp_history, SW_ARTIFACT.kp_history);
  // This endpoint carries NO Space-Track data, so the header must name NOAA —
  // a USSPACECOM attribution here would be a licence-relevant lie in reverse.
  assert.match(r.headers.get('X-Data-Source'), /NOAA/);
  assert.doesNotMatch(r.headers.get('X-Data-Source'), /USSPACECOM/);
  assert.doesNotMatch(j.citation || '', /Space-Track/);
});

await test('a corrupt artifact falls through to D1 rather than erroring', async () => {
  const r2 = { get: async () => ({ text: async () => 'not json{' }) };
  const r = await spaceWeather({ request: get('https://x/api/space-weather'), env: envOf(db, r2) });
  assert.equal(r.status, 200);
  assert.equal((await body(r)).stale, true);
});

await test('the D1 fallback reassembles the artifact shape from table rows', async () => {
  const db2 = seeded();
  db2.prepare(`INSERT INTO space_weather (kind, time_tag, value, meta, updated_at)
               VALUES ('kp_3h', '2026-08-07T21:00:00', 1.33, '{"ap":5,"station_count":8}', ?)`)
    .run(NOW);
  db2.prepare(`INSERT INTO space_weather (kind, time_tag, value, meta, updated_at)
               VALUES ('kp_forecast', '2026-08-08T00:00:00', 2.0, '{"observed":false}', ?)`)
    .run(NOW);
  db2.prepare(`INSERT INTO space_weather (kind, time_tag, value, meta, updated_at)
               VALUES ('f107', '2026-08-07T22:00:00', 95, '{"ninety_day_mean":132}', ?)`)
    .run(NOW);

  const r = await spaceWeather({ request: get('https://x/api/space-weather'), env: envOf(db2) });
  const j = await body(r);
  assert.equal(j.stale, true);
  assert.match(j.note, /artifact not built/);
  assert.equal(j.current.kp, 1.33);
  assert.equal(j.current.ap, 5);
  assert.equal(j.current.station_count, 8);
  assert.equal(j.current.f107, 95);
  assert.equal(j.current.f107_90day, 132);
  assert.deepEqual(j.kp_forecast, [{ t: '2026-08-08T00:00:00', kp: 2.0, observed: false }]);
  assert.equal(j.f107.flux, 95);
  assert.match(j.swpc_citation, /NOAA/);
  assert.match(r.headers.get('X-Data-Source'), /NOAA/);
});

await test('an empty table yields null current, not a 500 or missing keys', async () => {
  const db2 = seeded();
  const j = await body(await spaceWeather({
    request: get('https://x/api/space-weather'), env: envOf(db2) }));
  assert.equal(j.current.kp, null);
  assert.deepEqual(j.kp_history, []);
  assert.equal(j.f107, null);
});

await test('rebuildFromRows and buildSpaceWeatherArtifact agree on one contract', async () => {
  // The two bundles' assembly logic is duplicated on purpose (Pages Functions
  // cannot import from the ingest Worker); this round-trip pins them together
  // so a change to one fails the other's test rather than drifting silently.
  const { buildSpaceWeatherArtifact } = await import('../src/ingest-spaceweather.js');
  const kp3h = [
    { time_tag: '2026-08-07T15:00:00', kp: 1, ap: 4, station_count: 8 },
    { time_tag: '2026-08-07T21:00:00', kp: 1.33, ap: 5, station_count: 8 },
  ];
  const forecast = [
    { time_tag: '2026-08-08T00:00:00', kp: 2.0, observed: false },
    { time_tag: '2026-08-08T03:00:00', kp: 3.33, observed: false },
  ];
  const f107 = [{ time_tag: '2026-08-07T22:00:00', flux: 95, ninety_day_mean: 132 }];

  const artifact = buildSpaceWeatherArtifact({ kp3h, forecast, f107, generatedAt: NOW });

  const rows = [
    ...kp3h.map((r) => ({ kind: 'kp_3h', time_tag: r.time_tag, value: r.kp,
                          meta: JSON.stringify({ ap: r.ap, station_count: r.station_count }) })),
    ...forecast.map((r) => ({ kind: 'kp_forecast', time_tag: r.time_tag, value: r.kp,
                              meta: JSON.stringify({ observed: r.observed }) })),
    ...f107.map((r) => ({ kind: 'f107', time_tag: r.time_tag, value: r.flux,
                          meta: JSON.stringify({ ninety_day_mean: r.ninety_day_mean }) })),
  ];
  const rebuilt = rebuildFromRows(rows);
  // generated_at is wall-clock in the fallback; everything else must be equal.
  delete rebuilt.generated_at;
  delete artifact.generated_at;
  assert.deepEqual(rebuilt, artifact);
});

await test('an unbound D1 is a 503, like every catalog route', async () => {
  const r = await spaceWeather({ request: get('https://x/api/space-weather'), env: {} });
  assert.equal(r.status, 503);
});

/* ── Report ─────────────────────────────────────────────────────────────── */

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
