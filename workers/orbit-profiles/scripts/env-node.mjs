/**
 * A Workers-shaped `env` for the profile pipeline, from plain Node.
 *
 * This is a THIN re-export of workers/orbit-ingest/scripts/env-node.mjs: its
 * D1Http, R2S3, memoryKV and createAI implementations are already tested
 * (env-node.test.mjs, spacetrack.test.mjs) and must not be duplicated here. The
 * only differences are the bindings this pipeline needs:
 *
 *   PROFILE_DB  → the orbit-profiles D1 (its own database id)
 *   ORBIT_DB    → the orbit-catalog D1, READ-ONLY here (the `objects` table is
 *                 the pipeline's input; orbit-ingest remains its only writer)
 *   ORBIT_R2    → the shared bucket, for profile images
 *   ORBIT_AI    → the Tier 3 client, or null (facts-only is a supported state)
 *
 * Env vars, all from the workflow's repo secrets:
 *   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN   (D1:Edit on both databases)
 *   PROFILE_D1_DATABASE_ID, ORBIT_D1_DATABASE_ID
 *   R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 * Optional Tier 3: ORBIT_AI_PROVIDER (groq | workers-ai), GROQ_API_KEY,
 *   ORBIT_AI_MODEL (defaults to openai/gpt-oss-20b for groq).
 */
import { D1Http, R2S3, memoryKV } from '../../orbit-ingest/scripts/env-node.mjs';
import { createAI, PROFILE_TIER3_MODEL } from '../../orbit-ingest/scripts/ai-node.mjs';

const API_BASE = 'https://api.cloudflare.com/client/v4';

function need(source, name) {
  const v = typeof source[name] === 'string' ? source[name].trim() : source[name];
  if (!v) throw new Error(`${name} is not set — add it to the workflow's repo secrets.`);
  return v;
}

/**
 * @param {object} [source]     defaults to process.env
 * @param {object} [overrides]  injected bindings, for tests
 */
export function createEnv(source = process.env, overrides = {}) {
  const accountId = need(source, 'CLOUDFLARE_ACCOUNT_ID');
  const apiToken = need(source, 'CLOUDFLARE_API_TOKEN');
  const apiBase = source.CLOUDFLARE_API_BASE || API_BASE;

  return {
    PROFILE_DB: overrides.PROFILE_DB || new D1Http({
      accountId, databaseId: need(source, 'PROFILE_D1_DATABASE_ID'), apiToken, apiBase,
    }),
    ORBIT_DB: overrides.ORBIT_DB || new D1Http({
      accountId, databaseId: need(source, 'ORBIT_D1_DATABASE_ID'), apiToken, apiBase,
    }),
    ORBIT_R2: overrides.ORBIT_R2 || new R2S3({
      accountId,
      bucket: source.ORBIT_R2_BUCKET || 'orbit-data',
      accessKeyId: need(source, 'R2_ACCESS_KEY_ID'),
      secretAccessKey: need(source, 'R2_SECRET_ACCESS_KEY'),
      endpoint: source.R2_ENDPOINT || null,
    }),
    ORBIT_KV: overrides.ORBIT_KV || memoryKV(),
    ORBIT_AI: 'ORBIT_AI' in overrides ? overrides.ORBIT_AI : createAI(source),
    ORBIT_AI_MODEL: source.ORBIT_AI_MODEL || PROFILE_TIER3_MODEL,
  };
}
