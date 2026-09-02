/**
 * The licence allowlist — the write-path enforcement point.
 *
 *     node workers/orbit-profiles/test/sources.test.mjs
 *
 * This is the test the task exists for: a source that has not been
 * licence-reviewed must be physically unable to enter the database. The offender
 * is 'gunters-space-page' rather than 'foo' on purpose — it is the actual risk
 * (no stated licence, one person's hand-built compilation, spec's hard exclude).
 *
 * No database engine — fakeDB records the SQL and bindings seedSources emits.
 */
import assert from 'node:assert/strict';
import { SOURCES, assertAllowed, isAllowed, seedSources } from '../src/sources.js';
import { fakeDB, matching } from './fakes.mjs';

const results = [];
function test(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => { results.push(true); console.log('  PASS  ' + name); })
    .catch((e) => { results.push(false); console.log('  FAIL  ' + name + '\n        ' + e.message); });
}

const ALLOWED = ['nssdca', 'gcat', 'spacetrack-satcat', 'nasa-imagery'];
const PRIORITY = { nssdca: 100, gcat: 90, 'spacetrack-satcat': 80, 'nasa-imagery': 50 };

console.log('\n-- the allowlist rejects a non-reviewed source --');

test("assertAllowed throws for a source that was never licence-reviewed", () => {
  assert.throws(() => assertAllowed('gunters-space-page'), /gunters-space-page/);
});

test('assertAllowed throws for an empty / missing source_id', () => {
  assert.throws(() => assertAllowed(''));
  assert.throws(() => assertAllowed(undefined));
});

test('assertAllowed returns without throwing for each of the four allowlisted ids', () => {
  for (const id of ALLOWED) assert.doesNotThrow(() => assertAllowed(id));
});

test('isAllowed is the boolean form — never throws', () => {
  assert.equal(isAllowed('gunters-space-page'), false);
  assert.equal(isAllowed('nssdca'), true);
  assert.equal(isAllowed(''), false);
});

console.log('\n-- SOURCES is a reviewed constant, not a database read --');

test('SOURCES has exactly the four allowlisted keys', () => {
  assert.deepEqual(Object.keys(SOURCES).sort(), [...ALLOWED].sort());
});

test('every SOURCES entry fixes the priority the Interface Summary specifies', () => {
  for (const id of ALLOWED) assert.equal(SOURCES[id].priority, PRIORITY[id]);
});

test('every SOURCES entry carries a non-empty license and attribution_text', () => {
  for (const id of ALLOWED) {
    assert.ok(SOURCES[id].license && SOURCES[id].license.trim(), `${id} has no license`);
    assert.ok(SOURCES[id].attribution_text && SOURCES[id].attribution_text.trim(),
      `${id} has no attribution_text — cannot legally be displayed`);
  }
});

test('every SOURCES entry carries id and name matching its key', () => {
  for (const id of ALLOWED) {
    assert.equal(SOURCES[id].id, id);
    assert.ok(SOURCES[id].name && SOURCES[id].name.trim());
  }
});

console.log('\n-- seedSources upserts every entry, re-runnably --');

test('seedSources executes one upsert per SOURCES entry', async () => {
  const db = fakeDB();
  const n = await seedSources(db);
  assert.equal(n, ALLOWED.length);
  const upserts = matching(db, /INSERT INTO sources/i);
  assert.equal(upserts.length, ALLOWED.length);
});

test('seedSources is an upsert — ON CONFLICT, so a re-run is a no-op not a key error', async () => {
  const db = fakeDB();
  await seedSources(db);
  for (const e of matching(db, /INSERT INTO sources/i)) {
    assert.match(e.sql, /ON CONFLICT/i);
  }
});

test('seedSources binds the priority the Interface Summary fixes', async () => {
  const db = fakeDB();
  await seedSources(db);
  for (const e of matching(db, /INSERT INTO sources/i)) {
    const id = e.args[0];
    assert.ok(ALLOWED.includes(id), `unexpected source id bound: ${id}`);
    assert.ok(e.args.includes(PRIORITY[id]), `${id} upsert did not bind priority ${PRIORITY[id]}`);
  }
});

process.on('exit', () => {
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  if (passed !== results.length) process.exitCode = 1;
});
