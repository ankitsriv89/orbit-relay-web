/**
 * Export D1 per-query stats from the Cloudflare GraphQL Analytics API.
 *
 *     node workers/orbit-ingest/scripts/d1-query-stats.mjs [--hours 1] [--json]
 *
 * The D1 dashboard's "Queries" table has no export button. This pulls the same
 * data — `d1QueriesAdaptiveGroups` — so a performance change can be checked as a
 * diff between two runs rather than by comparing screenshots.
 *
 * **Why this exists.** D1 bills rows the engine *visits*, not rows returned, and
 * the ratio of the two is the only reliable signal of a scan hiding behind a
 * LIMIT. On 2026-08-25 three separate read-amplification bugs (OFFSET paging, a
 * GROUP BY MAX over the whole decay table, a mis-planned index) were each
 * invisible in query *counts* and obvious in that ratio. See CLAUDE.md's
 * "Reading the D1 dashboard".
 *
 * Reads from .env (gitignored) or the environment:
 *   CLOUDFLARE_ANALYTICS_TOKEN   needs **Account Analytics: Read**. This is NOT
 *                                the same scope as the D1:Edit token the ingest
 *                                uses — a D1:Edit token returns an empty
 *                                `viewer.accounts` array rather than a 403,
 *                                which looks exactly like "no data".
 *   CLOUDFLARE_ACCOUNT_ID
 *   ORBIT_D1_DATABASE_ID
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * The database id is public (it is in the workflow file and the D1 dashboard
 * URL); only the token is a secret. Defaulted so the script runs from a .env
 * that carries just the credentials.
 */
const DEFAULT_DB_ID = 'e5fe1563-71ef-4fb4-9e04-554c87caf821';

/**
 * .env values, without overwriting anything already in the real environment.
 * Split on /\r?\n/ — the repo's .env is CRLF on this box, and splitting on '\n'
 * alone leaves a trailing \r inside every value, which makes an Authorization
 * header fail in a way that looks like a bad token.
 */
function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const value = m[2].trim().replace(/^["']|["']$/g, '');
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  }
}

const QUERY = `
  query D1Queries($account: String!, $db: String!, $since: Time!) {
    viewer {
      accounts(filter: { accountTag: $account }) {
        d1QueriesAdaptiveGroups(
          limit: 100
          filter: { databaseId: $db, datetime_geq: $since }
          orderBy: [sum_rowsRead_DESC]
        ) {
          count
          sum { rowsRead rowsReturned rowsWritten queryDurationMs }
          dimensions { query }
        }
      }
    }
  }`;

async function main() {
  loadDotEnv();

  const token   = process.env.CLOUDFLARE_ANALYTICS_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const db      = process.env.ORBIT_D1_DATABASE_ID || DEFAULT_DB_ID;

  const missing = [
    ['CLOUDFLARE_ANALYTICS_TOKEN', token],
    ['CLOUDFLARE_ACCOUNT_ID', account],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error(`Missing: ${missing.join(', ')} (set in .env or the environment)`);
    process.exit(2);
  }

  const hours = Number(argOf('--hours') || 1);
  const since = new Date(Date.now() - hours * 3600_000).toISOString();

  const resp = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: { account, db, since } }),
  });

  const body = await resp.json();
  if (!resp.ok || body.errors) {
    console.error(`GraphQL failed (HTTP ${resp.status}):`);
    console.error(JSON.stringify(body.errors || body, null, 2));
    process.exit(1);
  }

  const accounts = body.data?.viewer?.accounts || [];
  if (!accounts.length) {
    // Distinguished from "no queries in the window" because the causes differ:
    // an empty accounts array almost always means the token lacks Account
    // Analytics: Read, not that the database was idle.
    console.error('No accounts returned — the token most likely lacks ' +
                  '"Account Analytics: Read" (a D1:Edit token fails this way, silently).');
    process.exit(1);
  }

  // Verified 2026-08-25: CLOUDFLARE_ANALYTICS_TOKEN in .env authenticates fine
  // (a bad token 401s at the HTTP layer) but returns
  //   {code: "authz", message: "not authorized for that account"}
  // on the d1QueriesAdaptiveGroups path — it does not carry Account Analytics:
  // Read. Fix in the dashboard: My Profile → API Tokens → edit the token →
  // Permissions → add **Account · Account Analytics · Read**. Nothing in this
  // script can work around it.

  const rows = accounts[0].d1QueriesAdaptiveGroups || [];
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (!rows.length) {
    console.log(`No queries recorded in the last ${hours}h.`);
    return;
  }

  const totals = rows.reduce((a, r) => ({
    read:  a.read  + (r.sum.rowsRead || 0),
    write: a.write + (r.sum.rowsWritten || 0),
  }), { read: 0, write: 0 });

  console.log(`\nD1 query stats — last ${hours}h (${rows.length} distinct queries)`);
  console.log(`Rows read: ${fmt(totals.read)}   Rows written: ${fmt(totals.write)}\n`);
  console.log(pad('ROWS READ', 12) + pad('COUNT', 8) + pad('READ/CALL', 11) +
              pad('READ/RET', 10) + 'QUERY');
  console.log('-'.repeat(110));

  for (const r of rows) {
    const read = r.sum.rowsRead || 0;
    const ret  = r.sum.rowsReturned || 0;
    console.log(
      pad(fmt(read), 12) +
      pad(String(r.count), 8) +
      pad(r.count ? Math.round(read / r.count).toLocaleString() : '—', 11) +
      pad(ret ? Math.round(read / ret).toLocaleString() : '—', 10) +
      oneLine(r.dimensions.query).slice(0, 58));
  }

  // read/returned is the scan detector: ~1 is an index seek, and a full walk of
  // this catalog is ~28k. read/call alone is misleading for a paged read, where
  // a legitimately large result is fetched 1000 rows at a time.
  const worst = rows.filter((r) => r.sum.rowsReturned &&
                                   (r.sum.rowsRead / r.sum.rowsReturned) > 100);
  if (worst.length) {
    console.log(`\n⚠  ${worst.length} quer${worst.length === 1 ? 'y' : 'ies'} reading >100 rows per row returned — a scan, not a seek:`);
    for (const r of worst) {
      console.log(`   ${Math.round(r.sum.rowsRead / r.sum.rowsReturned).toLocaleString()}x  ${oneLine(r.dimensions.query).slice(0, 70)}`);
    }
  }
  console.log();
}

const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
};
const fmt = (n) => n.toLocaleString();
const pad = (s, n) => String(s).padEnd(n);
const oneLine = (q) => String(q).replace(/\s+/g, ' ').trim();

main().catch((err) => { console.error(err); process.exit(1); });
