/**
 * public/shared/sync-checkbox.js — two-way checkbox mirroring for the
 * desktop-panel / mobile-drawer duplicate controls on /orbit/.
 *
 *     node workers/orbit-ingest/test/sync-checkbox.test.mjs
 *
 * This guards a shipped crash: the original inline handlers in
 * orbital-relay.js dispatched a synthetic `change` at their partner
 * unconditionally, so the partner dispatched back, and a single click on any
 * layer checkbox blew the stack with `RangeError: Maximum call stack size
 * exceeded` — in every browser, not just the sandbox.
 *
 * `recursion is what the fix prevents` below reimplements the OLD unguarded
 * wiring against the same fake, and asserts it still explodes. If someone
 * "simplifies" the equality guard out of sync-checkbox.js, the guarded tests
 * go red; that test is what proves the guard is load-bearing rather than
 * decorative.
 */
import assert from 'node:assert/strict';

import { syncCheckboxes } from '../../../public/shared/sync-checkbox.js';

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS  ' + name); }
  catch (e) { results.push(false); console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); }
}

/* ── A checkbox fake ─────────────────────────────────────────────────────────
 * Just enough DOM: `checked`, listener registration, and a synchronous
 * dispatch (the browser dispatches synthetic events synchronously too — that
 * synchronicity is precisely why the original bug recursed rather than
 * queueing).
 */
function makeCheckbox(checked = false) {
  const listeners = [];
  return {
    checked,
    fires: 0,
    addEventListener(_ev, fn) { listeners.push(fn); },
    dispatchEvent() { this.fires++; listeners.forEach(fn => fn()); },
    /** Simulate a real user click: flip, then fire `change` as a browser would. */
    click() { this.checked = !this.checked; this.dispatchEvent(); },
  };
}

const EVENT = () => ({ type: 'change' });
const sync = (a, b) => syncCheckboxes(a, b, { makeEvent: EVENT });

/* ── The crash ───────────────────────────────────────────────────────────── */

console.log('\n-- infinite recursion (the shipped bug) --');

await test('a click on the main checkbox does not blow the stack', () => {
  const main = makeCheckbox(false);
  const drawer = makeCheckbox(false);
  sync(main, drawer);
  main.click();  // threw RangeError before the fix
  assert.equal(drawer.checked, true, 'drawer mirrored the main checkbox');
});

await test('a click on the drawer checkbox does not blow the stack', () => {
  const main = makeCheckbox(false);
  const drawer = makeCheckbox(false);
  sync(main, drawer);
  drawer.click();
  assert.equal(main.checked, true, 'main mirrored the drawer checkbox');
});

await test('recursion is what the fix prevents', () => {
  // The OLD wiring, verbatim in shape: mirror + dispatch, no equality guard.
  const main = makeCheckbox(false);
  const drawer = makeCheckbox(false);
  const linkUnguarded = (from, to) => {
    from.addEventListener('change', () => {
      to.checked = from.checked;
      to.dispatchEvent(EVENT());
    });
  };
  linkUnguarded(main, drawer);
  linkUnguarded(drawer, main);
  assert.throws(() => main.click(), RangeError,
    'the unguarded wiring must still recurse — otherwise this fake no longer ' +
    'reproduces the bug and the passing tests above prove nothing');
});

/* ── The mirrored copy still applies its change ──────────────────────────── */

console.log('\n-- the synthetic dispatch is still delivered --');

await test('the mirror is told exactly once, so its own listener runs once', () => {
  const main = makeCheckbox(false);
  const drawer = makeCheckbox(false);
  sync(main, drawer);
  main.click();
  // 1 = the synthetic change syncCheckboxes sent to the mirror. Assigning
  // .checked alone would not fire it, and the layer-toggle handler bound to
  // every .layer-cb is what actually shows/hides the layer.
  assert.equal(drawer.fires, 1, 'drawer notified exactly once');
});

await test('the source is not re-notified by its own mirroring', () => {
  const main = makeCheckbox(false);
  const drawer = makeCheckbox(false);
  sync(main, drawer);
  main.click();
  assert.equal(main.fires, 1, 'only the user click, no echo back from drawer');
});

/* ── Convergence ─────────────────────────────────────────────────────────── */

console.log('\n-- state stays converged --');

await test('repeated clicks keep both in sync', () => {
  const main = makeCheckbox(false);
  const drawer = makeCheckbox(false);
  sync(main, drawer);
  for (let i = 0; i < 8; i++) {
    (i % 2 ? drawer : main).click();
    assert.equal(main.checked, drawer.checked, `diverged on click ${i}`);
  }
  assert.equal(main.checked, false, '8 toggles returns to the start');
});

await test('a pair that starts out of sync converges on the next click', () => {
  const main = makeCheckbox(false);
  const drawer = makeCheckbox(true);
  sync(main, drawer);
  main.click();
  assert.equal(main.checked, true);
  assert.equal(drawer.checked, true);
});

await test('a missing partner is a no-op, not a crash', () => {
  const main = makeCheckbox(false);
  assert.doesNotThrow(() => syncCheckboxes(main, null, { makeEvent: EVENT }));
  assert.doesNotThrow(() => syncCheckboxes(null, main, { makeEvent: EVENT }));
  assert.doesNotThrow(() => main.click());
});

/* ── Summary ─────────────────────────────────────────────────────────────── */

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
