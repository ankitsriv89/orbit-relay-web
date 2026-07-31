#!/usr/bin/env node
/**
 * Run one ingest job from Node — the GitHub Actions entry point (plan 33 wave 2b).
 *
 *   node workers/orbit-ingest/scripts/run-ingest.mjs gp
 *   node workers/orbit-ingest/scripts/run-ingest.mjs daily
 *   node workers/orbit-ingest/scripts/run-ingest.mjs weekly
 *
 * The job functions are imported from `src/index.js` unchanged — the same code
 * the Worker's `scheduled()` handler calls. Only the `env` differs, and that is
 * the whole of wave 2b. `wrangler.toml`'s crons and that handler stay in the
 * repo, deployable and unused, as the fallback if Actions ever becomes annoying.
 *
 * Exit codes: 0 all steps ok · 1 at least one step failed · 2 misconfigured.
 * A step failure is deliberately non-fatal *within* a run — a boxscore outage
 * must not cost the R2 artifact regeneration the globe reads — but it does fail
 * the workflow, so a quietly-degrading ingest still shows up as a red run.
 */

import { runGP, runDaily, runWeekly } from '../src/index.js';
import { createEnv } from './env-node.mjs';
import fs from 'node:fs';

const JOBS = { gp: runGP, daily: runDaily, weekly: runWeekly };

const name = process.argv[2];
const job = JOBS[name];
if (!job) {
  console.error(`Usage: run-ingest.mjs <${Object.keys(JOBS).join('|')}>`);
  process.exit(2);
}

let env;
try {
  env = createEnv();
} catch (err) {
  console.error(String(err && err.message || err));
  process.exit(2);
}

const t0 = Date.now();
let report;
try {
  report = await job(env);
} catch (err) {
  // step() catches per-step failures, so reaching here means the job itself
  // could not start — bad credentials, or the budget guard tripping.
  console.error(`[orbit-ingest] ${name} threw:`, err);
  report = { job: name, ok: false, steps: [{ name: 'job', ok: false, error: String(err && err.message || err) }] };
}

report.total_ms = Date.now() - t0;
report.d1_requests = env.ORBIT_DB.requests;
report.r2_puts = env.ORBIT_R2.puts;
console.log(JSON.stringify(report, null, 2));

// The run log is the only place this job is observable, so make the summary
// readable without opening the raw log.
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = report.steps
    .map((s) => `| ${s.name} | ${s.ok ? '✅' : '❌'} | ${s.ms ?? ''} | ${detail(s)} |`)
    .join('\n');
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `### orbit-ingest \`${name}\` — ${report.ok ? 'ok' : 'FAILED'}\n\n` +
    `| step | ok | ms | detail |\n|---|---|---|---|\n${rows}\n\n` +
    `${report.total_ms} ms total · ${report.d1_requests} D1 requests · ${report.r2_puts} R2 puts\n\n`);
}

process.exit(report.ok ? 0 : 1);

function detail(step) {
  if (step.error) return String(step.error).replace(/\|/g, '\\|').slice(0, 200);
  const { name: _n, ok: _o, ms: _m, ...rest } = step;
  const keys = Object.keys(rest);
  if (!keys.length) return '';
  return keys.map((k) => {
    const v = rest[k];
    return `${k}=${v && typeof v === 'object' ? Object.values(v).reduce((a, b) => a + b, 0) : v}`;
  }).join(' · ');
}
