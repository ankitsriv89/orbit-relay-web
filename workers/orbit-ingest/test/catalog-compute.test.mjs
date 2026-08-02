/**
 * public/spacetrack/catalog/compute.js — overlay arithmetic, extracted from
 * catalog.js's toggle handlers in plan 34 wave 2.2.
 *
 *     node workers/orbit-ingest/test/catalog-compute.test.mjs
 *
 * The age ramp's reference time is now an explicit argument (it used to call
 * `Date.now()` inside the ramp, which made the ramp untestable), so every
 * assertion here is against a closed form at a pinned instant. The heatmap
 * assertions are against the bin grid and the cyan→yellow→red ramp.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { binHeatmap, heatmapStyle, ageRamp, ageColorCss } from '../../../public/spacetrack/catalog/compute.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(true); console.log('  PASS  ' + name); }
  catch (e) { results.push(false); console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); }
}

/* ── Heatmap binning ────────────────────────────────────────────────────── */

console.log('\n-- heatmap binning --');

await test('empty input bins to nothing', () => {
  assert.deepEqual(binHeatmap([], 6), { bins: [], max: 0 });
});

await test('points in the same cell collapse into one bin', () => {
  const { bins, max } = binHeatmap([[13, 14], [15, 16], [17, 17]], 6);
  assert.equal(bins.length, 1, JSON.stringify(bins));
  assert.equal(bins[0].count, 3);
  assert.equal(bins[0].x, Math.floor(13 / 6));
  assert.equal(bins[0].y, Math.floor(14 / 6));
  assert.equal(max, 3);
});

await test('cell coordinates are floor(x / binSize), not rounded', () => {
  const { bins } = binHeatmap([[5, 5], [6, 6]], 6);
  assert.equal(bins.length, 2);
  assert.equal(bins[0].x, 0, 'x = 5 lands in cell 0, not cell 1');
  assert.equal(bins[1].x, 1, 'x = 6 lands in cell 1');
});

await test('max is the largest cell count', () => {
  // Cells: (0,0) hits 4×, (5,5) hits 2×, (1,2) hits 1×.
  const coords = [[0, 0], [1, 1], [2, 2], [3, 3], [30, 31], [31, 30], [9, 13]];
  const { bins, max } = binHeatmap(coords, 6);
  assert.equal(max, 4);
  const counts = bins.map(b => b.count).sort((a, b) => a - b);
  assert.deepEqual(counts, [1, 2, 4]);
});

await test('distinct cells stay distinct even at identical x', () => {
  const { bins } = binHeatmap([[6, 0], [6, 6]], 6);
  assert.equal(bins.length, 2, 'same column, different rows');
});

/* ── Heatmap colour ramp ────────────────────────────────────────────────── */

console.log('\n-- heatmap colour ramp --');

await test('the coldest cell is cyan and the hottest is red', () => {
  const cold = heatmapStyle(0, 10, 6);
  assert.deepEqual([cold.r, cold.g, cold.b], [0, 200, 255]);
  assert.ok(Math.abs(cold.alpha - 0.05) < 1e-12);
  assert.equal(cold.radius, 6);
  const hot = heatmapStyle(10, 10, 6);
  assert.deepEqual([hot.r, hot.g, hot.b], [255, 0, 0]);
  assert.ok(Math.abs(hot.alpha - 0.4) < 1e-12, `alpha ${hot.alpha}`);
  assert.equal(hot.radius, 24);
});

await test('intensity scales radius and alpha linearly', () => {
  const s = heatmapStyle(5, 10, 6);          // intensity 0.5
  assert.equal(s.radius, 6 * (1 + 0.5 * 3));
  assert.equal(s.alpha, 0.05 + 0.5 * 0.35);
});

await test('the mid ramp passes through yellow, not a jump', () => {
  // intensity 0.25: r climbs toward 255, g sits between 200 and 255.
  const s = heatmapStyle(2, 8, 6);
  assert.equal(s.r, Math.round(0.25 * 2 * 255));
  assert.equal(s.g, Math.round(200 + 0.25 * 110));
  assert.equal(s.b, 255);
});

await test('a count above the normaliser is clamped to full red', () => {
  const s = heatmapStyle(9, 8, 6);           // count > max
  assert.deepEqual([s.r, s.g, s.b], [255, 0, 0]);
});

/* ── Age ramp ───────────────────────────────────────────────────────────── */

console.log('\n-- object-age ramp --');

const NOW = Date.UTC(2026, 6, 28, 0, 0, 0);
const DAY = 86400000;

await test('a fresh object is the bright cyan end of the ramp', () => {
  assert.deepEqual(ageRamp(new Date(NOW).toISOString(), NOW), { r: 0, g: 210, b: 255, a: 0.95 });
});

await test('three years of age is the faded deep-blue end', () => {
  const old = ageRamp(new Date(NOW - 3 * 365 * DAY).toISOString(), NOW);
  assert.equal(old.r, 0);
  assert.equal(old.g, Math.round(210 * (1 - 0.85)));
  assert.equal(old.b, Math.round(255 * (1 - 0.7)));
  assert.equal(old.a, 0.95 - 0.5);
});

await test('older than three years clamps, it does not go negative', () => {
  const atCap = ageRamp(new Date(NOW - 3 * 365 * DAY).toISOString(), NOW);
  const over = ageRamp(new Date(NOW - 10 * 365 * DAY).toISOString(), NOW);
  assert.deepEqual(over, atCap);
  assert.ok(over.a >= 0.4, 'alpha must not drift below its floor');
});

await test('green and blue channels fall monotonically with age', () => {
  const young = ageRamp(new Date(NOW - 1 * 365 * DAY).toISOString(), NOW);
  const mid = ageRamp(new Date(NOW - 2 * 365 * DAY).toISOString(), NOW);
  const old = ageRamp(new Date(NOW - 3 * 365 * DAY).toISOString(), NOW);
  assert.ok(mid.g < young.g && old.g < mid.g, 'green fades');
  assert.ok(mid.b < young.b && old.b < mid.b, 'blue fades');
  assert.ok(mid.a < young.a && old.a < mid.a, 'alpha fades');
});

await test('a missing or unparseable date is null, not ancient', () => {
  assert.equal(ageRamp('', NOW), null);
  assert.equal(ageRamp(null, NOW), null);
  assert.equal(ageRamp('not-a-date', NOW), null);
});

await test('ageColorCss renders the ramp as a css string', () => {
  assert.equal(ageColorCss(new Date(NOW).toISOString(), NOW), 'rgba(0,210,255,0.95)');
  assert.equal(ageColorCss('', NOW), null);
});

/* ── Cross-file invariants ──────────────────────────────────────────────── */

console.log('\n-- catalog.js and compute.js agree --');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

await test('compute.js stays importable in Node: no browser globals', () => {
  const src = read('public/spacetrack/catalog/compute.js')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  assert.ok(!/\bCesium\s*\./.test(src), 'no Cesium calls');
  assert.ok(!/\bdocument\s*\./.test(src), 'no DOM access');
  assert.ok(!/\bwindow\s*\./.test(src), 'no window access');
  assert.ok(!/Date\.now\(/.test(src), 'the ramp must take its reference time');
});

await test('catalog.js and its overlays import the maths instead of re-implementing it', () => {
  const catalog = read('public/spacetrack/catalog.js');
  assert.ok(/import[^;]*createHeatmap/.test(catalog), 'catalog.js must import the heatmap overlay');
  assert.ok(/import[^;]*createAge/.test(catalog), 'catalog.js must import the age overlay');
  assert.ok(/import[^;]*createDebris/.test(catalog), 'catalog.js must import the debris overlay');
  assert.ok(/import[^;]*createLaunchSites/.test(catalog), 'catalog.js must import the launch-sites overlay');
  assert.ok(/import[^;]*createLOD/.test(catalog), 'catalog.js must import the LOD overlay');
  assert.ok(!/Math\.round\(210/.test(catalog), 'the age ramp must not be re-implemented inline');

  const heatmap = read('public/spacetrack/overlays/heatmap.js');
  for (const fn of ['binHeatmap', 'heatmapStyle']) {
    assert.ok(new RegExp(`import[\\s\\S]*\\b${fn}\\b`).test(heatmap),
              `heatmap.js must import ${fn}`);
  }
  assert.ok(!heatmap.includes('const bins = new Map();'),
            'the heatmap binning loop must not be re-implemented inline');

  const age = read('public/spacetrack/overlays/age.js');
  assert.ok(/ageColorCss/.test(age) && age.includes("from '../catalog/compute.js'"),
            'age.js must import ageColorCss from compute.js');
});

await test('every overlay entity routes through the engine, none escapes cleanup', () => {
  const files = [
    'public/spacetrack/catalog.js',
    'public/spacetrack/overlays/debris.js',
    'public/spacetrack/overlays/launch-sites.js',
    'public/spacetrack/overlays/regime-shells.js',
  ];
  let sawManaged = false;
  for (const file of files) {
    const src = read(file);
    // The wrapped form still literally contains `viewer.entities.add(`, so assert
    // no occurrence that is NOT immediately wrapped in addManagedEntity(...).
    assert.ok(!/(?<!addManagedEntity\()viewer\.entities\.add\(/.test(src),
              `${file}: no bare viewer.entities.add — those escape engine.destroy()`);
    if (/addManagedEntity\(viewer\.entities\.add/.test(src)) sawManaged = true;
  }
  assert.ok(sawManaged, 'overlay entities must be managed by the engine');
});

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
