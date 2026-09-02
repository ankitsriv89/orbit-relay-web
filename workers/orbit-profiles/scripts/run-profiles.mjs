#!/usr/bin/env node
/**
 * Run the profile pipeline from Node — the GitHub Actions entry point.
 *
 *   node workers/orbit-profiles/scripts/run-profiles.mjs                 # all stages
 *   node workers/orbit-profiles/scripts/run-profiles.mjs --only prose
 *   node workers/orbit-profiles/scripts/run-profiles.mjs --to 15000      # chunk: NORAD ≤ 15000
 *
 * Same exit-code contract as run-ingest.mjs: 0 all stages ok · 1 a stage
 * failed · 2 misconfigured. A stage failure is non-fatal within a run (a stuck
 * image fetch must not cost generated prose) but fails the workflow, so a
 * quietly-degrading run still shows up red.
 */
import fs from 'node:fs';
import { runProfiles } from '../src/index.js';
import { createEnv } from './env-node.mjs';

const args = process.argv.slice(2);
const opts = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--only') opts.only = args[++i];
  else if (args[i] === '--to') opts.toNorad = Number(args[++i]);
  else { console.error(`unknown argument: ${args[i]}`); process.exit(2); }
}
if (opts.toNorad != null && !Number.isFinite(opts.toNorad)) {
  console.error('--to needs a number'); process.exit(2);
}

let env;
try {
  env = createEnv();
} catch (err) {
  console.error(String((err && err.message) || err));
  process.exit(2);
}

const t0 = Date.now();
let report;
try {
  report = await runProfiles(env, opts);
} catch (err) {
  console.error('[orbit-profiles] pipeline threw:', err);
  report = { job: 'profiles', ok: false, steps: [{ name: 'pipeline', ok: false, error: String((err && err.message) || err) }] };
}
report.total_ms = Date.now() - t0;
report.d1_requests = (env.PROFILE_DB?.requests || 0) + (env.ORBIT_DB?.requests || 0);
report.r2_puts = env.ORBIT_R2?.puts || 0;
console.log(JSON.stringify(report, null, 2));

if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = report.steps
    .map((s) => `| ${s.name} | ${s.ok ? '✅' : '❌'} | ${s.ms ?? ''} | ${detail(s)} |`)
    .join('\n');
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `### orbit-profiles${opts.only ? ` \`${opts.only}\`` : ''}${opts.toNorad ? ` (≤ ${opts.toNorad})` : ''} — ${report.ok ? 'ok' : 'FAILED'}\n\n` +
    `| stage | ok | ms | detail |\n|---|---|---|---|\n${rows}\n\n` +
    `${report.total_ms} ms total · ${report.d1_requests} D1 requests · ${report.r2_puts} R2 puts\n\n`);
}

process.exit(report.ok ? 0 : 1);

function detail(step) {
  if (step.error) return String(step.error).replace(/\|/g, '\\|').slice(0, 200);
  const { name: _n, ok: _o, ms: _m, ...rest } = step;
  const keys = Object.keys(rest);
  return keys.length ? keys.map((k) => `${k}=${rest[k]}`).join(' · ') : '';
}
