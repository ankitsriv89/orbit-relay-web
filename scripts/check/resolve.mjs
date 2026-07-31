/**
 * Resolve every static reference in `public/` against the real filesystem.
 *
 * The key insight: with no build step, browser module resolution is *pure
 * filesystem path arithmetic against `public/` as the web root*, fully
 * simulable with zero dependencies.
 *
 * This catches the class of bug that has broken this repo three times
 * (fb66525f, dcbb42aa, and the four nested pages loading with no CSS):
 * a specifier resolves against the IMPORTING FILE's directory, not the page's,
 * and `../orbit-engine/` from `spacetrack/signal/signal.js` therefore means
 * `public/spacetrack/orbit-engine/`, which does not exist. Encoding that
 * distinction is the entire point of this file.
 *
 * NOT covered — by construction, since none of it is statically knowable:
 *   - dynamic `import(expr)` with a non-literal argument
 *   - template-literal URLs
 *   - `src`/`href` assigned on DOM nodes at runtime
 * Every bug this was written for is static, so coverage is real where it matters.
 *
 * External hosts (CDN Cesium, fonts) are skipped; add anything odd to
 * scripts/check/known-external.txt.
 *
 * Usage: node scripts/check/resolve.mjs
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PUBLIC_ROOT = path.join(ROOT, 'public');

const SKIP_DIRS = ['/node_modules/', '/.venv/', '/.wrangler/'];

const ALLOW = new Set(
    (() => {
        const f = path.join(ROOT, 'scripts/check/known-external.txt');
        if (!existsSync(f)) return [];
        return readFileSync(f, 'utf8')
            .split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#'));
    })()
);

const problems = [];
const rel = f => path.relative(ROOT, f).split(path.sep).join('/');

function walk(dir, exts, out = []) {
    let entries;
    try { entries = readdirSync(dir); } catch { return out; }
    for (const entry of entries) {
        const full = path.join(dir, entry);
        const r = '/' + path.relative(ROOT, full).split(path.sep).join('/');
        if (SKIP_DIRS.some(s => (r + '/').includes(s))) continue;
        if (statSync(full).isDirectory()) walk(full, exts, out);
        else if (exts.some(e => entry.endsWith(e))) out.push(full);
    }
    return out;
}

/** Line number of a character offset, 1-indexed. */
const lineAt = (src, idx) => src.slice(0, idx).split('\n').length;

/** True if this reference points outside the filesystem and we should not check it. */
function isExternal(ref) {
    return (
        /^[a-z][a-z0-9+.-]*:/i.test(ref) ||   // http:, https:, mailto:, data:, blob:
        ref.startsWith('//') ||
        ref.startsWith('#') ||
        ALLOW.has(ref)
    );
}

/**
 * Resolve as the browser does, then assert existence.
 * `base` is the directory the reference is written relative to — for an import
 * that is the importing FILE's directory, never the page's.
 */
function checkRef(fromFile, line, ref, base, { requireAbsolute = false } = {}) {
    if (!ref || isExternal(ref)) return;

    const clean = ref.split('?')[0].split('#')[0];
    if (!clean) return;

    if (requireAbsolute && !clean.startsWith('/')) {
        problems.push(
            `${rel(fromFile)}:${line}  ${ref}  →  worker URL must be ABSOLUTE ` +
            `(a relative one resolves against the page and silently falls back to synchronous SGP4)`
        );
        return;
    }

    const resolved = clean.startsWith('/')
        ? path.join(PUBLIC_ROOT, clean)
        : path.resolve(base, clean);

    if (existsSync(resolved)) {
        // A directory (or trailing-slash path) is valid iff it has an index.html —
        // Cloudflare Pages directory-index semantics, which is what makes
        // `/spacetrack/signal/` a legal href.
        if (statSync(resolved).isDirectory() && !existsSync(path.join(resolved, 'index.html'))) {
            problems.push(`${rel(fromFile)}:${line}  ${ref}  →  ${rel(resolved)}/  NO index.html`);
        }
        return;
    }

    problems.push(`${rel(fromFile)}:${line}  ${ref}  →  ${rel(resolved)}  MISSING`);
}

/* ── 1. HTML: seed from the layer that actually broke ────────────────────────
   A JS-only walk would miss this entirely — the four nested pages' CSS and
   script tags are exactly what went missing. */

const htmlFiles = walk(PUBLIC_ROOT, ['.html']);

for (const file of htmlFiles) {
    const src = readFileSync(file, 'utf8');
    const dir = path.dirname(file);
    let sawGoodStylesheet = false;

    const TAG = /<(script|link|img|a|source)\b[^>]*>/gi;
    for (const tag of src.matchAll(TAG)) {
        const [raw] = tag;
        const line = lineAt(src, tag.index);
        const attr = /\b(?:src|href)\s*=\s*["']([^"']+)["']/i.exec(raw);
        if (!attr) continue;
        const ref = attr[1];

        const before = problems.length;
        checkRef(file, line, ref, dir);

        if (/\brel\s*=\s*["']stylesheet["']/i.test(raw) && problems.length === before && !isExternal(ref)) {
            sawGoodStylesheet = true;
        }
    }

    // One invariant rather than a list of paths: every page must reach at least
    // one stylesheet that exists. States the "4 pages load with NO CSS" symptom
    // in a form that survives future reorganization.
    if (!sawGoodStylesheet) {
        problems.push(`${rel(file)}  references NO stylesheet that resolves`);
    }
}

/* ── 2. JS: static ESM specifiers, resolved against the IMPORTING file ────── */

const jsFiles = walk(PUBLIC_ROOT, ['.js']).filter(f => !f.includes(`${path.sep}vendor${path.sep}`));

const IMPORT_RE = /(?:^|[\s;}])(?:import|export)\s(?:[^'";]*?\sfrom\s)?\s*['"]([^'"]+)['"]/g;
const WORKER_RE = /new\s+Worker\s*\(\s*['"]([^'"]+)['"]/g;

for (const file of jsFiles) {
    const src = readFileSync(file, 'utf8');
    const dir = path.dirname(file);

    for (const m of src.matchAll(IMPORT_RE)) {
        const ref = m[1];
        const line = lineAt(src, m.index);
        if (isExternal(ref)) continue;

        // No import map and no node_modules in public/ — a bare specifier is
        // unresolvable in the browser.
        if (!ref.startsWith('.') && !ref.startsWith('/')) {
            problems.push(`${rel(file)}:${line}  ${ref}  →  bare specifier, no import map in public/`);
            continue;
        }
        // Browsers do not add `.js`.
        if (!/\.[a-z0-9]+$/i.test(ref.split('?')[0])) {
            problems.push(`${rel(file)}:${line}  ${ref}  →  missing extension (browsers do not add .js)`);
            continue;
        }
        checkRef(file, line, ref, dir);
    }

    for (const m of src.matchAll(WORKER_RE)) {
        checkRef(file, lineAt(src, m.index), m[1], dir, { requireAbsolute: true });
    }
}

/* ── 3. CSS url() — cheap, and catches the next missing background ───────── */

const CSS_URL_RE = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g;

for (const file of walk(PUBLIC_ROOT, ['.css'])) {
    const src = readFileSync(file, 'utf8');
    const dir = path.dirname(file);
    for (const m of src.matchAll(CSS_URL_RE)) {
        checkRef(file, lineAt(src, m.index), m[1], dir);
    }
}

/* ── report ──────────────────────────────────────────────────────────────── */

for (const p of problems) console.error(p);

const checked = htmlFiles.length + jsFiles.length;
console.log(
    problems.length
        ? `\nresolve: ${problems.length} unresolved reference(s) across ${checked} files`
        : `\nresolve: all references resolve (${checked} files)`
);
process.exit(problems.length ? 1 : 0);
