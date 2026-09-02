/**
 * Resumability — last-completed NORAD per stage.
 *
 *     node --no-warnings workers/orbit-profiles/test/checkpoint.test.mjs
 *
 * A 28k-object pass runs for tens of minutes as an Actions job; a run that dies
 * at object 14,000 must restart at 14,000, not re-do the work (and, for Tier 3,
 * not re-spend the model budget). The checkpoint write must be durable BEFORE
 * the work it covers is acknowledged.
 */
import assert from 'node:assert/strict';
import { readCheckpoint, writeCheckpoint } from '../src/checkpoint.js';
import { fakeDB } from './fakes.mjs';

const results = [];
function test(name, fn) {
  Promise.resolve().then(fn)
    .then(() => { results.push(true); console.log('  PASS  ' + name); })
    .catch((e) => { results.push(false); console.log('  FAIL  ' + name + '\n        ' + e.message); });
}

/** A fakeDB that actually remembers ingest_checkpoints rows. */
function checkpointDB() {
  const store = new Map();
  const db = fakeDB((sql, args) => {
    if (/SELECT/i.test(sql) && /ingest_checkpoints/i.test(sql)) {
      const stage = args[0];
      return store.has(stage) ? [{ last_norad: store.get(stage) }] : [];
    }
    return undefined;
  });
  const origPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const stmt = origPrepare(sql);
    const origRun = stmt.run.bind(stmt);
    stmt.run = async () => {
      if (/INSERT INTO ingest_checkpoints/i.test(sql)) store.set(stmt.args[0], stmt.args[1]);
      return origRun();
    };
    return stmt;
  };
  db.store = store;
  return db;
}

console.log('\n-- absent reads as 0 --');

test('an unset stage checkpoint reads as 0', async () => {
  const db = checkpointDB();
  assert.equal(await readCheckpoint(db, 'match'), 0);
  assert.equal(await readCheckpoint(db, 'prose'), 0);
});

console.log('\n-- write-then-read round-trips, stages independent --');

test('writeCheckpoint then readCheckpoint returns the written NORAD', async () => {
  const db = checkpointDB();
  await writeCheckpoint(db, 'facts', 14000);
  assert.equal(await readCheckpoint(db, 'facts'), 14000);
});

test('the four stages do not share state', async () => {
  const db = checkpointDB();
  await writeCheckpoint(db, 'match', 5000);
  await writeCheckpoint(db, 'facts', 12000);
  await writeCheckpoint(db, 'prose', 9000);
  assert.equal(await readCheckpoint(db, 'match'), 5000);
  assert.equal(await readCheckpoint(db, 'facts'), 12000);
  assert.equal(await readCheckpoint(db, 'prose'), 9000);
  assert.equal(await readCheckpoint(db, 'images'), 0);
});

test('writeCheckpoint is an upsert — a later write for the same stage replaces', async () => {
  const db = checkpointDB();
  await writeCheckpoint(db, 'prose', 1000);
  await writeCheckpoint(db, 'prose', 2000);
  assert.equal(await readCheckpoint(db, 'prose'), 2000);
  const upserts = db.executed.filter((e) => /INSERT INTO ingest_checkpoints/i.test(e.sql));
  for (const u of upserts) assert.match(u.sql, /ON CONFLICT/i);
});

process.on('exit', () => {
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  if (passed !== results.length) process.exitCode = 1;
});
