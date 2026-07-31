/**
 * Parse every first-party JS file.
 *
 * Why this exists: with no build step, a syntax error in an ES module executes
 * ZERO statements of that module — not a partial failure, a silent total one.
 * `catalog.js` once shipped `const LOD FAR_THRESHOLD = 5000000;` and all 1,465
 * lines of the catalog page were dead until someone happened to load it.
 *
 * Root package.json has "type": "module", so `.js` is treated as ESM here —
 * the same invocation that reproduced that bug.
 *
 * Usage: node scripts/check/syntax.mjs
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const ROOTS = ['public', 'functions'];

// vendor/ is minified third-party CLASSIC script, not ESM — parsing it as a
// module is a false positive, not a finding.
const SKIP = ['/vendor/', '/node_modules/', '/.venv/', '/.wrangler/'];

function walk(dir, out = []) {
    let entries;
    try { entries = readdirSync(dir); } catch { return out; }
    for (const entry of entries) {
        const full = path.join(dir, entry);
        const rel = '/' + path.relative(ROOT, full).split(path.sep).join('/');
        if (SKIP.some(s => (rel + '/').includes(s))) continue;
        const st = statSync(full);
        if (st.isDirectory()) walk(full, out);
        else if (entry.endsWith('.js') || entry.endsWith('.mjs')) out.push(full);
    }
    return out;
}

const files = ROOTS.flatMap(r => walk(path.join(ROOT, r)));
const failures = [];

for (const file of files) {
    const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (res.status !== 0) {
        failures.push({ file: path.relative(ROOT, file), err: (res.stderr || '').trim() });
    }
}

for (const f of failures) {
    console.error(`\n${f.file}\n${f.err}`);
}

console.log(`\nsyntax: ${files.length - failures.length}/${files.length} files parse`);
process.exit(failures.length ? 1 : 0);
