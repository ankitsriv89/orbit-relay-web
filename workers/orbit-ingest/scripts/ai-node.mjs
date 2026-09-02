/**
 * The text-generation client for the daily brief, from Node (plan 33 wave 6).
 *
 * `src/brief.js` is written against the **Workers AI binding interface** —
 * `env.ORBIT_AI.run(model, input)` returning `{ response }` — for the same
 * reason the D1 and R2 shims in `env-node.mjs` mimic their bindings: `src/*`
 * stays the code that would run in the Worker, and every test keeps covering
 * the real thing. This file is the Node end of that interface.
 *
 * ## Why Workers AI is the default
 *
 * The call happens **once a day, from a GitHub Actions runner**. That pricing
 * out at fractions of a cent either way, and it makes latency irrelevant —
 * which is most of what a faster inference host is selling. What is left is
 * operational surface, and Workers AI has none to add: the account, the D1, the
 * R2 and the API-token plumbing already exist, so enabling this is one extra
 * permission on a token that is already in the repo secrets rather than a new
 * vendor, a new account and a new ToS.
 *
 * ## Why the seam exists anyway
 *
 * The plan's own exit criterion for this wave is "drop it if the output reads
 * as filler", and the most likely cause of filler is the model rather than the
 * prompt. So the provider is a variable:
 *
 *   ORBIT_AI_PROVIDER=workers-ai   (default)
 *   ORBIT_AI_PROVIDER=groq         + GROQ_API_KEY
 *
 * Both return `{ response }`, so `src/brief.js` cannot tell them apart and the
 * grounding gate applies identically. Note that a bigger model is available
 * without leaving Cloudflare — `ORBIT_AI_MODEL=@cf/meta/llama-3.3-70b-instruct-fp8-fast`
 * — so try that before reaching for another vendor.
 */

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';
const GROQ_API_BASE = 'https://api.groq.com/openai/v1';

/** Workers AI over the REST API. Requires a token with **Workers AI: Read**. */
export class WorkersAI {
  constructor({ accountId, apiToken, apiBase = CF_API_BASE, fetch: f = globalThis.fetch }) {
    this.accountId = accountId;
    this.apiToken = apiToken;
    this.apiBase = apiBase;
    this.fetch = f;
    this.calls = 0;
  }

  async run(model, input) {
    this.calls++;
    const url = `${this.apiBase}/accounts/${this.accountId}/ai/run/${model}`;
    const resp = await this.fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    });

    const text = await resp.text();
    if (!resp.ok) {
      // 403 here almost always means the token is missing Workers AI: Read
      // rather than that the model is wrong — say so, because the alternative
      // is someone re-checking the model name for an hour.
      const hint = resp.status === 403 || resp.status === 401
        ? ' (does CLOUDFLARE_AI_TOKEN / CLOUDFLARE_API_TOKEN carry the "Workers AI: Read" permission?)'
        : '';
      throw new Error(`Workers AI ${resp.status}${hint}: ${text.slice(0, 300)}`);
    }

    const body = JSON.parse(text);
    if (body.success === false) {
      throw new Error(`Workers AI error: ${JSON.stringify(body.errors || body).slice(0, 300)}`);
    }
    const result = body.result || {};
    return { response: result.response ?? '' };
  }
}

/** Groq, OpenAI-shaped, normalised back to the binding's `{ response }`. */
export class GroqAI {
  constructor({ apiKey, apiBase = GROQ_API_BASE, fetch: f = globalThis.fetch }) {
    this.apiKey = apiKey;
    this.apiBase = apiBase;
    this.fetch = f;
    this.calls = 0;
  }

  async run(model, input) {
    this.calls++;
    const resp = await this.fetch(`${this.apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: input.messages,
        max_tokens: input.max_tokens,
        temperature: input.temperature,
      }),
    });

    const text = await resp.text();
    if (!resp.ok) throw new Error(`Groq ${resp.status}: ${text.slice(0, 300)}`);
    const body = JSON.parse(text);
    const choice = (body.choices || [])[0];
    return { response: (choice && choice.message && choice.message.content) || '' };
  }
}

/**
 * Build the client the configured provider implies, or `null` when the brief
 * should run facts-only.
 *
 * Returning `null` rather than throwing is deliberate: a missing AI credential
 * must degrade the card to its facts, never fail the ingest that produced them.
 */
export function createAI(source = process.env, { fetch: f = globalThis.fetch } = {}) {
  const provider = (source.ORBIT_AI_PROVIDER || 'workers-ai').toLowerCase();

  if (provider === 'groq') {
    if (!source.GROQ_API_KEY) return null;
    return new GroqAI({
      apiKey: source.GROQ_API_KEY,
      apiBase: source.GROQ_API_BASE || GROQ_API_BASE,
      fetch: f,
    });
  }

  // Prefer a dedicated token so the ingest's D1:Edit token does not have to be
  // widened; fall back to it when only one token is configured.
  const apiToken = source.CLOUDFLARE_AI_TOKEN || source.CLOUDFLARE_API_TOKEN;
  if (!apiToken || !source.CLOUDFLARE_ACCOUNT_ID) return null;
  return new WorkersAI({
    accountId: source.CLOUDFLARE_ACCOUNT_ID,
    apiToken,
    apiBase: source.CLOUDFLARE_API_BASE || CF_API_BASE,
    fetch: f,
  });
}

/** The default model for each provider, when ORBIT_AI_MODEL is unset. */
export const DEFAULT_MODELS = {
  'workers-ai': '@cf/meta/llama-3.1-8b-instruct',
  groq: 'llama-3.3-70b-versatile',
};

/**
 * The object-profiles Tier 3 default (a separate pipeline from the daily brief,
 * so it does not share DEFAULT_MODELS.groq). Groq-hosted, ~20B, chosen for
 * constrained rewriting of verified facts — validated on a sample before it was
 * committed (see the Task 6 commit). Overridable by ORBIT_AI_MODEL.
 */
export const PROFILE_TIER3_MODEL = 'openai/gpt-oss-20b';
