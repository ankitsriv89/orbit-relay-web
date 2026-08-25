/**
 * public/shared/charts.js — pure chart-maths tests (plan 38 task 1).
 *
 *     node workers/orbit-ingest/test/charts.test.mjs
 *
 * Same arrangement as catalog-compute.test.mjs / signal-compute.test.mjs:
 * frontend code, tested here because the pure helpers take no DOM and need
 * no browser. `bin` and `cumulative` are the two functions CLAUDE.md calls
 * out explicitly — a naive bin() drops the value that lands exactly on the
 * upper edge into an overflow bucket, and a naive cumulative() resets or
 * re-bases across a gap in the input instead of carrying the running total
 * forward. Both are asserted here first.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bin, cumulative, niceScale, boxSegments } from '../../../public/shared/charts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS  ' + name); }
  catch (e) { results.push(false); console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); }
}

/* ── bin() ──────────────────────────────────────────────────────────────── */

console.log('\n-- bin() --');

await test('empty input bins to all-zero buckets covering the domain', () => {
  const bins = bin([], { min: 0, max: 10, width: 5 });
  assert.equal(bins.length, 2);
  assert.deepEqual(bins.map((b) => b.n), [0, 0]);
});

await test('a value exactly on the domain max lands in the LAST bin, not overflow', () => {
  // domain [0,10) width 5 -> two bins: [0,5), [5,10]. A naive
  // Math.floor((10-0)/5) = 2 would index a third, nonexistent bucket.
  const bins = bin([10], { min: 0, max: 10, width: 5 });
  assert.equal(bins.length, 2, 'must not grow a third bucket for the edge value');
  assert.equal(bins[0].n, 0);
  assert.equal(bins[1].n, 1, 'max-edge value belongs to the final bin');
});

await test('a value exactly on an interior bin edge starts the next bin', () => {
  const bins = bin([5], { min: 0, max: 10, width: 5 });
  assert.equal(bins[0].n, 0);
  assert.equal(bins[1].n, 1);
});

await test('values outside [min, max] are dropped, not clamped into an edge bin', () => {
  const bins = bin([-5, 15], { min: 0, max: 10, width: 5 });
  assert.deepEqual(bins.map((b) => b.n), [0, 0]);
});

await test('bin ranges are contiguous and the last bin caps at max', () => {
  const bins = bin([1, 6, 9], { min: 0, max: 10, width: 5 });
  assert.deepEqual(bins.map((b) => [b.min, b.max]), [[0, 5], [5, 10]]);
});

await test('null/NaN values are dropped silently', () => {
  const bins = bin([null, NaN, 3], { min: 0, max: 10, width: 5 });
  assert.equal(bins[0].n, 1);
});

/* ── cumulative() ───────────────────────────────────────────────────────── */

console.log('\n-- cumulative() --');

await test('running total carries forward across a gap year, it does not reset', () => {
  // 1957 has 3, then nothing recorded until 1960 with 2 -- the naive bug this
  // guards against is re-basing the sum to the row's own value after a gap
  // instead of adding onto the running total.
  const rows = [{ year: 1957, n: 3 }, { year: 1960, n: 2 }];
  const out = cumulative(rows, 'n');
  assert.equal(out[0].cumulative, 3);
  assert.equal(out[1].cumulative, 5, 'must carry the running total across the gap, not reset to 2');
});

await test('cumulative is monotonically non-decreasing for non-negative values', () => {
  const rows = [{ n: 1 }, { n: 0 }, { n: 4 }, { n: 2 }];
  const out = cumulative(rows, 'n');
  const totals = out.map((r) => r.cumulative);
  assert.deepEqual(totals, [1, 1, 5, 7]);
});

await test('a missing/non-numeric value key contributes zero, not NaN', () => {
  const rows = [{ n: 1 }, {}, { n: 2 }];
  const out = cumulative(rows, 'n');
  assert.deepEqual(out.map((r) => r.cumulative), [1, 1, 3]);
});

await test('original row fields survive alongside the added cumulative field', () => {
  const rows = [{ year: 2020, n: 5, extra: 'x' }];
  const out = cumulative(rows, 'n');
  assert.equal(out[0].year, 2020);
  assert.equal(out[0].extra, 'x');
  assert.equal(out[0].cumulative, 5);
});

/* ── niceScale() ────────────────────────────────────────────────────────── */

console.log('\n-- niceScale() --');

await test('domain is snapped outward to whole steps, never inward', () => {
  const s = niceScale(3, 47, 5);
  assert.ok(s.min <= 3, `min ${s.min} must not exceed the data min`);
  assert.ok(s.max >= 47, `max ${s.max} must not be less than the data max`);
});

await test('step is one of the nice multiples (1/2/5 x 10^n)', () => {
  const s = niceScale(0, 100, 5);
  const norm = s.step / Math.pow(10, Math.floor(Math.log10(s.step)));
  assert.ok([1, 2, 5, 10].includes(Math.round(norm * 100) / 100), `step ${s.step} not a nice multiple`);
});

await test('degenerate domain (max <= min) still returns a usable scale', () => {
  const s = niceScale(5, 5, 5);
  assert.ok(s.max > s.min);
  assert.ok(s.ticks.length >= 2);
});

await test('ticks span the full snapped domain', () => {
  const s = niceScale(0, 23, 5);
  assert.equal(s.ticks[0], s.min);
  assert.ok(s.ticks[s.ticks.length - 1] >= s.max - 1e-9);
});

/* ── boxSegments() ──────────────────────────────────────────────────────── */

console.log('\n-- boxSegments() (moved from brief.js) --');

await test('bar width is proportional to the row total against the group max', () => {
  const { bar } = boxSegments({ COUNTRY_TOTAL: 50, ORBITAL_TOTAL_COUNT: 40, DECAYED_TOTAL_COUNT: 10 }, 100);
  assert.equal(bar, 50);
});

await test('orbital/decayed split sums to 100', () => {
  const { orbitalPct, decayedPct } = boxSegments(
    { COUNTRY_TOTAL: 100, ORBITAL_TOTAL_COUNT: 75, DECAYED_TOTAL_COUNT: 25 }, 100);
  assert.equal(orbitalPct, 75);
  assert.equal(decayedPct, 25);
});

await test('zero base (no orbital, no decayed) reads as full orbital bar rather than NaN', () => {
  const { orbitalPct, decayedPct } = boxSegments({ COUNTRY_TOTAL: 0, ORBITAL_TOTAL_COUNT: 0, DECAYED_TOTAL_COUNT: 0 }, 100);
  assert.equal(orbitalPct, 100);
  assert.equal(decayedPct, 0);
});

/* ── Cross-file invariants ──────────────────────────────────────────────── */

console.log('\n-- charts.js hygiene --');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

await test('charts.js pure helpers do not require Cesium or DOM at module scope', () => {
  const src = read('public/shared/charts.js');
  assert.ok(!/\bCesium\s*\./.test(src), 'no Cesium calls');
});

await test('charts.js never uses innerHTML (repo rule)', () => {
  const src = read('public/shared/charts.js')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  assert.ok(!/innerHTML/.test(src), 'charts.js must build DOM nodes, not innerHTML strings');
});

await test('brief.js imports boxSegments from charts.js instead of re-implementing it', () => {
  const brief = read('public/spacetrack/brief/brief.js');
  assert.ok(/import[^;]*boxSegments[^;]*from ['"]\/shared\/charts\.js['"]/.test(brief),
    'brief.js must import boxSegments from /shared/charts.js');
  assert.ok(!/function boxSegments\(/.test(brief),
    'brief.js must not keep its own boxSegments implementation');
});

/* ── Analytics launch table ─────────────────────────────────────────────────
 * Source-text assertions, not behavioural ones: renderLaunches() is a DOM
 * writer, and the bug these guard was a field-name mismatch between the
 * builder and the renderer that no amount of exercising the maths would
 * catch. derive.js writes each launch as { launch_date, site, n,
 * typeBreakdown } — an OBJECT of per-type counts. The renderer read
 * `launch.type`, a scalar that has never existed on that shape, so the
 * TYPE BREAKDOWN column rendered an em-dash on all 20 rows while the API
 * was returning perfectly good data (verified live 2026-08-26:
 * stale:false, 20 launches, typeBreakdown populated).
 *
 * Guarding the source text is the honest option here. The alternative —
 * standing up a DOM — would test a mock, and the failure mode is precisely
 * "renderer reads a key the builder does not write", which is a
 * cross-file contract, not a computation. */

console.log('\n-- analytics launch table --');

const ANALYTICS_JS = read('public/spacetrack/analytics/analytics.js');
const DERIVE_JS = read('workers/orbit-ingest/src/derive.js');

await test('renderLaunches never reads launch.type — the builder writes typeBreakdown', () => {
  // The exact bug. `launch.type` is undefined for every row derive.js emits,
  // so typeMap[undefined] || (undefined || '—') collapsed to '—' always.
  //
  // Comments are stripped first: the fix's own explanatory comment names
  // `launch.type` in prose, and matching that would make this assertion fire
  // on the documentation of the bug rather than the bug.
  //
  // The negative lookahead is on the CHARACTER, not \b — `\b` matches between
  // `type` and `B`, so /launch\.type\b(?!Breakdown)/ happily matches inside
  // `launch.typeBreakdown` and reports the correct code as broken. That false
  // positive is exactly what this test caught on its first green run.
  const src = ANALYTICS_JS
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  assert.ok(!/launch\.type(?![A-Za-z])/.test(src),
    'analytics.js still reads launch.type; derive.js writes typeBreakdown, ' +
    'so that column renders an em-dash on every row');
});

await test('the launch artifact shape carries typeBreakdown, not a scalar type', () => {
  // The other half of the contract: if derive.js ever starts writing a
  // scalar `type`, the assertion above becomes wrong rather than protective,
  // so pin the producer too.
  assert.ok(/typeBreakdown/.test(DERIVE_JS),
    'derive.js must keep writing typeBreakdown for the launch table to read');
});

await test('renderLaunches builds rows with createElement, not innerHTML', () => {
  // Repo rule: no innerHTML anywhere API-derived data can reach. Clearing
  // with it is harmless in isolation, but it is the pattern the rule exists
  // to keep out, and site names in this table come straight from D1.
  const fn = ANALYTICS_JS.slice(ANALYTICS_JS.indexOf('function renderLaunches'));
  const body = fn.slice(0, fn.indexOf('\nfunction ') + 1 || fn.length);
  assert.ok(!/innerHTML/.test(body),
    'renderLaunches must not use innerHTML — use replaceChildren() to clear');
});

/* ── Analytics card set ─────────────────────────────────────────────────────
 * The four historical cards (launches by decade, top launch sites, debris
 * families, country x decade) were removed 2026-08-26: they are static
 * reference facts freely available elsewhere, not live tracking data, and
 * they crowded out the cards that are.
 *
 * The artifact FIELDS stay — /api/analytics still serves them and its D1
 * fallback still names them, so deleting them from derive.js would be a
 * separate, wider change. These assertions pin the frontend only. */

console.log('\n-- analytics card set --');

const ANALYTICS_HTML = read('public/spacetrack/analytics/index.html');

await test('the four historical cards are gone from the analytics markup', () => {
  for (const id of ['decade-card', 'sites-card', 'family-card', 'an-country-matrix']) {
    assert.ok(!ANALYTICS_HTML.includes(id),
      'removed card still present in index.html: ' + id);
  }
});

await test('no renderer targets a card that no longer exists', () => {
  // A dangling renderBars('an-decade-bars', ...) is silent — renderBars
  // returns early when the container is missing — so a half-done removal
  // leaves dead code that looks fine and never runs.
  for (const id of ['an-decade-bars', 'an-site-bars', 'an-family-bars', 'an-country-matrix']) {
    assert.ok(!ANALYTICS_JS.includes(id),
      'analytics.js still renders into removed container: ' + id);
  }
});

await test('renderAnalytics reaches renderLaunches — no early return can skip it', () => {
  // THE bug that made LAUNCH HISTORY sit at "loading…" in production while
  // every card above it rendered. renderAnalytics ended with:
  //
  //     const wrap = $('an-country-matrix');
  //     if (!wrap) return;              // <- the matrix card was already gone
  //     ...
  //     renderLaunches(data.launches);  // <- never reached
  //
  // A guard for a card that had already been deleted from the markup silently
  // killed the last render call in the function. It looked like a failed fetch
  // and was not — the API was returning 20 launches with stale:false the whole
  // time.
  //
  // So: renderLaunches must be the LAST statement, with no `return` between it
  // and the start of the function body other than the `if (!data) return` on
  // line one. Asserting on position rather than on any particular guard,
  // because the next version of this bug will be a different guard.
  const start = ANALYTICS_JS.indexOf('function renderAnalytics');
  assert.ok(start >= 0, 'renderAnalytics not found');
  const body = ANALYTICS_JS.slice(start, ANALYTICS_JS.indexOf('\n}', start));
  const callAt = body.indexOf('renderLaunches(');
  assert.ok(callAt >= 0, 'renderAnalytics must call renderLaunches');

  const before = body.slice(0, callAt).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const returns = before.match(/\breturn\b/g) || [];
  assert.equal(returns.length, 1,
    'exactly one `return` may precede renderLaunches (the `if (!data) return` ' +
    'guard); found ' + returns.length + ' — an early return here silently ' +
    'skips the launch table and looks like a failed fetch');
});

await test('the growth chart is explicitly sized, not left at the 220px default', () => {
  // svgLine defaults to h=220, which made CATALOG GROWTH tower over the
  // cards beside it. The call must pass its own height.
  const call = ANALYTICS_JS.slice(ANALYTICS_JS.indexOf('function renderGrowth'));
  const body = call.slice(0, call.indexOf('\nfunction ') + 1 || call.length);
  assert.ok(/\bh:\s*\d+/.test(body),
    'renderGrowth must pass an explicit h: to svgLine');
});

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
