/**
 * orbit-ingest — scheduled Space-Track ingest for the Orbital Relay (plan 33).
 *
 * A Worker rather than a Pages Function because **Pages Functions cannot run
 * cron triggers**. It owns the write side of the shared storage; the Pages
 * project carries read-only copies of the D1 and R2 bindings and never sees
 * ORBIT_KV, which holds the live session cookie.
 *
 * Three schedules, dispatched on `event.cron`:
 *
 *   17 * / 6 * * *   GP delta          → objects, new-object events, R2 bundles
 *   20 17 * * *      SATCAT + DECAY + BOXSCORE + SPACE WEATHER → daily catalog
 *                   state, full bundle
 *   25 17 * * 3      60-day decay predictions  → reentry watch list
 *
 * Fire one locally without waiting for the clock:
 *   npx wrangler dev --test-scheduled
 *   curl 'http://localhost:8787/__scheduled?cron=17+*%2F6+*+*+*'
 */

import { ingestGP } from './ingest-gp.js';
import { ingestSatcat } from './ingest-satcat.js';
import { ingestDecay } from './ingest-decay.js';
import { ingestBoxscore } from './ingest-boxscore.js';
import { ingestSpaceWeather } from './ingest-spaceweather.js';
import { ingestLaunchSites } from './ingest-launch-sites.js';
import { buildGroupArtifacts, buildFullCatalog, buildSummary, buildFeed, buildAnalytics } from './derive.js';
import { buildBrief } from './brief.js';
import { MAX_CALLS_PER_HOUR } from './spacetrack.js';

export const CRON_GP      = '17 */6 * * *';
export const CRON_DAILY   = '20 17 * * *';
export const CRON_WEEKLY  = '25 17 * * 3';

/**
 * Persist an ingest run report to D1 for the admin dashboard.
 * Failure here must NEVER fail the run: losing a log row beats losing an ingest.
 * steps is JSON.stringify'd explicitly because env-node.mjs's sqlLiteral() throws
 * on a non-string object — which would fail the Actions path ONLY.
 */
export async function recordRun(env, report, source = 'worker-cron') {
  if (!env?.ORBIT_DB) return;
  try {
    await env.ORBIT_DB.prepare(
      `INSERT INTO ingest_runs (ts, job, ok, total_ms, d1_requests, r2_puts, source, steps)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(Date.now() - (report.total_ms || 0), String(report.job || 'unknown'),
           report.ok ? 1 : 0, report.total_ms ?? null, report.d1_requests ?? null,
           report.r2_puts ?? null, source, JSON.stringify(report.steps || [])).run();
  } catch (err) { console.error('[orbit-ingest] recordRun failed:', err); }
}

/**
 * Run a step, capture its outcome, and keep going.
 *
 * Steps are deliberately not chained on success. A boxscore outage must not
 * cost us the R2 artifact regeneration that the globe reads — the whole point
 * of the daily job is that the site stays current, and partial data beats a
 * skipped run. Failures surface in the log and in `GET /` rather than
 * propagating and marking the whole invocation dead.
 */
async function step(report, name, fn) {
  const t0 = Date.now();
  try {
    const result = await fn();
    report.steps.push({ name, ok: true, ms: Date.now() - t0, ...result });
  } catch (err) {
    report.ok = false;
    report.steps.push({ name, ok: false, ms: Date.now() - t0, error: String(err && err.message || err) });
    console.error(`[orbit-ingest] ${name} failed:`, err);
  }
}

/**
 * Is R2 writable? Asked ONCE, before any step that would scan D1 to build an
 * artifact it cannot then store.
 *
 * **Why this exists.** On 2026-08-25 the R2 API token was deleted. Every
 * artifact PUT 401'd — but only *after* the read side had already run:
 * `buildAnalytics()` walked the whole ~32k catalog, then failed on its `put()`.
 * One dead credential cost ~1.4M D1 rows read across two runs and produced
 * nothing, while production artifacts froze a day stale. The reads are billed
 * whether or not the write lands, so the check has to come first.
 *
 * A real round trip, not a binding check: the failure mode was a *revoked*
 * credential, which an `if (env.ORBIT_R2)` cannot see. One tiny PUT + DELETE of
 * a probe key is the cheapest thing that actually proves write access.
 *
 * Fails OPEN. If the probe itself errors for some reason other than auth we
 * still attempt the artifacts — a false negative here would skip the whole
 * point of the daily job, which is worse than a wasted scan.
 */
const R2_PROBE_KEY = '_preflight/write-check';

export async function r2Writable(env) {
  if (!env?.ORBIT_R2) return { ok: false, reason: 'no ORBIT_R2 binding' };
  try {
    await env.ORBIT_R2.put(R2_PROBE_KEY, 'ok', {
      httpMetadata: { contentType: 'text/plain; charset=utf-8' },
    });
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) };
  }
  // Cleanup is best-effort — a bucket that accepts writes but refuses deletes
  // is still writable for our purpose, and the probe is 2 bytes. But it is NOT
  // optional-chained: every binding we run against (the Workers R2 binding,
  // the R2S3 shim in env-node.mjs, and test/fakes.mjs) implements delete(), so
  // `delete?.()` would silently stop cleaning up if one ever lost the method,
  // and the probe key would accumulate in the bucket unnoticed.
  try { await env.ORBIT_R2.delete(R2_PROBE_KEY); } catch (err) {
    console.warn(`[orbit-ingest] R2 preflight probe left behind: ${(err && err.message) || err}`);
  }
  return { ok: true };
}

/**
 * Like `step()`, but skipped when the preflight says R2 is unwritable.
 *
 * Recorded as `{ skipped: true }` rather than silently dropped, so the admin
 * dashboard and `ingest_runs.steps` show *why* a run produced no artifacts —
 * an empty step list would look like the job never ran.
 */
async function artifactStep(report, gate, name, fn) {
  if (!gate.ok) {
    report.ok = false;
    report.steps.push({ name, ok: false, skipped: true, ms: 0,
      error: `skipped — R2 not writable: ${gate.reason}` });
    return;
  }
  await step(report, name, fn);
}

export async function runGP(env) {
  const report = { job: 'gp', ok: true, steps: [] };
  await step(report, 'ingest-gp', () => ingestGP(env));
  // Bundles are regenerated even if the ingest failed: the previous elsets are
  // still in D1 and a fresh artifact from slightly stale data beats none.
  // But only if R2 can actually take them — see r2Writable().
  const gate = await r2Writable(env);
  await artifactStep(report, gate, 'artifacts', async () => ({ groups: await buildGroupArtifacts(env) }));
  await artifactStep(report, gate, 'feed', async () => { await buildFeed(env); return {}; });
  return report;
}

export async function runDaily(env) {
  const report = { job: 'daily', ok: true, steps: [] };
  await step(report, 'ingest-satcat', () => ingestSatcat(env));
  await step(report, 'ingest-decay', () => ingestDecay(env, 'daily'));
  await step(report, 'ingest-boxscore', () => ingestBoxscore(env));
  // NOAA SWPC (plan 34 §3.4) — a different provider from Space-Track, no
  // auth, and its own table/artifact/endpoint. Same daily cadence: the
  // indices change every 3 hours, not every 6, so once a day is plenty.
  await step(report, 'ingest-spaceweather', () => ingestSpaceWeather(env));

  // Everything below builds an R2 artifact, and every one of them scans D1
  // first. Ask once whether those writes can land at all — a revoked token
  // otherwise costs a full catalog walk per step for nothing.
  const gate = await r2Writable(env);
  if (!gate.ok) console.error(`[orbit-ingest] R2 not writable, skipping artifact steps: ${gate.reason}`);

  let groups = null;
  await artifactStep(report, gate, 'artifacts', async () => (groups = await buildGroupArtifacts(env), { groups }));
  // ~5 MB, so once a day rather than every six hours.
  await artifactStep(report, gate, 'full-catalog', async () => ({ objects: await buildFullCatalog(env) }));
  await artifactStep(report, gate, 'summary', async () => { await buildSummary(env, { groups }); return {}; });
  await artifactStep(report, gate, 'feed', async () => { await buildFeed(env); return {}; });
  // Launch history barely moves day to day (new elsets, not new launch years),
  // so once a day alongside summary rather than every six hours. This is the
  // expensive one — one pass over the whole catalog (see foldAnalytics).
  await artifactStep(report, gate, 'analytics', async () => { await buildAnalytics(env); return {}; });
  // Last, and once a day rather than every six hours: the brief narrates the
  // events the steps above have just recorded, and it is the only step that can
  // reach a model. Its own failures are already swallowed into
  // `narrative_status`, so reaching step()'s catch here means D1 or R2 broke.
  await artifactStep(report, gate, 'brief', async () => {
    const card = await buildBrief(env);
    return { narrative: card.narrative_status };
  });
  return report;
}

export async function runWeekly(env) {
  const report = { job: 'weekly', ok: true, steps: [] };
  await step(report, 'ingest-decay-60day', () => ingestDecay(env, '60day'));
  // Static ~60-row map, wrapped in step() like every other job: a failure here
  // must not take down the 60-day decay predictions this job exists for.
  await step(report, 'ingest-launch-sites', () => ingestLaunchSites(env));
  await artifactStep(report, await r2Writable(env), 'feed', async () => { await buildFeed(env); return {}; });
  return report;
}

export default {
  async scheduled(event, env, ctx) {
    const job = { [CRON_GP]: runGP, [CRON_DAILY]: runDaily, [CRON_WEEKLY]: runWeekly }[event.cron];
    if (!job) {
      console.error(`[orbit-ingest] no handler for cron "${event.cron}"`);
      return;
    }
    // waitUntil keeps the invocation alive for the whole report, including the
    // artifact writes that happen after the last upstream response.
    ctx.waitUntil((async () => {
      const report = await job(env);
      console.log('[orbit-ingest]', JSON.stringify(report));
      await recordRun(env, report, 'worker-cron');
    })());
  },

  /**
   * Status only. This Worker has no public surface by design — it holds
   * Space-Track credentials, and an unauthenticated trigger would let anyone
   * spend the account's rate budget.
   *
   * A manual reseed is available at POST /run?job=gp|daily|weekly, gated on the
   * INGEST_TOKEN secret. Set no token and the route does not exist.
   */
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/run' && request.method === 'POST') {
      const token = env.INGEST_TOKEN;
      const given = request.headers.get('authorization');
      if (!token || given !== `Bearer ${token}`) {
        return new Response('Not found', { status: 404 });
      }
      const job = { gp: runGP, daily: runDaily, weekly: runWeekly }[url.searchParams.get('job')];
      if (!job) return json({ error: 'job must be gp, daily or weekly' }, 400);
      const report = await job(env);
      await recordRun(env, report, 'manual');
      return json(report);
    }

    if (url.pathname !== '/') return new Response('Not found', { status: 404 });

    const [objects, calls, lastEvent] = await Promise.all([
      env.ORBIT_DB.prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS t FROM objects').first(),
      env.ORBIT_DB.prepare('SELECT COUNT(*) AS n FROM api_calls WHERE ts > ?')
        .bind(Date.now() - 3600_000).first(),
      env.ORBIT_DB.prepare('SELECT ts, kind FROM events ORDER BY id DESC LIMIT 1').first(),
    ]).catch(() => [null, null, null]);

    return json({
      worker: 'orbit-ingest',
      objects: objects ? objects.n : null,
      last_ingest: objects ? objects.t : null,
      calls_last_hour: calls ? calls.n : null,
      budget_limit: MAX_CALLS_PER_HOUR,
      last_event: lastEvent || null,
      crons: [CRON_GP, CRON_DAILY, CRON_WEEKLY],
    });
  },
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
