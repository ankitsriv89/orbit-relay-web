/**
 * derive.js + operators.js + jsonstream.js — no network, no wrangler.
 *
 *     node workers/orbit-ingest/test/derive.test.mjs
 *
 * These target the failure modes that are silent in production:
 *
 *   - column/value misalignment in the upsert (writes RCS_SIZE into SITE and
 *     nothing throws);
 *   - Space-Track's all-strings JSON reaching D1 uncoerced, so
 *     `PERIOD BETWEEN 1430 AND 1450` compares text and quietly returns nothing;
 *   - the 3LE '0 ' name prefix leaking into the globe's labels;
 *   - a group slug existing in one of the two places it must exist in;
 *   - the citation string drifting between the Worker and the Pages copy,
 *     which is a licence problem rather than a cosmetic one;
 *   - the streaming parser splitting a row across a network chunk boundary.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CITATION, SWPC_CITATION, GROUPS, GP_PREDICATES, OBJECT_COLUMNS, OBJECT_UPSERT_SQL,
  DERIVED_COLUMNS, regimeOf, launchYearOf, debrisFamilyOf, deriveObjectRow,
  groupByLaunch, computeLaunchEntry,
  toThreeLine, groupKey,
} from '../src/derive.js';
import { operatorFor, OPERATORS } from '../src/operators.js';
import { streamJsonRows, collectJsonRows } from '../src/jsonstream.js';
import { chunkedResponse } from './fakes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const fixture = (n) => JSON.parse(fs.readFileSync(path.join(HERE, '../fixtures', n), 'utf8'));

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS  ' + name); }
  catch (e) { results.push(false); console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); }
}

/* ── Regime ─────────────────────────────────────────────────────────────── */

console.log('\n-- orbit regime (Space-Track\'s own thresholds) --');

await test('LEO / MEO / GEO / HEO land where the documented queries put them', () => {
  assert.equal(regimeOf({ PERIOD: 92.9, ECCENTRICITY: 0.0004 }), 'LEO');   // ISS
  assert.equal(regimeOf({ PERIOD: 717.9, ECCENTRICITY: 0.0002 }), 'MEO');  // GPS
  assert.equal(regimeOf({ PERIOD: 1436.1, ECCENTRICITY: 0.0002 }), 'GEO'); // geostationary
  assert.equal(regimeOf({ PERIOD: 717.7, ECCENTRICITY: 0.74 }), 'HEO');    // Molniya
});

await test('a GTO is HEO, not MEO — eccentricity is tested before period', () => {
  // Period ~630 min would read as MEO on period alone, and a transfer orbit
  // drawn as a circular MEO shell is visibly wrong on a globe.
  assert.equal(regimeOf({ PERIOD: 630, ECCENTRICITY: 0.73 }), 'HEO');
});

await test('a missing or zero period yields null rather than a wrong bucket', () => {
  assert.equal(regimeOf({ PERIOD: null, ECCENTRICITY: 0.1 }), null);
  assert.equal(regimeOf({ PERIOD: '', ECCENTRICITY: '' }), null);
});

await test('every fixture row classifies, and Vanguard 1 lands on the right side', () => {
  const rows = fixture('sample_gp.json');
  for (const r of rows) assert.ok(regimeOf(r), `${r.OBJECT_NAME} unclassified`);
  // Vanguard 1 is the useful edge case in the fixture: 653 x 3817 km, so
  // period 132.6 min (just past the 128 LEO cutoff) at e=0.184 (just under the
  // 0.25 HEO cutoff). Both thresholds are Space-Track's, and by them it is MEO.
  // If either boundary is ever "tidied", this is the row that notices.
  const v = rows.find((r) => Number(r.NORAD_CAT_ID) === 5);
  assert.equal(regimeOf(v), 'MEO', `e=${v.ECCENTRICITY} period=${v.PERIOD}`);
});

console.log('\n-- launch year and debris family --');

await test('launch year survives nulls and malformed dates', () => {
  assert.equal(launchYearOf('1958-03-17'), 1958);
  assert.equal(launchYearOf(null), null);
  assert.equal(launchYearOf('unknown'), null);
});

await test('debris family is the launch designator every fragment inherits', () => {
  assert.equal(debrisFamilyOf('1999-025DKV'), '1999-025');  // Fengyun-1C debris
  assert.equal(debrisFamilyOf('1999-025A'), '1999-025');    // and its parent
  assert.equal(debrisFamilyOf(null), null);
});

/* ── Row derivation ─────────────────────────────────────────────────────── */

console.log('\n-- row derivation --');

await test('the value array aligns with OBJECT_COLUMNS position for position', () => {
  const gp = fixture('sample_gp.json')[0];
  const v = deriveObjectRow(gp, '2026-07-26T00:00:00Z');
  assert.equal(v.length, OBJECT_COLUMNS.length);
  const at = (c) => v[OBJECT_COLUMNS.indexOf(c)];
  assert.equal(at('NORAD_CAT_ID'), 5);
  assert.equal(at('OBJECT_NAME'), 'VANGUARD 1');
  assert.equal(at('SITE'), 'AFETR');
  assert.equal(at('RCS_SIZE'), 'MEDIUM');
  assert.equal(at('TLE_LINE1'), gp.TLE_LINE1);
});

await test('numeric fields are coerced — D1 must compare numbers, not text', () => {
  // Space-Track sends "PERIOD": "132.594". Stored as text, the geo predicate
  // BETWEEN 1430 AND 1450 does a string comparison and silently matches nothing.
  const v = deriveObjectRow(fixture('sample_gp.json')[0], 'now');
  const at = (c) => v[OBJECT_COLUMNS.indexOf(c)];
  for (const c of ['NORAD_CAT_ID', 'PERIOD', 'ECCENTRICITY', 'INCLINATION',
                   'APOAPSIS', 'PERIAPSIS', 'SEMIMAJOR_AXIS', 'BSTAR', 'FILE']) {
    assert.equal(typeof at(c), 'number', `${c} is ${typeof at(c)}`);
  }
  assert.equal(at('PERIOD'), 132.594);
});

await test('a null DECAY_DATE stays null and does not become the string "null"', () => {
  const v = deriveObjectRow(fixture('sample_gp.json')[0], 'now');
  assert.equal(v[OBJECT_COLUMNS.indexOf('DECAY_DATE')], null);
});

await test('derived columns are filled from the row, not left undefined', () => {
  const v = deriveObjectRow(
    { NORAD_CAT_ID: '44713', OBJECT_NAME: 'STARLINK-1007', OBJECT_ID: '2019-074A',
      PERIOD: '95.6', ECCENTRICITY: '0.0001', LAUNCH_DATE: '2019-11-11' },
    '2026-07-26T00:00:00Z');
  const at = (c) => v[OBJECT_COLUMNS.indexOf(c)];
  assert.equal(at('regime'), 'LEO');
  assert.equal(at('launch_year'), 2019);
  assert.equal(at('debris_family'), '2019-074');
  assert.equal(at('operator'), 'starlink');
  assert.equal(at('first_seen'), '2026-07-26T00:00:00Z');
});

await test('every fixture row derives without throwing', () => {
  for (const r of fixture('sample_gp.json')) {
    assert.equal(deriveObjectRow(r, 'now').length, OBJECT_COLUMNS.length);
  }
});

console.log('\n-- the upsert --');

await test('first_seen is never overwritten — the new-object feed depends on it', () => {
  assert.ok(!/first_seen = excluded/.test(OBJECT_UPSERT_SQL), OBJECT_UPSERT_SQL);
  assert.ok(/updated_at = excluded\.updated_at/.test(OBJECT_UPSERT_SQL));
});

await test('placeholder count matches the column count', () => {
  const holes = (OBJECT_UPSERT_SQL.match(/\?/g) || []).length;
  assert.equal(holes, OBJECT_COLUMNS.length);
});

await test('the statement stays inside D1\'s 100-bound-parameter cap', () => {
  assert.ok(OBJECT_COLUMNS.length <= 100, `${OBJECT_COLUMNS.length} columns`);
});

/* ── Predicates ─────────────────────────────────────────────────────────── */

console.log('\n-- the predicates projection --');

await test('every predicate we request exists in modeldef/class/gp', () => {
  // A name that does not exist upstream is a hard 400 on every ingest.
  const up = new Set(fixture('modeldef_gp.json').data.map((f) => f.Field));
  const bogus = GP_PREDICATES.filter((p) => !up.has(p));
  assert.deepEqual(bogus, []);
});

await test('the projection covers every upstream column the schema stores', () => {
  const wanted = OBJECT_COLUMNS.filter((c) => !DERIVED_COLUMNS.has(c));
  assert.deepEqual([...GP_PREDICATES].sort(), [...wanted].sort());
});

await test('the constant OMM envelope fields are not requested', () => {
  for (const f of ['CCSDS_OMM_VERS', 'COMMENT', 'ORIGINATOR', 'CENTER_NAME',
                   'REF_FRAME', 'TIME_SYSTEM', 'MEAN_ELEMENT_THEORY']) {
    assert.ok(!GP_PREDICATES.includes(f), f);
  }
});

/* ── Groups ─────────────────────────────────────────────────────────────── */

console.log('\n-- group definitions --');

const tleJs = fs.readFileSync(path.join(ROOT, 'functions/api/tle.js'), 'utf8');
const allowed = new Set(
  (/const ALLOWED_GROUPS = new Set\(\[([\s\S]*?)\]\)/.exec(tleJs)[1].match(/'([^']+)'/g) || [])
    .map((s) => s.slice(1, -1)));

await test('every group the API accepts has a definition that can build its bundle', () => {
  // Otherwise ?source=spacetrack&group=X passes validation and then 404s on R2.
  const missing = [...allowed].filter((g) => !GROUPS[g]);
  assert.deepEqual(missing, []);
});

await test('every group we build is a group the API will serve', () => {
  const orphan = Object.keys(GROUPS).filter((g) => !allowed.has(g));
  assert.deepEqual(orphan, []);
});

await test('every group checkbox in the page maps to a group we build', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/orbit/index.html'), 'utf8');
  const slugs = [...html.matchAll(/data-group="([^"]+)"/g)]
    .map((m) => m[1].toLowerCase())
    // stations-other is a visibility toggle over the already-loaded stations
    // group, not a fetchable group of its own.
    .filter((s) => s !== 'stations-other');
  const missing = slugs.filter((s) => !GROUPS[s]);
  assert.deepEqual(missing, []);
});

await test('group predicates are all single-quoted SQL with no bind holes', () => {
  // These are interpolated into the SELECT, so a stray ? or a double quote
  // would break the statement rather than bind anything.
  for (const [slug, g] of Object.entries(GROUPS)) {
    assert.ok(!g.where.includes('?'), `${slug} uses a placeholder`);
    assert.ok(!g.where.includes('"'), `${slug} uses double quotes`);
  }
});

await test('the three approximate groups are flagged so the UI can label them', () => {
  const approx = Object.entries(GROUPS).filter(([, g]) => g.approximate).map(([k]) => k);
  assert.deepEqual(approx.sort(), ['glo-ops', 'military', 'sbas']);
});

await test('R2 keys match the path the Pages Function reads', () => {
  assert.equal(groupKey('starlink'), 'tle/spacetrack/starlink.txt');
  assert.ok(tleJs.includes('`tle/spacetrack/${group}.txt`'));
});

/* ── 39: Launch history per-launch grouping ──────────────────────────────── */

console.log('\n-- launch history grouping (plan 39) --');

await test('groupByLaunch groups objects by YYYY-NNN prefix of OBJECT_ID', () => {
  const rows = [
    { OBJECT_ID: '2020-012A', OBJECT_TYPE: 'PAYLOAD' },
    { OBJECT_ID: '2020-012B', OBJECT_TYPE: 'ROCKET BODY' },
    { OBJECT_ID: '2020-012C', OBJECT_TYPE: 'DEBRIS' },
    { OBJECT_ID: '2021-034D', OBJECT_TYPE: 'PAYLOAD' },
  ];
  const byLaunch = groupByLaunch(rows);
  assert.equal(byLaunch.size, 2);
  assert.equal(byLaunch.get('2020-012')?.length, 3);
  assert.equal(byLaunch.get('2021-034')?.length, 1);
});

await test('computeLaunchEntry rolls up payload + rocket body + debris into one row', () => {
  const group = [
    { OBJECT_ID: '2020-012A', OBJECT_TYPE: 'PAYLOAD', LAUNCH_DATE: '2020-01-12', SITE: 'KSC' },
    { OBJECT_ID: '2020-012B', OBJECT_TYPE: 'ROCKET BODY', LAUNCH_DATE: '2020-01-12', SITE: 'KSC' },
    { OBJECT_ID: '2020-012C', OBJECT_TYPE: 'DEBRIS', LAUNCH_DATE: '2020-01-12', SITE: 'KSC' },
  ];
  const siteMap = new Map([['KSC', 'Kennedy Space Center']]);
  const entry = computeLaunchEntry(group, siteMap);
  assert.equal(entry.n, 3, `expected n=3, got ${entry.n}`);
  assert.equal(entry.launch_date, '2020-01-12');
  assert.equal(entry.site, 'Kennedy Space Center');
  assert.equal(entry.typeBreakdown.PAYLOAD, 1);
  assert.equal(entry.typeBreakdown['ROCKET BODY'], 1);
  assert.equal(entry.typeBreakdown.DEBRIS, 1);
});

await test('computeLaunchEntry handles single-type groups', () => {
  const group = [
    { OBJECT_ID: '2020-012A', OBJECT_TYPE: 'PAYLOAD', LAUNCH_DATE: '2020-01-12', SITE: 'KSC' },
  ];
  const siteMap = new Map([['KSC', 'Kennedy Space Center']]);
  const entry = computeLaunchEntry(group, siteMap);
  assert.equal(entry.n, 1);
  assert.equal(entry.typeBreakdown.PAYLOAD, 1);
  assert.equal(entry.typeBreakdown['ROCKET BODY'], 0);
  assert.equal(entry.typeBreakdown.DEBRIS, 0);
});

await test('computeLaunchEntry handles missing SITE gracefully', () => {
  const group = [
    { OBJECT_ID: '2020-012A', OBJECT_TYPE: 'PAYLOAD', LAUNCH_DATE: '2020-01-12' },
  ];
  const siteMap = new Map();
  const entry = computeLaunchEntry(group, siteMap);
  assert.equal(entry.n, 1);
  assert.equal(entry.site, '');
});

/* ── 3LE rendering ──────────────────────────────────────────────────────── */

console.log('\n-- 3LE bundles --');

await test('the name line is OBJECT_NAME, never the 3LE-prefixed TLE_LINE0', () => {
  // TLE_LINE0 is "0 VANGUARD 1". parseTLE takes lines in threes and shows the
  // first as the label, so shipping line 0 verbatim labels everything "0 ...".
  const row = fixture('sample_gp.json')[0];
  const out = toThreeLine([row]).split('\n');
  assert.equal(out[0], 'VANGUARD 1');
  assert.ok(!out[0].startsWith('0 '), out[0]);
  assert.equal(out[1], row.TLE_LINE1);
  assert.equal(out[2], row.TLE_LINE2);
});

await test('rows without TLE lines are skipped rather than emitted as blanks', () => {
  // A 2-line group entry would desynchronise parseTLE's fixed stride of 3 and
  // corrupt every satellite after it.
  const rows = [{ OBJECT_NAME: 'A', TLE_LINE1: '1 x', TLE_LINE2: '2 x' },
                { OBJECT_NAME: 'B', TLE_LINE1: null, TLE_LINE2: null },
                { OBJECT_NAME: 'C', TLE_LINE1: '1 z', TLE_LINE2: '2 z' }];
  const lines = toThreeLine(rows).trim().split('\n');
  assert.equal(lines.length, 6);
  assert.equal(lines.length % 3, 0);
});

await test('an empty set renders empty, so the caller can refuse to overwrite', () => {
  assert.equal(toThreeLine([]), '');
});

/* ── Operators ──────────────────────────────────────────────────────────── */

console.log('\n-- operator inference (our data, not Space-Track\'s) --');

await test('the constellations we actually partition by are matched', () => {
  assert.equal(operatorFor('STARLINK-1007'), 'starlink');
  assert.equal(operatorFor('ONEWEB-0123'), 'oneweb');
  assert.equal(operatorFor('IRIDIUM 106'), 'iridium');
  assert.equal(operatorFor('FLOCK 4V 1'), 'planet');
  assert.equal(operatorFor('LEMUR-2 ZACHARY'), 'spire');
  assert.equal(operatorFor('NAVSTAR 80 (USA 309)'), 'gps');
  assert.equal(operatorFor('GSAT0210 (GALILEO 20)'), 'galileo');
});

await test('an unknown name yields null — a wrong operator is worse than none', () => {
  assert.equal(operatorFor('COSMOS 2569'), null);
  assert.equal(operatorFor('SL-1 R/B'), null);
  assert.equal(operatorFor(null), null);
  assert.equal(operatorFor(''), null);
});

await test('patterns are anchored, so a substring match cannot claim an object', () => {
  assert.equal(operatorFor('PLEIADES 1A'), null, 'unanchored /SES/ would claim this');
  assert.equal(operatorFor('COSMOS 2251 DEB'), null);
});

await test('operator ids are unique', () => {
  const ids = OPERATORS.map(([id]) => id);
  assert.equal(new Set(ids).size, ids.length);
});

/* ── Citation ───────────────────────────────────────────────────────────── */

console.log('\n-- the citation (a condition of the approval, not a credit) --');

await test('the Worker and Pages copies of the citation are byte-identical', () => {
  // Read as text and concatenate the literals rather than importing: the Pages
  // copy must stay a standalone module with no dependency on this Worker, and
  // that independence is exactly what makes the drift possible.
  const pages = fs.readFileSync(path.join(ROOT, 'functions/api/_orbit.js'), 'utf8');
  const m = /export const CITATION =\s*([\s\S]*?);\n/.exec(pages);
  assert.ok(m, 'no CITATION in functions/api/_orbit.js');
  const theirs = (m[1].match(/'((?:[^'\\]|\\.)*)'/g) || [])
    .map((s) => s.slice(1, -1)).join('');
  assert.equal(theirs, CITATION);
});

await test('the SWPC citation is byte-identical across bundles too', () => {
  // The second provider (plan 34 §3.4) carries the same duplication risk as
  // the Space-Track string: functions/api/_orbit.js and this Worker are
  // separate bundles, and a silently diverged attribution on the
  // /api/space-weather response would be a data-source lie.
  const pages = fs.readFileSync(path.join(ROOT, 'functions/api/_orbit.js'), 'utf8');
  const m = /export const SWPC_CITATION =\s*([\s\S]*?);\n/.exec(pages);
  assert.ok(m, 'no SWPC_CITATION in functions/api/_orbit.js');
  const theirs = (m[1].match(/'((?:[^'\\]|\\.)*)'/g) || [])
    .map((s) => s.slice(1, -1)).join('');
  assert.equal(theirs, SWPC_CITATION);
});

await test('the citation names Space-Track and the approving command', () => {
  assert.match(CITATION, /Space-Track\.org/);
  assert.match(CITATION, /USSPACECOM/);
});

await test('the SWPC citation names NOAA and is public-domain, not a condition', () => {
  assert.match(SWPC_CITATION, /NOAA/);
  assert.match(SWPC_CITATION, /public domain/);
});

await test('the SWPC citation is pure ASCII — it ships in an HTTP header', () => {
  // Unlike the body, `X-Data-Source` must be a ByteString: the first draft
  // carried an em dash (U+2014), and `new Headers` threw "value greater than
  // 255" on EVERY /api/space-weather response. This pins the constraint that
  // caught it.
  assert.doesNotMatch(SWPC_CITATION, /[^\x20-\x7e]/);
});

await test('BOTH pages carry a visible Space-Track attribution', () => {
  // Every byte /spacetrack/ renders comes from that catalog, so the citation is
  // no more optional there than on /orbit/.
  for (const page of ['public/orbit/index.html', 'public/spacetrack/index.html']) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    assert.match(html, /orbital-footer__cite/, page);
    assert.match(html, /Space-Track\.org/, page);
  }
});

await test('SPACE-TRACK is a link to its own page, not an in-place switch', () => {
  // Wave 2 enabled a source button that had to call location.reload(), because
  // the ISS, the other stations and the Starlink batch are built outside
  // layerState and could not be re-sourced in place. Wave 3 replaced it with a
  // page. A <button class="source-btn"> reappearing here means that switch —
  // and the reload — came back.
  const html = fs.readFileSync(path.join(ROOT, 'public/orbit/index.html'), 'utf8');
  const link = /<a class="source-btn[^"]*" data-source="spacetrack"[^>]*>/.exec(html);
  assert.ok(link, 'no anchor for the spacetrack source');
  assert.match(link[0], /href="\/spacetrack\/"/);
  assert.doesNotMatch(html, /<button class="source-btn"/);
});

/* ── Streaming parser ───────────────────────────────────────────────────── */

console.log('\n-- streaming JSON (bounded memory over a 10-20 MB response) --');

const gpText = fs.readFileSync(path.join(HERE, '../fixtures/sample_gp.json'), 'utf8');

await test('streamed rows equal JSON.parse of the same payload', async () => {
  const rows = await collectJsonRows(chunkedResponse(gpText).body);
  assert.deepEqual(rows, JSON.parse(gpText));
});

await test('a row split across chunk boundaries still parses (1-byte chunks)', async () => {
  // The real failure this guards: a 10 MB response arrives in ~64 KB pieces and
  // an object straddles the seam. One byte at a time is the strongest version
  // of the same test.
  const rows = await collectJsonRows(chunkedResponse(gpText, 1).body);
  assert.deepEqual(rows, JSON.parse(gpText));
});

await test('braces and quotes inside string values do not move the depth counter', async () => {
  const payload = JSON.stringify([
    { OBJECT_NAME: 'WEIRD {NAME} "QUOTED"', TLE_LINE1: '1 a\\b' },
    { OBJECT_NAME: 'PLAIN' },
  ]);
  assert.deepEqual(await collectJsonRows(chunkedResponse(payload, 3).body),
                   JSON.parse(payload));
});

await test('a non-array response throws instead of ingesting silently', async () => {
  // Space-Track signals some errors with a bare object. Zero rows from one of
  // those is indistinguishable from "nothing changed" unless we refuse it.
  await assert.rejects(
    () => collectJsonRows(chunkedResponse('{"error":"query rate exceeded"}').body),
    /expected a JSON array/);
});

await test('an empty array streams zero rows without throwing', async () => {
  assert.deepEqual(await collectJsonRows(chunkedResponse('[]').body), []);
});

await test('the parser is lazy — it yields before the response is finished', async () => {
  // Proof that memory is bounded: the first row is available while the stream
  // is still open. A buffering implementation cannot do this.
  let closed = false;
  const stream = new ReadableStream({
    async pull(c) {
      if (closed) { c.close(); return; }
      c.enqueue(new TextEncoder().encode('[{"a":1}'));
      closed = true;
    },
  });
  const it = streamJsonRows(stream)[Symbol.asyncIterator]();
  assert.deepEqual((await it.next()).value, { a: 1 });
});

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
