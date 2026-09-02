/**
 * Facts with provenance — the write path, and where the licence allowlist bites.
 *
 *     node --no-warnings workers/orbit-profiles/test/facts.test.mjs
 *
 * Two sources disagreeing on a field is expected. Higher sources.priority wins;
 * the loser is returned as data, never silently dropped. writeFacts() calls
 * assertAllowed() on every fact before any write — Task 2 built the mechanism,
 * this is the call site that makes it real.
 */
import assert from 'node:assert/strict';
import { resolveConflicts, writeFacts } from '../src/facts.js';
import { fakeDB, matching } from './fakes.mjs';

const results = [];
function test(name, fn) {
  Promise.resolve().then(fn)
    .then(() => { results.push(true); console.log('  PASS  ' + name); })
    .catch((e) => { results.push(false); console.log('  FAIL  ' + name + '\n        ' + e.message); });
}

const F = (value, source_id, extra = {}) => ({
  value, source_id, source_url: `https://example/${source_id}`, confidence: 1, ...extra,
});

console.log('\n-- resolveConflicts: higher priority wins, loser is data --');

test('the higher-priority source wins the field; the loser is in conflicts, not fields', () => {
  const { fields, conflicts } = resolveConflicts({
    launch_mass_kg: [F(958, 'gcat'), F(1000, 'spacetrack-satcat')],
  });
  assert.equal(fields.launch_mass_kg.value, 958);         // gcat priority 90 > satcat 80
  assert.equal(fields.launch_mass_kg.source_id, 'gcat');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].field, 'launch_mass_kg');
  assert.equal(conflicts[0].kept.source_id, 'gcat');
  assert.equal(conflicts[0].dropped[0].source_id, 'spacetrack-satcat');
});

test('nssdca (100) beats gcat (90) beats satcat (80) beats nasa-imagery (50)', () => {
  const { fields } = resolveConflicts({
    operator_name: [F('B', 'gcat'), F('A', 'nssdca'), F('C', 'spacetrack-satcat')],
  });
  assert.equal(fields.operator_name.value, 'A');
});

test('a single-source field has no conflict', () => {
  const { fields, conflicts } = resolveConflicts({ bus: [F('FGB', 'nssdca')] });
  assert.equal(fields.bus.value, 'FGB');
  assert.deepEqual(conflicts, []);
});

test('equal priorities resolve deterministically and identically across calls', () => {
  // Two hypothetical same-priority sources — tie breaks on source_id ascending.
  const input = { power_w: [F(1900, 'zeta'), F(1800, 'alpha')] };
  const a = resolveConflicts(structuredClone(input));
  const b = resolveConflicts(structuredClone(input));
  assert.equal(a.fields.power_w.source_id, b.fields.power_w.source_id);
  assert.equal(a.fields.power_w.value, b.fields.power_w.value);
});

console.log('\n-- writeFacts: the enforcement point --');

const spine = {
  cospar: '1998-067A', official_name: 'ISS (Zarya)', mission_summary: null,
  operator_name: 'NASA / Roscosmos', owner_country: 'International', bus: 'FGB',
  manufacturer: 'Khrunichev', launch_mass_kg: 19323, power_w: 3000,
  design_life_years: 15, mission_type: 'Engineering', status: 'operational',
};

test('throws when handed a fact from a non-allowlisted source, and writes NOTHING', async () => {
  const db = fakeDB();
  const resolved = { fields: {
    launch_mass_kg: F(19323, 'gunters-space-page'),
  } };
  await assert.rejects(() => writeFacts(db, 25544, resolved, spine), /gunters-space-page/);
  assert.equal(db.executed.length, 0, 'a rejected source must abort before any write');
});

test('one profiles upsert plus one profile_fields row per populated field, NORAD bound to each', async () => {
  const db = fakeDB();
  const resolved = { fields: {
    launch_mass_kg: F(19323, 'nssdca'),
    operator_name: F('NASA / Roscosmos', 'nssdca'),
    bus: F('FGB', 'gcat'),
  } };
  const n = await writeFacts(db, 25544, resolved, spine);
  assert.equal(n.profiles, 1);
  assert.equal(n.fields, 3);

  const profileWrites = matching(db, /INTO profiles/i);
  assert.equal(profileWrites.length, 1);
  assert.ok(profileWrites[0].args.includes(25544));

  const fieldWrites = matching(db, /INTO profile_fields/i);
  assert.equal(fieldWrites.length, 3);
  for (const w of fieldWrites) assert.equal(w.args[0], 25544, 'each provenance row binds its NORAD');
});

test('profile_fields upsert is ON CONFLICT so a re-run replaces provenance', async () => {
  const db = fakeDB();
  await writeFacts(db, 25544, { fields: { bus: F('FGB', 'gcat') } }, spine);
  for (const w of matching(db, /INTO profile_fields/i)) assert.match(w.sql, /ON CONFLICT/i);
});

process.on('exit', () => {
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  if (passed !== results.length) process.exitCode = 1;
});
