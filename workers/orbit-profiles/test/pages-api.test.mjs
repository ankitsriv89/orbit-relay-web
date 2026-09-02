/**
 * The object-profile Pages Functions, against a real SQLite.
 *
 *     node --no-warnings workers/orbit-profiles/test/pages-api.test.mjs
 *
 * Lives in this package for the same reason its sibling in orbit-ingest does:
 * it tests functions/api/*, which is the READ side of the schema this package
 * owns the write side of. Both schemas (d1/orbit.sql + d1/profiles.sql) are
 * applied to node:sqlite; the Function modules are imported directly and called
 * with a faked context — no server.
 *
 * The degradation contract is the headline: PROFILE_DB unbound / row missing /
 * throwing all leave /api/object/<norad> answering 200 with profile: null.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const norm = (s) => s.replace(/\r\n/g, '\n');
const ORBIT_SCHEMA = norm(fs.readFileSync(path.join(ROOT, 'd1/orbit.sql'), 'utf8'));
const PROFILE_SCHEMA = norm(fs.readFileSync(path.join(ROOT, 'd1/profiles.sql'), 'utf8'));

const importFromRoot = (rel) => import(pathToFileURL(path.join(ROOT, rel)));
const dossier = (await importFromRoot('functions/api/object/[norad].js')).onRequest;
const profile = (await importFromRoot('functions/api/profile/[norad].js')).onRequest;
const objects = (await importFromRoot('functions/api/objects.js')).onRequest;

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS  ' + name); }
  catch (e) { results.push(false); console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); }
}

/* ── a D1-shaped binding over node:sqlite ──────────────────────────────── */
function localD1(db) {
  const n = (a) => a.map((v) => (v === undefined ? null : v));
  return {
    prepare(sql) {
      const stmt = { sql, args: [] };
      stmt.bind = (...a) => { stmt.args = n(a); return stmt; };
      stmt.all = async () => ({ results: db.prepare(sql).all(...stmt.args) });
      stmt.first = async () => db.prepare(sql).get(...stmt.args) ?? null;
      stmt.run = async () => { db.prepare(sql).run(...stmt.args); return { meta: {} }; };
      return stmt;
    },
  };
}
/** A PROFILE_DB whose every call throws — the third degradation case. */
const throwingD1 = { prepare() { return { bind() { return this; },
  all() { throw new Error('D1 exploded'); }, first() { throw new Error('D1 exploded'); } }; } };

const NOW = '2026-09-02T00:00:00.000Z';

function catalog() {
  const db = new DatabaseSync(':memory:');
  db.exec(ORBIT_SCHEMA);
  db.prepare(`INSERT INTO objects
      (NORAD_CAT_ID, OBJECT_NAME, OBJECT_ID, OBJECT_TYPE, COUNTRY_CODE, RCS_SIZE, SITE,
       LAUNCH_DATE, EPOCH, PERIOD, INCLINATION, APOAPSIS, PERIAPSIS, SEMIMAJOR_AXIS,
       TLE_LINE1, TLE_LINE2, regime, launch_year, operator, first_seen, updated_at)
      VALUES (25544,'ISS (ZARYA)','1998-067A','PAYLOAD','ISS','LARGE','TTMTR',
              '1998-11-20', ?, 92.9, 51.64, 422, 415, 6796.8,
              '1 25544U 98067A','2 25544  51.6','LEO',1998,'nasa', ?, ?)`).run(NOW, NOW, NOW);
  db.prepare(`INSERT INTO objects
      (NORAD_CAT_ID, OBJECT_NAME, OBJECT_ID, OBJECT_TYPE, COUNTRY_CODE, LAUNCH_DATE,
       EPOCH, regime, launch_year, first_seen, updated_at)
      VALUES (43013,'STARLINK-1','2018-020A','PAYLOAD','US','2018-02-22', ?, 'LEO', 2018, ?, ?)`)
    .run(NOW, NOW, NOW);
  return db;
}

function profilesDb({ withRow = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(PROFILE_SCHEMA);
  if (withRow) {
    db.prepare(`INSERT INTO profiles (norad, cospar, official_name, operator_name,
        owner_country, mission_type, status, prose, prose_tier, updated_at)
        VALUES (25544,'1998-067A','ISS (Zarya)','NASA / Roscosmos','International',
                'Engineering','operational','Zarya was the first ISS module.',3, ?)`).run(NOW);
    db.prepare(`INSERT INTO profile_fields (norad, field, source_id, source_url, confidence, updated_at)
        VALUES (25544,'operator_name','nssdca','https://nssdc.gsfc.nasa.gov/nmc/',1, ?)`).run(NOW);
    db.prepare(`INSERT INTO images (norad, r2_key, thumb_key, credit, license, source_url, is_primary, updated_at)
        VALUES (25544,'profiles/25544/primary.webp','profiles/25544/thumb.webp',
                'NASA','public-domain','https://images.nasa.gov/x',1, ?)`).run(NOW);
  }
  return db;
}

const get = (url) => new Request(url);
const P = (norad) => ({ norad: String(norad) });

console.log('\n-- the degradation contract: /api/object/<norad> --');

async function dossierBody(env) {
  const r = await dossier({ request: get('https://x/api/object/25544'), env, params: P(25544) });
  return { status: r.status, body: await r.json() };
}

let baseline;
test('baseline: PROFILE_DB absent ⇒ 200, profile: null', async () => {
  const { status, body } = await dossierBody({ ORBIT_DB: localD1(catalog()) });
  assert.equal(status, 200);
  assert.equal(body.profile, null);
  baseline = body;
});

test('PROFILE_DB present but the row is missing ⇒ 200, profile: null, body otherwise identical', async () => {
  const { status, body } = await dossierBody({
    ORBIT_DB: localD1(catalog()), PROFILE_DB: localD1(profilesDb({ withRow: false })),
  });
  assert.equal(status, 200);
  assert.equal(body.profile, null);
  assert.deepEqual({ ...body, profile: undefined }, { ...baseline, profile: undefined });
});

test('PROFILE_DB present but throwing ⇒ 200, profile: null, not 500', async () => {
  const { status, body } = await dossierBody({
    ORBIT_DB: localD1(catalog()), PROFILE_DB: throwingD1,
  });
  assert.equal(status, 200);
  assert.notEqual(status, 500);
  assert.equal(body.profile, null);
});

test('PROFILE_DB present with the row ⇒ 200, profile populated', async () => {
  const { status, body } = await dossierBody({
    ORBIT_DB: localD1(catalog()), PROFILE_DB: localD1(profilesDb()),
  });
  assert.equal(status, 200);
  assert.ok(body.profile);
  assert.equal(body.profile.profile.official_name, 'ISS (Zarya)');
  assert.ok(Array.isArray(body.profile.fields));
  assert.ok(Array.isArray(body.profile.images));
});

console.log('\n-- /api/profile/<norad> --');

test('503 when PROFILE_DB is unbound', async () => {
  const r = await profile({ request: get('https://x/api/profile/25544'), env: {}, params: P(25544) });
  assert.equal(r.status, 503);
});

test('404 when the profile row is missing', async () => {
  const r = await profile({
    request: get('https://x/api/profile/25544'),
    env: { PROFILE_DB: localD1(profilesDb({ withRow: false })) }, params: P(25544),
  });
  assert.equal(r.status, 404);
});

test('the {profile, fields, images} shape when present, with X-Data-Source', async () => {
  const r = await profile({
    request: get('https://x/api/profile/25544'),
    env: { PROFILE_DB: localD1(profilesDb()) }, params: P(25544),
  });
  assert.equal(r.status, 200);
  assert.ok(r.headers.get('X-Data-Source'));
  const body = await r.json();
  assert.equal(body.profile.official_name, 'ISS (Zarya)');
  assert.equal(body.fields[0].source_id, 'nssdca');
  assert.equal(body.images[0].is_primary, true);
});

test('a non-numeric NORAD segment is 400', async () => {
  const r = await profile({
    request: get('https://x/api/profile/25544;DROP'), env: { PROFILE_DB: localD1(profilesDb()) },
    params: { norad: '25544;DROP' },
  });
  assert.equal(r.status, 400);
});

console.log('\n-- /api/objects --');

function objectsDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(PROFILE_SCHEMA);
  const rows = [
    [1, '1998-067A', 'ISS', 'International', 'Engineering', 'NASA / Roscosmos', 'operational'],
    [2, '2018-020A', 'Starlink-1', 'United States', 'Communications', 'SpaceX', 'operational'],
    [3, '2019-074A', 'Starlink-2', 'United States', 'Communications', 'SpaceX', 'decayed'],
    [4, '1999-025A', 'Fengyun 1C', 'China', 'Meteorology', 'CMA', 'destroyed'],
  ];
  for (const [norad, cospar, name, country, type, op, status] of rows) {
    db.prepare(`INSERT INTO profiles (norad, cospar, official_name, owner_country,
        mission_type, operator_name, status, prose, prose_tier, updated_at)
        VALUES (?,?,?,?,?,?,?, 'x', 2, ?)`).run(norad, cospar, name, country, type, op, status, NOW);
  }
  return db;
}

test('returns the search-style envelope with operator_derived: true and X-Data-Source', async () => {
  const r = await objects({ request: get('https://x/api/objects?limit=10'),
    env: { PROFILE_DB: localD1(objectsDb()) } });
  assert.equal(r.status, 200);
  assert.ok(r.headers.get('X-Data-Source'));
  const body = await r.json();
  assert.equal(body.operator_derived, true);
  assert.equal(body.total, 4);
  assert.ok(Array.isArray(body.results));
  assert.equal(typeof body.limit, 'number');
});

test('facets cascade: picking a country narrows type/operator without collapsing the country list', async () => {
  const r = await objects({
    request: get('https://x/api/objects?facets=1&country=United States'),
    env: { PROFILE_DB: localD1(objectsDb()) },
  });
  const body = await r.json();
  const countryKeys = body.facets.country.map((f) => f.key);
  assert.ok(countryKeys.includes('China'), 'the country facet must still list every country');
  const typeKeys = body.facets.type.map((f) => f.key);
  assert.ok(typeKeys.includes('Communications'));
  assert.ok(!typeKeys.includes('Meteorology'), 'type facet is narrowed by the chosen country');
});

test('an unknown sort key is rejected, not interpolated', async () => {
  const r = await objects({
    request: get('https://x/api/objects?sort=norad;DROP TABLE profiles--'),
    env: { PROFILE_DB: localD1(objectsDb()) },
  });
  assert.equal(r.status, 400);
});

test('503 when PROFILE_DB is unbound', async () => {
  const r = await objects({ request: get('https://x/api/objects'), env: {} });
  assert.equal(r.status, 503);
});

process.on('exit', () => {
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  if (passed !== results.length) process.exitCode = 1;
});
