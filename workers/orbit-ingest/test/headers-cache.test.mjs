/**
 * public/_headers — cache-control policy for un-hashed, hand-edited assets.
 *
 *     node workers/orbit-ingest/test/headers-cache.test.mjs
 *
 * Nothing in public/ is content-hashed (no build step to hash with), so the
 * URL of a file never changes when its contents do. A long `max-age` on those
 * paths pins a browser to whatever build it happened to fetch first, and a
 * shipped fix simply cannot reach it until the TTL expires.
 *
 * That is not theoretical: the `Invalid URL` bug in spacetrack/shared/api.js
 * was fixed and deployed, and the reporter kept hitting it through repeated
 * hard reloads because /spacetrack/* carried `max-age=86400`.
 *
 * The rule this file guards: any route that serves executable code (HTML or
 * JS) must revalidate. Frozen third-party bytes under a vendor/ path may keep
 * a long TTL, because a version bump lands as a new upload rather than an edit.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const HEADERS = path.join(ROOT, 'public/_headers');

const results = [];
function test(name, fn) {
  try { fn(); results.push(true); console.log('  PASS  ' + name); }
  catch (e) { results.push(false); console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); }
}

/** Parse _headers into [{ pattern, headers: {name: value} }] in file order. */
function parseHeaders(text) {
  const rules = [];
  let current = null;
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      current = { pattern: raw.trim(), headers: {} };
      rules.push(current);
      continue;
    }
    const m = raw.trim().match(/^([^:]+):\s*(.*)$/);
    if (m && current) current.headers[m[1].trim().toLowerCase()] = m[2].trim();
  }
  return rules;
}

const text = fs.readFileSync(HEADERS, 'utf8');
const rules = parseHeaders(text);
const cacheOf = (p) => {
  const r = rules.find(x => x.pattern === p);
  return r ? (r.headers['cache-control'] || '') : null;
};

/* Routes whose files the browser executes. A stale copy here is a broken page,
   not a cosmetic difference. */
const CODE_ROUTES = [
  '/orbit/*', '/spacetrack/*', '/starlink/*', '/about/*', '/wiki/*',
  '/orbit-engine/*', '/js/*',
];

console.log('\n-- executable routes must revalidate --');

for (const route of CODE_ROUTES) {
  test(`${route} has a cache-control rule`, () => {
    assert.ok(cacheOf(route) !== null, `${route} is missing from _headers`);
  });

  test(`${route} revalidates instead of pinning a build`, () => {
    const cc = cacheOf(route) || '';
    assert.match(cc, /no-cache|must-revalidate|max-age=0/,
      `${route} is "${cc}" — a browser can serve a stale build from this`);
  });

  test(`${route} does not carry a multi-hour max-age`, () => {
    const cc = cacheOf(route) || '';
    const m = cc.match(/(?:^|[\s,])max-age=(\d+)/);
    const age = m ? Number(m[1]) : 0;
    assert.ok(age <= 60,
      `${route} has max-age=${age}; a fix cannot reach a cached browser for ${age}s`);
  });

  test(`${route} is never immutable`, () => {
    assert.doesNotMatch(cacheOf(route) || '', /immutable/,
      `${route} is immutable, but its filenames are not content-hashed`);
  });
}

console.log('\n-- stale-while-revalidate is not used for code --');

/* swr serves the stale copy to the very visitor who triggers the refresh, so a
   user meeting a broken deploy still gets the broken file on that load. */
for (const route of CODE_ROUTES) {
  test(`${route} does not use stale-while-revalidate`, () => {
    assert.doesNotMatch(cacheOf(route) || '', /stale-while-revalidate/,
      `${route} would serve the stale build to the user who triggered revalidation`);
  });
}

console.log('\n-- long TTLs stay confined to frozen vendor bytes --');

test('/orbit-engine/vendor/* may keep its long TTL', () => {
  assert.match(cacheOf('/orbit-engine/vendor/*') || '', /max-age=\d{5,}/);
});

test('vendor rule precedes the general engine rule (Pages takes first match)', () => {
  const vendor = rules.findIndex(r => r.pattern === '/orbit-engine/vendor/*');
  const engine = rules.findIndex(r => r.pattern === '/orbit-engine/*');
  assert.ok(vendor !== -1 && engine !== -1, 'both rules must exist');
  assert.ok(vendor < engine,
    'the general /orbit-engine/* rule would shadow the vendor rule');
});

test('admin stays no-store', () => {
  assert.match(cacheOf('/admin/*') || '', /no-store/);
});

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
if (passed !== results.length) process.exit(1);
