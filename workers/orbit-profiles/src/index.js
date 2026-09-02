/**
 * orbit-profiles — the enrichment pipeline (Task 6).
 *
 * Four stages — match, facts, prose, images — each independently restartable
 * and checkpointed by last-completed NORAD. A run that dies at object 14,000
 * restarts at 14,000. GitHub caps a single job at 6 hours, so the Actions
 * workflow chunks by NORAD range (`toNorad`) and a resumed run is a narrower
 * query, not a re-scan.
 *
 * Orchestration mirrors workers/orbit-ingest/src/index.js's step() pattern:
 * per-stage failures are captured and the run continues — a stuck image fetch
 * must not cost the prose that was already generated — and the report records
 * what failed so a quietly-degrading run still shows up red.
 *
 * FOLLOW-UP, do not build here: after v1 only new launches need profiling — a
 * small daily delta hooked to the existing SATCAT ingest in
 * workers/orbit-ingest. It piggybacks that run; there is deliberately NO
 * schedule in orbit-profiles.yml and no cron in this worker.
 */
import { readCheckpoint, writeCheckpoint, STAGES } from './checkpoint.js';
import { normalizeCospar } from './match.js';
import { resolveConflicts, writeFacts } from './facts.js';
import { tier2Prose } from './prose-tier2.js';
import { tier3Prose, isSubstantive } from './prose-tier3.js';
import { ingestImage } from './images.js';
import { buildGcatIndex } from './gcat.js';
import { seedSources } from './sources.js';

export { STAGES };

/** Rows per chunk-internal page — keeps a stage's working set bounded. */
const PAGE = 500;

async function step(report, name, fn) {
  const t0 = Date.now();
  try {
    const result = await fn();
    report.steps.push({ name, ok: true, ms: Date.now() - t0, ...result });
  } catch (err) {
    report.ok = false;
    report.steps.push({ name, ok: false, ms: Date.now() - t0, error: String((err && err.message) || err) });
    console.error(`[orbit-profiles] ${name} failed:`, err);
  }
}

/**
 * @param {object} env  { PROFILE_DB, ORBIT_DB, ORBIT_R2, ORBIT_AI, ORBIT_AI_MODEL }
 * @param {object} [opts]
 * @param {number} [opts.toNorad]   upper NORAD bound for this chunk (exclusive of higher)
 * @param {string} [opts.only]      run just this one stage
 * @param {Record<string, Function>} [opts.stages]  injected stage impls (tests)
 * @param {{read:Function, write:Function}} [opts.checkpointIO]  injected checkpoint store (tests)
 * @param {Function} [opts.seedSources]  injected allowlist seeder (tests)
 */
export async function runProfiles(env, opts = {}) {
  const report = { job: 'profiles', ok: true, steps: [] };
  const stages = opts.stages || DEFAULT_STAGES;
  const io = opts.checkpointIO || { read: readCheckpoint, write: writeCheckpoint };
  const seed = opts.seedSources || seedSources;
  const toRun = opts.only ? [opts.only] : STAGES;

  // The `sources` table is a precondition, not a stage: facts.js enforces the
  // allowlist against the SOURCES constant, but the UI renders attribution from
  // this table, so it must be populated before any facts land. Idempotent
  // upsert of four rows — cheap enough to run unconditionally, every run.
  await step(report, 'seed-sources', async () => ({ seeded: await seed(env.PROFILE_DB) }));

  for (const name of toRun) {
    const fn = stages[name];
    if (!fn) continue;
    await step(report, name, async () => {
      const fromNorad = await io.read(env.PROFILE_DB, name);
      const ctx = {
        env,
        fromNorad,
        toNorad: opts.toNorad ?? Infinity,
        checkpoint: (norad) => io.write(env.PROFILE_DB, name, norad),
      };
      return fn(ctx);
    });
  }

  return report;
}

/* ── the real stages ───────────────────────────────────────────────────────
 *
 * Each pages a NORAD-ordered slice of the catalogue (fromNorad, toNorad],
 * processes it, writes, then checkpoints the last NORAD it finished — the
 * checkpoint lands AFTER the D1 write returns, so a crash between the two
 * re-does an idempotent chunk rather than skipping it.
 */

/** Catalogue rows for one page above `after`, up to `to`. */
async function catalogPage(env, after, to) {
  const bound = Number.isFinite(to) ? to : 9_999_999;
  const { results } = await env.ORBIT_DB.prepare(`
    SELECT NORAD_CAT_ID, OBJECT_NAME, OBJECT_TYPE, OBJECT_ID, LAUNCH_DATE,
           INCLINATION, APOAPSIS, PERIAPSIS, COUNTRY_CODE, regime
    FROM objects
    WHERE NORAD_CAT_ID > ? AND NORAD_CAT_ID <= ?
    ORDER BY NORAD_CAT_ID
    LIMIT ?
  `).bind(after, bound, PAGE).all();
  return results || [];
}

async function runMatch(ctx) {
  const { env } = ctx;
  let after = ctx.fromNorad;
  let matched = 0;
  let rows = await catalogPage(env, after, ctx.toNorad);
  while (rows.length) {
    for (const row of rows) {
      const cospar = normalizeCospar(row.OBJECT_ID);
      if (!cospar) continue;
      await env.PROFILE_DB.prepare(`
        INSERT INTO profiles (norad, cospar, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(norad) DO UPDATE SET cospar = excluded.cospar, updated_at = excluded.updated_at
      `).bind(row.NORAD_CAT_ID, cospar, new Date().toISOString()).run();
      matched++;
    }
    after = rows[rows.length - 1].NORAD_CAT_ID;
    await ctx.checkpoint(after);
    rows = await catalogPage(env, after, ctx.toNorad);
  }
  return { processed: matched };
}

async function runFacts(ctx) {
  const { env } = ctx;
  const sources = await loadSourceIndex(env);   // COSPAR → merged NSSDCA/GCAT fields
  let after = ctx.fromNorad;
  let written = 0;
  let rows = await catalogPage(env, after, ctx.toNorad);
  while (rows.length) {
    for (const row of rows) {
      const cospar = normalizeCospar(row.OBJECT_ID);
      const candidate = cospar && sources.get(cospar);
      if (!candidate) continue;
      const resolved = resolveConflicts(candidate.byField);
      await writeFacts(env.PROFILE_DB, row.NORAD_CAT_ID, resolved, candidate.spine);
      written++;
    }
    after = rows[rows.length - 1].NORAD_CAT_ID;
    await ctx.checkpoint(after);
    rows = await catalogPage(env, after, ctx.toNorad);
  }
  return { processed: written };
}

async function runProse(ctx) {
  const { env } = ctx;
  const model = env.ORBIT_AI_MODEL || 'openai/gpt-oss-20b';
  let after = ctx.fromNorad;
  let t2 = 0;
  let t3 = 0;
  let rows = await catalogPage(env, after, ctx.toNorad);
  while (rows.length) {
    for (const row of rows) {
      const fallback = tier2Prose(row);
      const facts = await loadProfileFacts(env, row.NORAD_CAT_ID);
      const { prose, tier } = isSubstantive(facts)
        ? await tier3Prose(env.ORBIT_AI, model, facts, fallback)
        : { prose: fallback, tier: 2 };
      await env.PROFILE_DB.prepare(`
        UPDATE profiles SET prose = ?, prose_tier = ?, updated_at = ? WHERE norad = ?
      `).bind(prose, tier, new Date().toISOString(), row.NORAD_CAT_ID).run();
      if (tier === 3) t3++; else t2++;
    }
    after = rows[rows.length - 1].NORAD_CAT_ID;
    await ctx.checkpoint(after);
    rows = await catalogPage(env, after, ctx.toNorad);
  }
  return { processed: t2 + t3, tier2: t2, tier3: t3 };
}

async function runImages(ctx) {
  const { env } = ctx;
  let after = ctx.fromNorad;
  let stored = 0;
  let rows = await catalogPage(env, after, ctx.toNorad);
  while (rows.length) {
    for (const row of rows) {
      const candidate = await imageCandidateFor(env, row);
      if (!candidate) continue;
      const out = await ingestImage(env, row.NORAD_CAT_ID, candidate);
      if (!out) continue;
      const isPrimary = await isFirstImage(env, row.NORAD_CAT_ID);
      await env.PROFILE_DB.prepare(`
        INSERT INTO images (norad, r2_key, thumb_key, width, height, credit, license, source_url, is_primary, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(norad, r2_key) DO UPDATE SET
          thumb_key = excluded.thumb_key, width = excluded.width, height = excluded.height,
          credit = excluded.credit, license = excluded.license, source_url = excluded.source_url,
          updated_at = excluded.updated_at
      `).bind(row.NORAD_CAT_ID, out.r2_key, out.thumb_key, out.width, out.height,
              out.credit, out.license, out.source_url, isPrimary ? 1 : 0,
              new Date().toISOString()).run();
      stored++;
    }
    after = rows[rows.length - 1].NORAD_CAT_ID;
    await ctx.checkpoint(after);
    rows = await catalogPage(env, after, ctx.toNorad);
  }
  return { processed: stored };
}

/** True when the object has no `images` row yet — the first one is is_primary. */
async function isFirstImage(env, norad) {
  const row = await env.PROFILE_DB
    .prepare('SELECT 1 AS one FROM images WHERE norad = ? LIMIT 1')
    .bind(norad)
    .first();
  return !row;
}

/**
 * An allowlisted image candidate ({url, thumbUrl?, credit, license, source_id})
 * for a catalogue row, or null. Wired to the NASA image asset API with the first
 * real Actions run; a stub here keeps `images` a clean no-op until then rather
 * than failing the stage, and the encyclopedia renders the typed placeholder.
 */
async function imageCandidateFor(_env, _row) {
  return null;
}

/** The verified spine facts a profile already holds — Tier 3's input. */
async function loadProfileFacts(env, norad) {
  const row = await env.PROFILE_DB
    .prepare('SELECT * FROM profiles WHERE norad = ?')
    .bind(norad)
    .first();
  return row || {};
}

/** GCAT bulk files. Overridable by env for pinning a revision or a local mirror. */
const GCAT_SATCAT_URL = 'https://planet4589.org/space/gcat/tsv/cat/satcat.tsv';
const GCAT_ORGS_URL = 'https://planet4589.org/space/gcat/tsv/tables/orgs.tsv';

async function fetchText(url) {
  const resp = await fetch(url, { headers: { 'user-agent': 'orbit-relay-web/orbit-profiles (+orbitalrelay.space)' } });
  if (!resp.ok) throw new Error(`GET ${url} -> ${resp.status}`);
  return resp.text();
}

/**
 * COSPAR → {byField, spine} — the fact index runFacts() joins the catalogue to.
 *
 * v1 source is GCAT satcat.tsv (CC-BY), fetched once per run and held in memory
 * (~5 MB), with its Owner / State / Manufacturer codes resolved through
 * orgs.tsv. Parsing is in gcat.js; this is the fetch shim, kept behind one
 * function so the pipeline shape stays testable without the network.
 *
 * NSSDCA is the intended second source (best descriptive text — it would own
 * mission_summary, mission_type, power_w, design_life_years, and win
 * operator/owner conflicts at priority 100). It has no bulk dump, so it is a
 * per-object scrape and a separate task. When it lands it builds a second
 * COSPAR → {byField, spine} index of the same shape and merges in HERE: append
 * its byField candidates (resolveConflicts picks the winner by priority) and
 * fill spine columns GCAT left null.
 */
async function loadSourceIndex(env) {
  const [satcat, orgs] = await Promise.all([
    fetchText(env.GCAT_SATCAT_URL || GCAT_SATCAT_URL),
    fetchText(env.GCAT_ORGS_URL || GCAT_ORGS_URL),
  ]);
  return buildGcatIndex(satcat, orgs);
}

const DEFAULT_STAGES = {
  match: runMatch,
  facts: runFacts,
  prose: runProse,
  images: runImages,
};
