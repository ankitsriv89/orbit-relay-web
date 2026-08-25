/**
 * The daily brief — facts, prompt, grounding gate and artifact (plan 33 wave 6).
 *
 *     node workers/orbit-ingest/test/brief.test.mjs
 *
 * Two things are being proved here, and only one of them is ordinary.
 *
 * The ordinary one: `collectFacts()` runs against a **real SQLite** with
 * `d1/orbit.sql` applied, for the same reason the other three SQL suites do —
 * the failure mode of these queries is wrong rows, never an error, so a fake
 * that returns whatever it was told cannot catch a bad join.
 *
 * The one that matters: **the grounding gate must reject a fluent sentence with
 * an invented number in it.** That is the only failure this wave can produce
 * that nothing downstream would notice — a hallucinated figure looks exactly
 * like a correct one on the page, and it would sit next to columns of measured
 * data lending it credibility. So the model is stubbed with a deliberately
 * hallucinating one and the assertion is that the card ships *without* a
 * narrative rather than with a plausible fiction.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
  BRIEF_KEY, BRIEF_MODEL, MIN_NARRATIVE_CHARS, MAX_NARRATIVE_CHARS,
  BRIEF_INDEX_KEY, BRIEF_INDEX_DAYS, archiveKey, rebuildIndex,
  collectFacts, buildPrompt, allowedNumerals, checkNarrative, cleanNarrative,
  buildBrief, cardsEnabled, isQuiet, parseEpochUTC,
} from '../src/brief.js';
import { CITATION } from '../src/derive.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const SCHEMA = fs.readFileSync(path.join(ROOT, 'd1/orbit.sql'), 'utf8');

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS  ' + name); }
  catch (e) { results.push(false); console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); }
}

/* ── Harness ────────────────────────────────────────────────────────────── */

function localD1(db) {
  const norm = (a) => a.map((v) => (v === undefined ? null : v));
  return {
    prepare(sql) {
      const stmt = { sql, args: [] };
      stmt.bind = (...a) => { stmt.args = norm(a); return stmt; };
      stmt.all = async () => ({ results: db.prepare(sql).all(...stmt.args) });
      stmt.first = async () => db.prepare(sql).get(...stmt.args) ?? null;
      stmt.run = async () => { db.prepare(sql).run(...stmt.args); return { meta: {} }; };
      return stmt;
    },
  };
}

function fakeR2() {
  const puts = new Map();
  return {
    puts,
    async put(key, body, opts) { puts.set(key, { body, opts }); },
    async get(key) {
      const v = puts.get(key);
      return v ? { body: v.body, text: async () => String(v.body) } : null;
    },
    async list({ prefix = '' } = {}) {
      const objects = [...puts.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((key) => ({ key }));
      return { objects, truncated: false, cursor: undefined };
    },
  };
}

/** A model that returns exactly what it is told to. */
const stubAI = (reply) => {
  const calls = [];
  return {
    calls,
    async run(model, input) {
      calls.push({ model, input });
      if (reply instanceof Error) throw reply;
      return { response: typeof reply === 'function' ? reply(input) : reply };
    },
  };
};

const NOW = Date.parse('2026-07-28T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600_000).toISOString();

/**
 * DECAY_EPOCH in **Space-Track's own format**, not ISO-8601.
 *
 * This matters more than it looks. The class is `varchar(24)` upstream and the
 * values arrive as `2026-07-26 04:12:00` — space separated, no zone. Seeding
 * this table with `toISOString()` would be testing the horizon filter and the
 * day count against a shape production never sends, which is the exact gap that
 * let the GP `predicates/` bug through 151 green checks: the fixture was real
 * data, but not data from the query being exercised.
 */
const stEpoch = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const daysAhead = (d) => stEpoch(NOW + d * 86400_000);

function seed() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);

  const obj = (norad, name, type, country, regime, decayDate = null) =>
    db.prepare(`INSERT INTO objects
      (NORAD_CAT_ID, OBJECT_NAME, OBJECT_TYPE, COUNTRY_CODE, regime, DECAY_DATE, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(norad, name, type, country, regime, decayDate, hoursAgo(1));

  obj(25544, 'ISS (ZARYA)', 'PAYLOAD', 'ISS', 'LEO');
  obj(48274, 'STARLINK-2345', 'PAYLOAD', 'US', 'LEO');
  obj(48275, 'STARLINK-2346', 'PAYLOAD', 'US', 'LEO');
  obj(60001, 'CZ-6A DEB', 'DEBRIS', 'PRC', 'LEO');
  obj(60002, 'FALCON 9 R/B', 'ROCKET BODY', 'US', 'LEO');
  obj(11111, 'COSMOS 1408 DEB', 'DEBRIS', 'CIS', 'LEO', '2026-07-20');  // already down

  const event = (kind, norad, ts, title) =>
    db.prepare('INSERT INTO events (ts, kind, NORAD_CAT_ID, title) VALUES (?, ?, ?, ?)')
      .run(ts, kind, norad, title);

  event('new_object', 48274, hoursAgo(3), 'New object: STARLINK-2345');
  event('new_object', 48275, hoursAgo(5), 'New object: STARLINK-2346');
  event('new_object', 60001, hoursAgo(9), 'New object: CZ-6A DEB');
  event('new_object', 60002, hoursAgo(40), 'New object: FALCON 9 R/B'); // outside 24 h
  event('decay', 11111, hoursAgo(6), 'Decayed: COSMOS 1408 DEB');
  event('satcat_change', 25544, hoursAgo(2), 'SATCAT record changed');

  const decayMsg = (norad, name, msgEpoch, decayEpoch, source) =>
    db.prepare(`INSERT INTO decay
      (NORAD_CAT_ID, OBJECT_NAME, COUNTRY, MSG_EPOCH, DECAY_EPOCH, SOURCE, updated_at)
      VALUES (?, ?, 'US', ?, ?, ?, ?)`)
      .run(norad, name, msgEpoch, decayEpoch, source, hoursAgo(1));

  // Two messages for the same object: the later one moves the estimate later,
  // and only the later one may be used.
  decayMsg(60002, 'FALCON 9 R/B', hoursAgo(50), daysAhead(2), '60day_msg');
  decayMsg(60002, 'FALCON 9 R/B', hoursAgo(2), daysAhead(4), 'TIP');
  // Outside the 7-day horizon.
  decayMsg(48274, 'STARLINK-2345', hoursAgo(2), daysAhead(30), '60day_msg');
  // Already actually decayed — a stale prediction is noise.
  decayMsg(11111, 'COSMOS 1408 DEB', hoursAgo(2), daysAhead(1), '60day_msg');

  return localD1(db);
}

const envOf = (db, extra = {}) => ({ ORBIT_DB: db, ORBIT_R2: fakeR2(), ...extra });

/* ── Facts ──────────────────────────────────────────────────────────────── */

const db = seed();
const facts = await collectFacts(envOf(db), { now: NOW });

await test('on-orbit count excludes objects with a DECAY_DATE', async () => {
  assert.equal(facts.tracked_on_orbit, 5);
  assert.equal(facts.payloads, 3);
  assert.equal(facts.rocket_bodies, 1);
  assert.equal(facts.debris, 1);   // the decayed debris row is not counted
});

await test('new-object count is windowed to the last 24 h', async () => {
  assert.equal(facts.new_objects, 3);       // the 40-hour-old one is excluded
  assert.equal(facts.new_object_sample.length, 3);
  assert.equal(facts.new_object_sample[0].name, 'STARLINK-2345');
  assert.equal(facts.new_object_sample[0].country, 'US');
});

await test('registering states are tallied over the same window', async () => {
  assert.deepEqual(facts.new_object_countries, [{ code: 'US', n: 2 }, { code: 'PRC', n: 1 }]);
});

await test('decays are counted and named', async () => {
  assert.equal(facts.decays, 1);
  assert.equal(facts.decay_sample[0].norad, 11111);
});

await test('reentry watch takes the LATEST message per object', async () => {
  const watch = facts.reentry_watch.find((w) => w.norad === 60002);
  assert.ok(watch, 'the rocket body should be on the watch list');
  // The superseded 2-day message must not win over the 4-day one.
  assert.equal(watch.days_until, 4);
  assert.equal(watch.source, 'TIP');
});

await test('a historical decay is not a reentry prediction', async () => {
  // The `decay` table holds Space-Track's historical decay messages alongside
  // its forward predictions, and the live catalog really does carry Sputnik 1
  // at `1957-12-01 0:00:00`. With only an upper bound it sorted FIRST, under a
  // caption promising reentries within 7 days, with a countdown of -25,076 days.
  const hist = new DatabaseSync(':memory:');
  hist.exec(SCHEMA);
  const add = (norad, name, decayEpoch) => hist.prepare(
    `INSERT INTO decay (NORAD_CAT_ID, OBJECT_NAME, MSG_EPOCH, DECAY_EPOCH, SOURCE, updated_at)
     VALUES (?, ?, ?, ?, '60day_msg', ?)`)
    .run(norad, name, hoursAgo(1), decayEpoch, hoursAgo(1));

  add(1, 'SPUTNIK 1', '1958-01-03 0:00:00');
  add(2, 'SL-1 R/B', '1957-12-01 0:00:00');
  add(3, 'FALCON 9 R/B', `${new Date(NOW + 2 * 86400_000).toISOString().slice(0, 10)} 6:30:00`);

  const f = await collectFacts(envOf(localD1(hist)), { now: NOW });
  assert.deepEqual(f.reentry_watch.map((w) => w.norad), [3],
                   'only the forward prediction belongs on a watch list');
  assert.equal(f.reentry_watch[0].days_until, 2);
});

await test('reentry watch honours the horizon and skips objects already down', async () => {
  const norads = facts.reentry_watch.map((w) => w.norad);
  assert.ok(!norads.includes(48274), '30 days out is beyond the 7-day horizon');
  assert.ok(!norads.includes(11111), 'already has a DECAY_DATE — not a watch item');
  assert.equal(facts.reentry_watch.length, 1);
});

/* ── Epoch parsing, pinned to strings captured from PRODUCTION ──────────────
 *
 * Every one of these came out of a live `/api/decay-watch` response, not out of
 * a formatter in this file. That distinction is the whole point: the first fix
 * here generated its own fixtures with `toISOString().replace('T',' ')`, which
 * produces `00:00:00` — and Space-Track sends `0:00:00`, an **unpadded hour**
 * that is not valid ISO. Rewriting the string and re-parsing it therefore
 * returned NaN, and all 200 countdowns on the live endpoint went null. The
 * suite was green for both.
 */
const REAL_EPOCHS = [
  // [value as production sends it, expected UTC instant]
  ['1957-12-01 0:00:00', '1957-12-01T00:00:00.000Z'],
  ['1958-01-03 0:00:00', '1958-01-03T00:00:00.000Z'],
  ['2026-07-26 04:12:00', '2026-07-26T04:12:00.000Z'],
  ['2026-08-01 12:00:00', '2026-08-01T12:00:00.000Z'],
];

await test('epochs are parsed as UTC, unpadded hour and all', async () => {
  for (const [raw, want] of REAL_EPOCHS) {
    const got = parseEpochUTC(raw);
    assert.ok(!Number.isNaN(got), `${raw!== null ? JSON.stringify(raw) : raw} parsed to NaN`);
    assert.equal(new Date(got).toISOString(), want,
                 `${JSON.stringify(raw)} (TZ=${process.env.TZ || 'unset'})`);
  }
});

await test('an explicit zone is honoured, and junk is NaN not a wrong number', async () => {
  assert.equal(new Date(parseEpochUTC('2026-08-01T12:00:00Z')).toISOString(),
               '2026-08-01T12:00:00.000Z');
  assert.equal(parseEpochUTC('2026-08-01'), Date.UTC(2026, 7, 1), 'date-only is midnight UTC');
  for (const junk of [null, undefined, '', 'not a date']) {
    assert.ok(Number.isNaN(parseEpochUTC(junk)), `${JSON.stringify(junk)} should be NaN`);
  }
});

await test('both copies of the epoch parser agree — they cannot import each other', async () => {
  // brief.js (ingest side) and _catalog.js (Pages side) each own a copy because
  // neither half of the repo can import from the other. Two copies drifting is
  // exactly what produced the bug above, so agreement is asserted rather than
  // assumed.
  const { parseEpochUTC: pagesParse } = await import(pathToFileURL(path.join(ROOT, 'functions/api/_catalog.js')));
  for (const [raw] of REAL_EPOCHS) {
    assert.equal(pagesParse(raw), parseEpochUTC(raw), `disagree on ${JSON.stringify(raw)}`);
  }
  for (const junk of ['', 'not a date', '2026-08-01', '2026-08-01T12:00:00Z']) {
    const a = pagesParse(junk);
    const b = parseEpochUTC(junk);
    assert.equal(Number.isNaN(a), Number.isNaN(b), `disagree on NaN-ness of ${junk}`);
    if (!Number.isNaN(a)) assert.equal(a, b, `disagree on ${junk}`);
  }
});

await test('a real production epoch survives the whole facts path', async () => {
  // End to end rather than unit: the unpadded hour has to reach days_until.
  const live = new DatabaseSync(':memory:');
  live.exec(SCHEMA);
  const soon = new Date(NOW + 3 * 86400_000).toISOString().slice(0, 10);
  live.prepare(`INSERT INTO decay
      (NORAD_CAT_ID, OBJECT_NAME, MSG_EPOCH, DECAY_EPOCH, SOURCE, updated_at)
      VALUES (7000, 'SL-1 R/B', ?, ?, '60day_msg', ?)`)
    .run(hoursAgo(1), `${soon} 0:00:00`, hoursAgo(1));   // unpadded, as production sends
  const f = await collectFacts(envOf(localD1(live)), { now: NOW });
  assert.equal(f.reentry_watch.length, 1);
  assert.equal(f.reentry_watch[0].days_until, 3,
               'an unpadded hour must not null the countdown');
});

await test("the seeded epochs really are Space-Track's format, not ISO", async () => {
  // Guards the guard: if this fixture ever drifts to toISOString(), the horizon
  // filter below would be tested against a shape production never sends and the
  // suite would go green on a query that cannot work.
  assert.match(facts.reentry_watch[0].decay_epoch, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
               'DECAY_EPOCH is varchar(24) upstream: "2026-07-26 04:12:00"');
});

await test('a zone-less epoch is read as UTC, not as local time', async () => {
  // V8 parses '2026-07-26 04:12:00' as LOCAL time. On a UTC+5:30 box that is
  // 5.5 hours of skew through a ceil() — enough to report the wrong day. The
  // watch entry is 4 days out in UTC and must stay 4 whatever TZ this runs in.
  const w = facts.reentry_watch[0];
  assert.equal(w.days_until, 4, `days_until drifted with the host timezone (TZ=${process.env.TZ || 'unset'})`);
});

await test('the horizon filter is a date comparison, not a string-format accident', async () => {
  // An epoch LATER in the day than the horizon instant but on the horizon's own
  // date must still be included; one on the next day must not. Comparing whole
  // strings across two formats gets this right only by coincidence.
  const edge = new DatabaseSync(':memory:');
  edge.exec(SCHEMA);
  const add = (norad, decayEpoch) => edge.prepare(
    `INSERT INTO decay (NORAD_CAT_ID, OBJECT_NAME, MSG_EPOCH, DECAY_EPOCH, SOURCE, updated_at)
     VALUES (?, ?, ?, ?, '60day_msg', ?)`)
    .run(norad, `OBJ ${norad}`, hoursAgo(1), decayEpoch, hoursAgo(1));

  const horizonDate = new Date(NOW + 7 * 86400_000).toISOString().slice(0, 10);
  add(1, `${horizonDate} 23:59:00`);                                  // last moment inside
  add(2, stEpoch(NOW + 8 * 86400_000));                               // a day past
  const f = await collectFacts(envOf(localD1(edge)), { now: NOW });
  const got = f.reentry_watch.map((w) => w.norad);
  assert.deepEqual(got, [1], `expected only the in-horizon object, got ${JSON.stringify(got)}`);
});

await test('a day with no events is reported as quiet', async () => {
  const empty = new DatabaseSync(':memory:');
  empty.exec(SCHEMA);
  const f = await collectFacts(envOf(localD1(empty)), { now: NOW });
  assert.equal(isQuiet(f), true);
  assert.equal(isQuiet(facts), false);
});

/* ── Prompt ─────────────────────────────────────────────────────────────── */

await test('the prompt states every number the card may contain', async () => {
  const { system, user } = buildPrompt(facts);
  assert.match(user, /Objects currently on orbit: 5/);
  assert.match(user, /Newly catalogued in the last 24 hours: 3/);
  assert.match(user, /STARLINK-2345 \(catalog number 48274/);
  assert.match(system, /Use ONLY the numbers given in the data/);
  assert.match(system, /Never mention collisions/i);
});

await test('an empty reentry list says so rather than being omitted', async () => {
  const { user } = buildPrompt({ ...facts, reentry_watch: [] });
  assert.match(user, /No reentries are predicted within the next 7 days/);
});

/* ── The grounding gate ─────────────────────────────────────────────────── */

await test('allowed numerals come from values AND from inside strings', async () => {
  const allowed = allowedNumerals({
    tracked: 31629,
    name: 'STARLINK-2345',
    epoch: '2026-07-28T12:00:00Z',
  });
  assert.ok(allowed.has('31629'));
  assert.ok(allowed.has('2345'), 'digits inside a name are legitimately quotable');
  assert.ok(allowed.has('2026'));
  assert.ok(allowed.has('07') && allowed.has('7'), 'a zero-padded date admits the bare form');
  assert.ok(!allowed.has('99'));
});

const GOOD = 'Five objects are currently on orbit in the tracked slice, of which 3 are payloads. ' +
             'Three new objects were catalogued in the last 24 hours, two registered to US and one to PRC. ' +
             'One object decayed, and FALCON 9 R/B is predicted to reenter in about 4 days.';

await test('a grounded narrative passes', async () => {
  const v = checkNarrative(GOOD, facts);
  assert.equal(v.ok, true, v.reason || '');
});

await test('THE GATE: an invented number is rejected', async () => {
  const v = checkNarrative(
    'Three new objects were catalogued in the last 24 hours, bringing the total to 8842 payloads.',
    facts);
  assert.equal(v.ok, false);
  assert.match(v.reason, /unsupported number "8842"/);
});

await test('a number the model computed itself is rejected even if it is correct', async () => {
  // 3 new objects out of 5 tracked really is 60% — and it is still rejected,
  // because "the model did arithmetic" and "the model made it up" are
  // indistinguishable from the output alone.
  const v = checkNarrative(
    'Three new objects were catalogued today, which is 60 percent of the tracked slice, a notable share.',
    facts);
  assert.equal(v.ok, false);
    assert.match(v.reason, /unsupported number "60"/);
});

await test('a thousands separator is not treated as a different number', async () => {
  const f = { tracked_on_orbit: 31629, generated_at: '2026-07-28T00:00:00Z' };
  const v = checkNarrative(
    'The catalog held 31,629 objects on orbit at the start of 2026, a figure unchanged on the day.', f);
  assert.equal(v.ok, true, v.reason || '');
});

await test('a conjunction or collision claim is rejected on legal grounds', async () => {
  for (const text of [
    'Three new objects were catalogued, and one is on a collision course with another payload today.',
    'A close conjunction was detected between two of the newly catalogued objects in low Earth orbit.',
  ]) {
    const v = checkNarrative(text, facts);
    assert.equal(v.ok, false, `should reject: ${text}`);
    assert.match(v.reason, /conjunction\/collision/);
  }
});

await test('links and handles are rejected', async () => {
  const v = checkNarrative(
    'Three new objects were catalogued in the last 24 hours; see https://example.com for the full list.',
    facts);
  assert.equal(v.ok, false);
  assert.match(v.reason, /link or handle/);
});

await test('length bounds reject both a stub and an essay', async () => {
  assert.match(checkNarrative('Quiet day.', facts).reason, /too short/);
  assert.match(checkNarrative('', facts).reason, /empty/);
  const essay = ('The catalog was updated and three objects were added to it again. ')
    .repeat(Math.ceil(MAX_NARRATIVE_CHARS / 60) + 2);
  assert.match(checkNarrative(essay, facts).reason, /too long/);
  assert.ok(MIN_NARRATIVE_CHARS < MAX_NARRATIVE_CHARS);
});

await test('cleaning strips model wrappers without excusing them', async () => {
  const messy = 'Here is the paragraph:\n\n**Three new objects** were catalogued in the last 24 hours.\n' +
                'One object decayed during the same period today.';
  const cleaned = cleanNarrative(messy);
  assert.ok(!cleaned.includes('**'));
  assert.ok(!cleaned.startsWith('Here is'));
  assert.ok(!cleaned.includes('\n'));
  // Still has to pass the gate on its merits.
  assert.equal(checkNarrative(messy, facts).ok, true);
});


/* ── buildBrief read cost ─────────────────────────────────────────────────
 * Written before the fix and watched go red on the real bug (repo rule).
 *
 * The third instance of the same pattern, after buildAnalytics and
 * buildSummary. Measured 2026-08-26, once the events(kind, ts) index removed
 * the join that had been hiding it:
 *   SELECT OBJECT_TYPE AS k, COUNT(*) ... WHERE DECAY_DATE IS NULL GROUP BY k
 *   259,140 rows read, 4 calls, ratio 16,196
 * plus its sibling COUNT(*) over the same predicate. Two full catalog scans
 * for four numbers: tracked_on_orbit, payloads, rocket_bodies, debris.
 *
 * One pass answers both. The brief's OTHER queries are over `events`, which
 * is small and now properly indexed — this guardrail is about `objects`.
 */
function countingDb(db) {
  const seen = [];
  return {
    seen,
    prepare(sql) {
      seen.push(String(sql).replace(/\s+/g, ' ').trim());
      return db.prepare(sql);
    },
  };
}

await test('buildBrief walks the objects table once, not once per aggregate', async () => {
  const spy = countingDb(db);
  await buildBrief({ ORBIT_DB: spy, ORBIT_R2: fakeR2() }, { now: NOW });
  // Statements that SCAN objects — the events joins reference it by rowid via
  // LEFT JOIN, which is a seek per matched event, not a catalog walk.
  const scans = spy.seen.filter((q) => /FROM objects\b/i.test(q));
  assert.ok(scans.length <= 1,
    `expected <= 1 statement scanning objects, got ${scans.length}:\n` +
    scans.map((q) => '  ' + q.slice(0, 90)).join('\n'));
});

await test('the folded brief counts match the SQL aggregates they replaced', async () => {
  const env = envOf(db);
  const card = await buildBrief(env, { now: NOW });
  const live = 'WHERE DECAY_DATE IS NULL';
  // `db` here is the localD1 wrapper, so these go through its async API.
  const total = await db.prepare(`SELECT COUNT(*) AS n FROM objects ${live}`).first();
  assert.equal(card.facts.tracked_on_orbit, total.n);
  const typeRows = await db.prepare(
    `SELECT OBJECT_TYPE AS k, COUNT(*) AS n FROM objects ${live} GROUP BY k`).all();
  const byType = Object.fromEntries(
    typeRows.results.map((r) => [r.k || 'UNKNOWN', r.n]));
  assert.equal(card.facts.payloads, byType.PAYLOAD || 0);
  assert.equal(card.facts.rocket_bodies, byType['ROCKET BODY'] || 0);
  assert.equal(card.facts.debris, byType.DEBRIS || 0);
  // The three type buckets must not exceed the total they are drawn from —
  // a fold that counted decayed rows into the types but not the total would
  // pass the three asserts above on a fixture with no decays and still be wrong.
  assert.ok(card.facts.payloads + card.facts.rocket_bodies + card.facts.debris
            <= card.facts.tracked_on_orbit,
    'type buckets must be a subset of tracked_on_orbit');
});

await test('the brief reentry query uses NOT EXISTS, not GROUP BY MAX over decay', async () => {
  // `decay` holds Space-Track's HISTORICAL messages back to Sputnik 1, not
  // just forward predictions. A `JOIN (SELECT NORAD_CAT_ID, MAX(MSG_EPOCH)
  // ... GROUP BY NORAD_CAT_ID)` is correct but unplannable: SQLite cannot turn
  // it into an index walk and full-scans the table on every call. That exact
  // query cost 53.67M rows read at ratio 10,630 in /api/decay-watch and was
  // rewritten there (3445edf8) as a correlated NOT EXISTS, which walks the
  // (NORAD_CAT_ID, MSG_EPOCH) primary key. brief.js kept the old shape.
  const spy = countingDb(db);
  await buildBrief({ ORBIT_DB: spy, ORBIT_R2: fakeR2() }, { now: NOW });
  const decayQ = spy.seen.filter((q) => /FROM decay/i.test(q));
  assert.ok(decayQ.length > 0, 'the reentry query must still run');
  for (const q of decayQ) {
    assert.ok(!/MAX\(MSG_EPOCH\)/i.test(q),
      'GROUP BY MAX(MSG_EPOCH) full-scans decay - use a correlated NOT EXISTS:\n  ' + q.slice(0, 160));
  }
});

/* ── The artifact ───────────────────────────────────────────────────────── */

const readCard = (env) => JSON.parse(env.ORBIT_R2.puts.get(BRIEF_KEY).body);

await test('flag off: the card is still written, with facts and no model call', async () => {
  const ai = stubAI(GOOD);
  const env = envOf(db, { ORBIT_AI: ai });
  assert.equal(cardsEnabled(env), false);
  const card = await buildBrief(env, { now: NOW });
  assert.equal(ai.calls.length, 0, 'no inference may happen while the flag is off');
  assert.equal(card.narrative, null);
  assert.equal(card.narrative_status, 'disabled');
  assert.equal(card.facts.tracked_on_orbit, 5);
  assert.equal(readCard(env).facts.new_objects, 3);
});

await test('flag on with a sound model: the narrative is published', async () => {
  const ai = stubAI(GOOD);
  const env = envOf(db, { ORBIT_AI: ai, ORBIT_AI_CARDS: '1' });
  const card = await buildBrief(env, { now: NOW });
  assert.equal(ai.calls.length, 1);
  assert.equal(ai.calls[0].model, BRIEF_MODEL);
  assert.equal(card.narrative_status, 'ok');
  assert.equal(card.narrative, GOOD);
  assert.equal(card.model, BRIEF_MODEL);
});

await test('THE GATE, END TO END: a hallucinating model ships facts, not fiction', async () => {
  const ai = stubAI('A record 12,904 objects were catalogued in the last 24 hours, ' +
                    'the busiest day since the 1970s and a sharp rise on last week.');
  const env = envOf(db, { ORBIT_AI: ai, ORBIT_AI_CARDS: 'true' });
  const card = await buildBrief(env, { now: NOW });
  assert.equal(card.narrative, null, 'the invented figure must not reach the page');
  assert.match(card.narrative_status, /^rejected: unsupported number "12,904"/);
  // The card is still useful, and the rejection is on the record rather than
  // looking like a quiet day.
  assert.equal(card.facts.new_objects, 3);
  assert.equal(readCard(env).narrative_status, card.narrative_status);
});

await test('a model outage degrades the card instead of failing the ingest', async () => {
  const ai = stubAI(new Error('502 upstream'));
  const env = envOf(db, { ORBIT_AI: ai, ORBIT_AI_CARDS: '1' });
  const card = await buildBrief(env, { now: NOW });
  assert.match(card.narrative_status, /^error: 502 upstream/);
  assert.equal(card.facts.tracked_on_orbit, 5);
});

await test('flag on but no binding is reported, not crashed', async () => {
  const env = envOf(db, { ORBIT_AI: null, ORBIT_AI_CARDS: '1' });
  const card = await buildBrief(env, { now: NOW });
  assert.match(card.narrative_status, /unavailable/);
});

await test('a quiet day is never narrated — that is where filler comes from', async () => {
  const empty = new DatabaseSync(':memory:');
  empty.exec(SCHEMA);
  const ai = stubAI(GOOD);
  const env = envOf(localD1(empty), { ORBIT_AI: ai, ORBIT_AI_CARDS: '1' });
  const card = await buildBrief(env, { now: NOW });
  assert.equal(ai.calls.length, 0);
  assert.match(card.narrative_status, /nothing to report/);
});

await test('the artifact carries the citation and is JSON at the expected key', async () => {
  const env = envOf(db, { ORBIT_AI_CARDS: '0' });
  await buildBrief(env, { now: NOW });
  const put = env.ORBIT_R2.puts.get(BRIEF_KEY);
  assert.ok(put, `nothing written to ${BRIEF_KEY}`);
  assert.match(put.opts.httpMetadata.contentType, /application\/json/);
  assert.equal(put.opts.customMetadata.citation, CITATION);
  assert.equal(JSON.parse(put.body).citation, CITATION);
});

await test('the card labels its narrative as machine-written', async () => {
  const env = envOf(db);
  const card = await buildBrief(env, { now: NOW });
  assert.match(card.disclaimer, /language model/i);
  assert.match(card.disclaimer, /not by the model/i);
});

/* ── narrative_source ───────────────────────────────────────────────────── */

await test('narrative_source is "ai" only once a narrative clears the gate', async () => {
  const ai = stubAI(GOOD);
  const env = envOf(db, { ORBIT_AI: ai, ORBIT_AI_CARDS: '1' });
  const card = await buildBrief(env, { now: NOW });
  assert.equal(card.narrative_status, 'ok');
  assert.equal(card.narrative_source, 'ai');
});

await test('narrative_source is "none" for every non-ai outcome', async () => {
  // Flag off.
  assert.equal((await buildBrief(envOf(db), { now: NOW })).narrative_source, 'none');
  // Rejected by the gate.
  const hallucinating = stubAI('A record 12,904 objects were catalogued, the busiest day ever.');
  const rejected = await buildBrief(
    envOf(db, { ORBIT_AI: hallucinating, ORBIT_AI_CARDS: '1' }), { now: NOW });
  assert.equal(rejected.narrative_source, 'none');
  // Model outage.
  const broken = stubAI(new Error('502 upstream'));
  const errored = await buildBrief(
    envOf(db, { ORBIT_AI: broken, ORBIT_AI_CARDS: '1' }), { now: NOW });
  assert.equal(errored.narrative_source, 'none');
  // Quiet day, flag on.
  const empty = new DatabaseSync(':memory:');
  empty.exec(SCHEMA);
  const quiet = await buildBrief(
    envOf(localD1(empty), { ORBIT_AI: stubAI(GOOD), ORBIT_AI_CARDS: '1' }), { now: NOW });
  assert.equal(quiet.narrative_source, 'none');
});

/* ── Archive: brief/<date>.json + brief/index.json ─────────────────────── */

await test('buildBrief writes latest.json AND the day archive card, identical', async () => {
  const env = envOf(db, { ORBIT_AI_CARDS: '0' });
  const card = await buildBrief(env, { now: NOW });
  const date = card.generated_at.slice(0, 10);
  const archived = env.ORBIT_R2.puts.get(archiveKey(date));
  assert.ok(archived, `nothing written to ${archiveKey(date)}`);
  assert.deepEqual(JSON.parse(archived.body), card);
});

await test('buildBrief rebuilds the index after the day-card write', async () => {
  const env = envOf(db, { ORBIT_AI_CARDS: '0' });
  const card = await buildBrief(env, { now: NOW });
  const date = card.generated_at.slice(0, 10);
  const idx = JSON.parse(env.ORBIT_R2.puts.get(BRIEF_INDEX_KEY).body);
  assert.equal(idx.total, 1);
  assert.equal(idx.days.length, 1);
  assert.equal(idx.days[0].date, date);
  assert.equal(idx.days[0].new_objects, card.facts.new_objects);
  assert.equal(idx.days[0].decays, card.facts.decays);
  assert.equal(idx.days[0].narrative_source, 'none');
});

await test('the index carries a headline (first sentence) when a narrative shipped', async () => {
  const ai = stubAI(GOOD);
  const env = envOf(db, { ORBIT_AI: ai, ORBIT_AI_CARDS: '1' });
  await buildBrief(env, { now: NOW });
  const idx = JSON.parse(env.ORBIT_R2.puts.get(BRIEF_INDEX_KEY).body);
  assert.equal(idx.days[0].narrative_source, 'ai');
  assert.equal(idx.days[0].headline, GOOD.split(/(?<=[.!?])\s+/)[0]);
});

await test('a day with no narrative has a null headline, not a blank string', async () => {
  const env = envOf(db, { ORBIT_AI_CARDS: '0' });
  await buildBrief(env, { now: NOW });
  const idx = JSON.parse(env.ORBIT_R2.puts.get(BRIEF_INDEX_KEY).body);
  assert.equal(idx.days[0].headline, null);
});

await test('rebuildIndex is a prefix SCAN, not an append — it self-heals a gap', async () => {
  // Simulate three prior successful day-card writes with NO index ever built
  // (as if every previous index write had failed). A scan-based rebuild must
  // recover all three; an append-based one would have lost all but the last.
  const env = envOf(db);
  const mkCard = (date, n) => ({
    generated_at: `${date}T00:00:00.000Z`,
    citation: CITATION,
    facts: { new_objects: n, decays: 0 },
    narrative: null,
    narrative_status: 'disabled',
    narrative_source: 'none',
  });
  for (const [date, n] of [['2026-07-30', 1], ['2026-07-31', 2], ['2026-08-01', 3]]) {
    await env.ORBIT_R2.put(archiveKey(date), JSON.stringify(mkCard(date, n)), {
      httpMetadata: {}, customMetadata: {},
    });
  }
  assert.equal(env.ORBIT_R2.puts.has(BRIEF_INDEX_KEY), false, 'no index written yet');

  const index = await rebuildIndex(env);
  assert.equal(index.total, 3);
  assert.deepEqual(index.days.map((d) => d.date), ['2026-08-01', '2026-07-31', '2026-07-30'],
                    'newest first');
  assert.deepEqual(index.days.map((d) => d.new_objects), [3, 2, 1]);
});

await test('the index respects the 90-day hard cap, keeping the newest days', async () => {
  const env = envOf(db);
  const N = BRIEF_INDEX_DAYS + 10;
  for (let i = 0; i < N; i++) {
    const d = new Date(Date.UTC(2026, 0, 1) + i * 86400_000).toISOString().slice(0, 10);
    await env.ORBIT_R2.put(archiveKey(d), JSON.stringify({
      generated_at: `${d}T00:00:00.000Z`, citation: CITATION,
      facts: { new_objects: 0, decays: 0 },
      narrative: null, narrative_status: 'disabled', narrative_source: 'none',
    }), { httpMetadata: {}, customMetadata: {} });
  }
  const index = await rebuildIndex(env);
  assert.equal(index.total, N, '`total` reports every archived day, capped or not');
  assert.equal(index.days.length, BRIEF_INDEX_DAYS, 'the DAYS array itself is capped');
  const newest = new Date(Date.UTC(2026, 0, 1) + (N - 1) * 86400_000).toISOString().slice(0, 10);
  assert.equal(index.days[0].date, newest, 'the cap keeps the newest days, not the oldest');
});

await test('an archive write failure does not stop latest.json from being written', async () => {
  const env = envOf(db, { ORBIT_AI_CARDS: '0' });
  const realPut = env.ORBIT_R2.put.bind(env.ORBIT_R2);
  env.ORBIT_R2.put = async (key, ...rest) => {
    if (key.startsWith('brief/2') && key !== BRIEF_KEY) throw new Error('R2 unavailable');
    return realPut(key, ...rest);
  };
  const card = await buildBrief(env, { now: NOW });
  assert.equal(card.narrative_status, 'disabled', 'buildBrief must still return the card');
  assert.ok(env.ORBIT_R2.puts.get(BRIEF_KEY), 'latest.json must still be written');
});

/* ── Cross-file invariants ──────────────────────────────────────────────── */

await test('the daily job builds the brief; the 6-hourly one does not', async () => {
  const src = fs.readFileSync(path.join(HERE, '../src/index.js'), 'utf8');
  const daily = src.slice(src.indexOf('export async function runDaily'),
                          src.indexOf('export async function runWeekly'));
  const gp = src.slice(src.indexOf('export async function runGP'),
                       src.indexOf('export async function runDaily'));
  assert.match(daily, /buildBrief\(env\)/, 'runDaily must build the brief');
  assert.ok(!/buildBrief/.test(gp), 'the brief is once a day, not every six hours');
});

await test('the daily job also builds analytics; the 6-hourly one does not', async () => {
  const src = fs.readFileSync(path.join(HERE, '../src/index.js'), 'utf8');
  const daily = src.slice(src.indexOf('export async function runDaily'),
                          src.indexOf('export async function runWeekly'));
  const gp = src.slice(src.indexOf('export async function runGP'),
                       src.indexOf('export async function runDaily'));
  assert.match(daily, /buildAnalytics\(env\)/, 'runDaily must build the analytics artifact');
  assert.ok(!/buildAnalytics/.test(gp), 'launch history barely moves in six hours');
});

await test('the PAGES project must not carry an AI binding', async () => {
  // The read path is a flat R2 GET by design. An AI binding on Pages is the
  // one thing that would make per-request inference possible, so its absence
  // is an invariant rather than an accident of configuration.
  const pages = fs.readFileSync(path.join(ROOT, 'wrangler.toml'), 'utf8');
  assert.ok(!/^\s*\[ai\]/m.test(pages), 'Pages must not bind Workers AI');
  const worker = fs.readFileSync(path.join(HERE, '../wrangler.toml'), 'utf8');
  assert.match(worker, /\[ai\]\s*\nbinding = "ORBIT_AI"/);
});

await test('the Node AI client speaks the binding interface', async () => {
  const { WorkersAI, GroqAI, createAI, DEFAULT_MODELS } = await import('../scripts/ai-node.mjs');
  for (const Cls of [WorkersAI, GroqAI]) {
    assert.equal(typeof Cls.prototype.run, 'function', `${Cls.name}.run must exist`);
  }
  assert.equal(DEFAULT_MODELS['workers-ai'], BRIEF_MODEL);
  // No credentials configured must be `null`, never a half-built client: the
  // brief treats null as "facts only" and a throw would fail the ingest.
  assert.equal(createAI({}), null);
  assert.equal(createAI({ ORBIT_AI_PROVIDER: 'groq' }), null);
  assert.ok(createAI({ CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 't' }) instanceof WorkersAI);
  assert.ok(createAI({ ORBIT_AI_PROVIDER: 'groq', GROQ_API_KEY: 'k' }) instanceof GroqAI);
});

await test('the Workers AI client normalises both providers to { response }', async () => {
  const { WorkersAI, GroqAI } = await import('../scripts/ai-node.mjs');

  const cf = new WorkersAI({
    accountId: 'acct', apiToken: 'tok',
    fetch: async () => new Response(JSON.stringify({ success: true, result: { response: 'hi' } })),
  });
  assert.deepEqual(await cf.run('m', {}), { response: 'hi' });

  const groq = new GroqAI({
    apiKey: 'k',
    fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] })),
  });
  assert.deepEqual(await groq.run('m', { messages: [] }), { response: 'hi' });
});

await test('a 403 from Workers AI names the likely cause', async () => {
  const { WorkersAI } = await import('../scripts/ai-node.mjs');
  const cf = new WorkersAI({
    accountId: 'acct', apiToken: 'tok',
    fetch: async () => new Response('forbidden', { status: 403 }),
  });
  await assert.rejects(() => cf.run('m', {}), /Workers AI: Read/);
});

/* ── Report ─────────────────────────────────────────────────────────────── */

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
