#!/usr/bin/env node
/**
 * One-time full-catalog seed.
 *
 *   SPACETRACK_IDENTITY=you@example.com SPACETRACK_PASSWORD=... \
 *     node workers/orbit-ingest/scripts/bootstrap.mjs --remote
 *
 * Flags:
 *   --remote     apply to the production D1 (default: --local)
 *   --local      apply to the local D1 used by `wrangler dev`
 *   --http       apply over the D1 HTTP API instead of shelling out to
 *                wrangler, using the same env as the Actions runner. Implies
 *                --remote; this is how the seed runs from CI, where the
 *                credentials already live and wrangler does not.
 *   --dry-run    fetch and write the .sql chunks, apply nothing
 *   --from-file  read a saved JSON response instead of calling Space-Track
 *                (use this to iterate — GP is capped at one call per hour)
 *   --out DIR    where to write the chunks (default: .bootstrap/)
 *
 * **Why this is a script and not a Worker job.** Parsing ~28k objects and
 * upserting them in one invocation would exceed the Workers CPU limit, and the
 * seed is a migration rather than a schedule — it runs once, by hand, and then
 * the 6-hourly delta keeps the catalog current forever. This is also the
 * "store it on your own servers; do not download it again" pattern the
 * Space-Track docs mandate.
 *
 * It makes exactly ONE upstream query. Re-running it burns another GP call
 * against a 1/hour cap, so use --from-file while iterating.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';

import { Q } from '../src/spacetrack.js';
import { streamJsonRows } from '../src/jsonstream.js';
import { GP_PREDICATES, OBJECT_COLUMNS, deriveObjectRow } from '../src/derive.js';
import { sqlLiteral, D1Http } from './env-node.mjs';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };

const HTTP     = has('--http');
const REMOTE   = has('--remote') || HTTP;
const DRY      = has('--dry-run');
const FROMFILE = val('--from-file', null);
const OUT      = path.resolve(val('--out', '.bootstrap'));
const BASE     = process.env.SPACETRACK_BASE || 'https://www.space-track.org';
const DB       = 'orbit-catalog';

/**
 * Statements per chunk file. `wrangler d1 execute --file` sends the whole file
 * in one request, so this bounds the payload; 2,000 upserts of 39 columns is
 * roughly 2 MB of SQL, which lands comfortably.
 *
 * The HTTP API takes the same statements as one JSON body, where 2 MB is less
 * comfortable, so that path uses smaller chunks — 56 requests instead of 14,
 * which costs nothing next to the single upstream call this whole script is
 * built around.
 */
const CHUNK = HTTP ? 500 : 2000;

/* ── Space-Track ────────────────────────────────────────────────────────── */

async function login() {
  const identity = process.env.SPACETRACK_IDENTITY;
  const password = process.env.SPACETRACK_PASSWORD;
  if (!identity || !password) {
    console.error('Set SPACETRACK_IDENTITY and SPACETRACK_PASSWORD in the environment.');
    console.error('There is no API key — those two values ARE the credentials.');
    process.exit(2);
  }
  const resp = await fetch(`${BASE}/ajaxauth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ identity, password }).toString(),
  });
  if (!resp.ok) throw new Error(`login failed: ${resp.status} ${await resp.text()}`);
  const raw = resp.headers.getSetCookie ? resp.headers.getSetCookie()
                                        : [resp.headers.get('set-cookie')].filter(Boolean);
  const cookie = raw.map((c) => String(c).split(';')[0].trim()).join('; ');
  if (!cookie) throw new Error('login returned no session cookie');
  return cookie;
}

async function catalogStream() {
  if (FROMFILE) {
    console.log(`Reading ${FROMFILE} (no upstream call).`);
    return Readable.toWeb(fs.createReadStream(FROMFILE));
  }
  const cookie = await login();
  const url = `${BASE}/basicspacedata/query/${Q.gpFull(GP_PREDICATES)}`;
  console.log(`GET ${url}`);
  const resp = await fetch(url, { headers: { Cookie: cookie, Accept: 'application/json' } });
  if (!resp.ok) throw new Error(`query failed: ${resp.status} ${(await resp.text()).slice(0, 300)}`);
  return resp.body;
}

/* ── SQL emission ───────────────────────────────────────────────────────── */

// Shared with the Actions runner's D1 shim — one escaping rule, one place to
// get it wrong.
const literal = sqlLiteral;

const COLS = OBJECT_COLUMNS.join(', ');
const SETS = OBJECT_COLUMNS
  .filter((c) => c !== 'NORAD_CAT_ID' && c !== 'first_seen')
  .map((c) => `${c} = excluded.${c}`).join(', ');

function upsertStatement(values) {
  return `INSERT INTO objects (${COLS}) VALUES (${values.map(literal).join(', ')}) ` +
         `ON CONFLICT(NORAD_CAT_ID) DO UPDATE SET ${SETS};`;
}

/* ── Main ───────────────────────────────────────────────────────────────── */

const now = new Date().toISOString();
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) {
  if (f.endsWith('.sql')) fs.unlinkSync(path.join(OUT, f));
}

let rows = 0;
let chunkIndex = 0;
let buffer = [];
const files = [];

function flushChunk() {
  if (!buffer.length) return;
  const file = path.join(OUT, `objects_${String(chunkIndex).padStart(3, '0')}.sql`);
  fs.writeFileSync(file, buffer.join('\n') + '\n');
  files.push(file);
  chunkIndex++;
  buffer = [];
}

const stream = await catalogStream();
for await (const gp of streamJsonRows(stream)) {
  if (!gp || gp.NORAD_CAT_ID == null) continue;
  buffer.push(upsertStatement(deriveObjectRow(gp, now)));
  rows++;
  if (buffer.length >= CHUNK) {
    flushChunk();
    process.stdout.write(`\r  ${rows} objects → ${chunkIndex} chunk(s)`);
  }
}
flushChunk();
process.stdout.write(`\r  ${rows} objects → ${chunkIndex} chunk(s)\n`);

if (!rows) {
  console.error('No rows parsed — refusing to apply an empty seed.');
  process.exit(1);
}

// The seed consumed one GP call. Log it in api_calls so the budget guard's
// rolling-hour view matches reality and a follow-up delta does not fire into
// what upstream still counts as a busy hour.
if (!FROMFILE) {
  const log = path.join(OUT, 'zzz_api_call.sql');
  fs.writeFileSync(log,
    `INSERT INTO api_calls (ts, class, url, status, rows, ms) VALUES ` +
    `(${Date.now()}, 'gp', 'bootstrap:${Q.gpFull().replace(/'/g, "''")}', 200, ${rows}, 0);\n`);
  files.push(log);
}

if (DRY) {
  console.log(`Dry run — ${files.length} file(s) in ${OUT}, nothing applied.`);
  process.exit(0);
}

if (HTTP) {
  // Same transport the scheduled ingest uses, so the seed needs no wrangler and
  // no interactive login — which is what lets it run from Actions against the
  // secrets already stored there.
  const d1 = new D1Http({
    accountId:  requireEnv('CLOUDFLARE_ACCOUNT_ID'),
    databaseId: requireEnv('ORBIT_D1_DATABASE_ID'),
    apiToken:   requireEnv('CLOUDFLARE_API_TOKEN'),
  });
  console.log(`Applying ${files.length} chunk(s) to ${DB} over the D1 HTTP API …`);
  for (const [i, file] of files.entries()) {
    process.stdout.write(`  [${i + 1}/${files.length}] ${path.basename(file)} `);
    await d1.exec(fs.readFileSync(file, 'utf8'));
    console.log('ok');
  }
} else {
  const scope = REMOTE ? '--remote' : '--local';
  console.log(`Applying ${files.length} file(s) to ${DB} ${scope} …`);
  for (const [i, file] of files.entries()) {
    process.stdout.write(`  [${i + 1}/${files.length}] ${path.basename(file)} `);
    execFileSync('npx', ['wrangler', 'd1', 'execute', DB, scope, '--yes', '--file', file], {
      stdio: ['ignore', 'ignore', 'inherit'],
      cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    });
    console.log('ok');
  }
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} is not set — --http needs it (and CLOUDFLARE_API_TOKEN, ORBIT_D1_DATABASE_ID).`);
    process.exit(2);
  }
  return v;
}

console.log(`\nSeeded ${rows} objects. The 6-hourly delta takes it from here.`);
console.log('Next: deploy the Worker, then let the daily job build the R2 artifacts —');
console.log('or trigger one now with  npx wrangler dev --test-scheduled.');
