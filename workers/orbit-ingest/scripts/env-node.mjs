/**
 * A Workers-shaped `env` for plain Node (plan 33 wave 2b).
 *
 * **Why this exists.** The GP job parses and upserts most of the ~28k catalog in
 * one invocation — roughly 300 ms of CPU against Workers Free's 10 ms ceiling.
 * Streaming fixed the *memory* limit, not the CPU one, and no cadence fixes it
 * either: CPU cost is driven by rows/day, which is fixed, so even 1-hourly (the
 * fastest GP rate Space-Track permits) is still ~55 ms. So the ingest runs from
 * GitHub Actions instead, where there is no CPU ceiling.
 *
 * **This is a shim, not a port.** `src/*` is written against a deliberately
 * narrow slice of the bindings — `prepare().bind().run()/all()/first()`,
 * `batch()`, and R2 `put()/get()/list()` — which is exactly why `test/fakes.mjs`
 * can stand in for them. Reimplementing that slice over the public HTTP APIs leaves
 * every ingest module untouched, so the whole existing suite still covers the
 * code that runs in production.
 *
 *   ORBIT_DB → Cloudflare D1 HTTP API   (POST /d1/database/{uuid}/query)
 *   ORBIT_R2 → R2 S3-compatible API     (SigV4, region "auto")
 *   ORBIT_KV → an in-process Map        (see below)
 *
 * **KV becomes a Map and nothing is lost.** It holds two things: the session
 * cookie, which exists to share one login across invocations — and an Actions
 * run *is* one invocation, so it logs in once either way — and the SATCAT
 * cursor, which already falls back to `SELECT MAX(FILE) FROM satcat` when KV is
 * empty. That fallback was written for a cleared namespace; here it is simply
 * the normal path.
 */

import crypto from 'node:crypto';
import { createAI, DEFAULT_MODELS } from './ai-node.mjs';

/* ── SQL literals ───────────────────────────────────────────────────────────
 *
 * Parameters are inlined as SQL literals rather than sent in the REST API's
 * `params` array, and that is a correctness decision, not a shortcut: the D1
 * REST schema types `params` as an **array of string**. Space-Track already
 * sends every scalar as a JSON string, and `derive.js` coerces them precisely so
 * `WHERE PERIOD BETWEEN 1430 AND 1450` compares numbers instead of text. Handing
 * those numbers back to a string-typed parameter array would undo that coercion
 * at the last hop and re-open the bug — silently, since a string comparison
 * returns wrong rows rather than an error.
 *
 * A numeric literal cannot be misread. `test/env-node.test.mjs` proves it by
 * running the generated SQL through a real SQLite and asserting `typeof()`.
 */
export function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v !== 'string') {
    // Objects would stringify to "[object Object]" and store silently wrong.
    // recordEvents() already JSON.stringifies its detail; anything else here is
    // a caller bug worth failing on.
    throw new TypeError(`sqlLiteral: cannot bind ${typeof v} — stringify it first`);
  }
  return `'${v.replace(/'/g, "''")}'`;
}

/**
 * Substitute `?` placeholders with literals.
 *
 * Quote state is tracked so a `?` inside a string literal is left alone, and an
 * arity mismatch throws rather than producing SQL that happens to parse. Both
 * are cheap here and would be near-invisible in production otherwise.
 */
export function inlineParams(sql, params = []) {
  if (!params.length) {
    if (hasPlaceholder(sql)) throw new Error(`inlineParams: unbound ? in: ${sql.slice(0, 120)}`);
    return sql;
  }
  let out = '';
  let n = 0;
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (inString) {
      out += c;
      if (c === "'") inString = sql[i + 1] === "'" ? (out += sql[++i], true) : false;
      continue;
    }
    if (c === "'") { inString = true; out += c; continue; }
    if (c === '?') {
      if (n >= params.length) throw new Error(`inlineParams: more ? than params in: ${sql.slice(0, 120)}`);
      out += sqlLiteral(params[n++]);
      continue;
    }
    out += c;
  }
  if (n !== params.length) {
    throw new Error(`inlineParams: ${params.length} params for ${n} placeholders in: ${sql.slice(0, 120)}`);
  }
  return out;
}

function hasPlaceholder(sql) {
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (inString) {
      if (c === "'") { if (sql[i + 1] === "'") i++; else inString = false; }
      continue;
    }
    if (c === "'") inString = true;
    else if (c === '?') return true;
  }
  return false;
}

/* ── D1 over the HTTP API ───────────────────────────────────────────────── */

const API_BASE = 'https://api.cloudflare.com/client/v4';

/** Transient failures worth one more try. 400s are our bug and must surface. */
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class D1Http {
  /**
   * @param {object} o
   * @param {string} o.accountId
   * @param {string} o.databaseId
   * @param {string} o.apiToken     needs D1:Edit
   * @param {string} [o.apiBase]
   * @param {Function} [o.fetch]    injectable for tests
   * @param {number} [o.retries]
   * @param {(ms:number)=>Promise<void>} [o.sleep]
   */
  constructor({ accountId, databaseId, apiToken, apiBase = API_BASE, fetch: f = globalThis.fetch,
                retries = 3, sleep = defaultSleep }) {
    if (!accountId || !databaseId || !apiToken) {
      throw new Error('D1Http needs accountId, databaseId and apiToken');
    }
    this.url = `${apiBase}/accounts/${accountId}/d1/database/${databaseId}/query`;
    this.apiToken = apiToken;
    this.fetch = f;
    this.retries = retries;
    this.sleep = sleep;
    this.requests = 0;
  }

  /**
   * One HTTP round trip. `sql` may hold several statements joined by semicolons
   * — the API executes those as a batch and returns one QueryResult each.
   * @returns {Promise<Array<{results?:any[], meta?:object, success?:boolean}>>}
   */
  async exec(sql) {
    let lastErr = null;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt) await this.sleep(250 * 2 ** (attempt - 1));
      this.requests++;
      let resp;
      try {
        resp = await this.fetch(this.url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ sql }),
        });
      } catch (err) {
        lastErr = err;             // DNS/socket — always worth a retry
        continue;
      }

      const text = await resp.text();
      if (!resp.ok) {
        lastErr = new Error(`D1 HTTP ${resp.status}: ${text.slice(0, 400)}`);
        if (RETRY_STATUS.has(resp.status)) continue;
        throw lastErr;
      }

      let body;
      try { body = JSON.parse(text); }
      catch (_) { throw new Error(`D1 returned non-JSON: ${text.slice(0, 300)}`); }

      if (body.success === false) {
        // An API-level error is our SQL, not the network. Never retried: a
        // failing statement retried three times is three chances to half-apply.
        throw new Error(`D1 error: ${JSON.stringify(body.errors || body).slice(0, 400)}`);
      }
      return body.result || [];
    }
    throw lastErr || new Error('D1 request failed');
  }

  prepare(sql) {
    return new D1HttpStatement(this, sql);
  }

  /**
   * `batch()` maps onto the API's multi-statement form, so a 40-row upsert batch
   * is one request rather than 40. That matters: a full GP delta is ~28k rows,
   * which is ~700 round trips batched and ~28,000 unbatched.
   *
   * D1 runs a semicolon-joined batch sequentially in one transaction, matching
   * the binding's documented `batch()` semantics.
   */
  async batch(statements) {
    if (!statements.length) return [];
    const sql = statements.map((s) => terminate(s.toSQL())).join('\n');
    const result = await this.exec(sql);
    return statements.map((_, i) => ({
      success: true,
      meta: (result[i] && result[i].meta) || {},
      results: (result[i] && result[i].results) || [],
    }));
  }
}

const terminate = (s) => (s.trimEnd().endsWith(';') ? s.trimEnd() : `${s.trimEnd()};`);

class D1HttpStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.args = [];
  }

  bind(...args) {
    this.args = args;
    return this;
  }

  /** The fully-inlined statement. Also what `batch()` joins. */
  toSQL() {
    return inlineParams(this.sql, this.args);
  }

  async run() {
    const [first] = await this.db.exec(terminate(this.toSQL()));
    return { success: true, meta: (first && first.meta) || {}, results: (first && first.results) || [] };
  }

  async all() {
    const [first] = await this.db.exec(terminate(this.toSQL()));
    return { success: true, meta: (first && first.meta) || {}, results: (first && first.results) || [] };
  }

  async first() {
    const { results } = await this.all();
    return results.length ? results[0] : null;
  }
}

/* ── R2 over the S3-compatible API ──────────────────────────────────────────
 *
 * The Cloudflare REST API manages *buckets*, not objects, so object writes go
 * through R2's S3 endpoint, which means SigV4. Credentials are an R2 API token's
 * Access Key ID / Secret Access Key — separate from CLOUDFLARE_API_TOKEN, which
 * SigV4 cannot consume directly.
 */

const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** Per RFC 3986 — S3 canonicalisation encodes more than encodeURIComponent. */
function uriEncode(str, encodeSlash = true) {
  let out = '';
  for (const ch of Buffer.from(str, 'utf8')) {
    const c = String.fromCharCode(ch);
    if (/[A-Za-z0-9\-._~]/.test(c)) out += c;
    else if (c === '/') out += encodeSlash ? '%2F' : '/';
    else out += '%' + ch.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

/**
 * SigV4, header-based, single chunk. Pure and exported so the test can pin it to
 * reference signatures generated independently by botocore — a hand-rolled
 * signer that is only ever checked against itself proves nothing.
 *
 * @returns {Record<string,string>} headers to send, including Authorization
 */
export function signV4({ method, url, headers = {}, payload = '', accessKeyId, secretAccessKey,
                         region = 'auto', service = 's3', now = new Date() }) {
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex(payload);

  const all = {
    ...headers,
    host: u.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  const canonical = Object.entries(all)
    .map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const signedHeaders = canonical.map(([k]) => k).join(';');
  const canonicalQuery = [...u.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalRequest = [
    method,
    uriEncode(decodeURIComponent(u.pathname), false),
    canonicalQuery,
    canonical.map(([k, v]) => `${k}:${v}`).join('\n') + '\n',
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest),
  ].join('\n');

  const signingKey = ['aws4_request', service, region, dateStamp].reduceRight(
    (key, part) => hmac(key, part), `AWS4${secretAccessKey}`);
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  return {
    ...all,
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
                   `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export class R2S3 {
  constructor({ accountId, bucket, accessKeyId, secretAccessKey,
                endpoint = null, fetch: f = globalThis.fetch, retries = 3, sleep = defaultSleep }) {
    if (!bucket || !accessKeyId || !secretAccessKey) {
      throw new Error('R2S3 needs bucket, accessKeyId and secretAccessKey');
    }
    this.base = (endpoint || `https://${accountId}.r2.cloudflarestorage.com`).replace(/\/+$/, '');
    this.bucket = bucket;
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.fetch = f;
    this.retries = retries;
    this.sleep = sleep;
    this.puts = 0;
  }

  urlFor(key) {
    return `${this.base}/${this.bucket}/${String(key).split('/').map(encodeURIComponent).join('/')}`;
  }

  /**
   * @param {string} key
   * @param {string|Uint8Array} body
   * @param {{httpMetadata?:{contentType?:string}, customMetadata?:Record<string,string>}} [opts]
   */
  async put(key, body, opts = {}) {
    const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
    const headers = { 'content-length': String(payload.length) };
    const ct = opts.httpMetadata && opts.httpMetadata.contentType;
    if (ct) headers['content-type'] = ct;
    for (const [k, v] of Object.entries(opts.customMetadata || {})) {
      // R2 stores these as S3 user metadata. They must be header-safe: a
      // non-ASCII byte throws inside fetch() rather than being escaped, so it
      // is caught here where the key is still nameable.
      const value = String(v);
      // eslint-disable-next-line no-control-regex
      if (/[^\x20-\x7e]/.test(value)) {
        throw new Error(`R2 metadata "${k}" has non-ASCII characters and cannot be sent as a header`);
      }
      headers[`x-amz-meta-${k.toLowerCase()}`] = value;
    }
    await this.send('PUT', key, headers, payload);
    this.puts++;
    return { key, size: payload.length };
  }

  async get(key) {
    const resp = await this.send('GET', key, {}, '', { allow404: true });
    if (!resp) return null;
    const text = await resp.text();
    return { body: text, text: async () => text, json: async () => JSON.parse(text) };
  }

  /**
   * The Workers R2 binding's `delete(key)`. Added for `r2Writable()`'s
   * preflight probe, which must not leave its key behind in the bucket.
   * `allow404` because S3 DELETE is idempotent — removing a key that is
   * already gone is a success, not an error to surface.
   */
  async delete(key) {
    await this.send('DELETE', key, {}, '', { allow404: true });
  }

  /**
   * The Workers R2 binding's `list({prefix, cursor})` → `{objects, truncated,
   * cursor}` shape, over S3's ListObjectsV2 — `brief.js`'s `rebuildIndex`
   * scans the archive prefix through this same call in both the Pages
   * Function and the Node ingest shim, so the two must agree.
   */
  async list({ prefix = '', cursor } = {}) {
    const query = { 'list-type': '2', 'prefix': prefix };
    if (cursor) query['continuation-token'] = cursor;
    const resp = await this.send('GET', '', {}, '', { query });
    const xml = await resp.text();
    const objects = [...xml.matchAll(/<Contents>[\s\S]*?<Key>([\s\S]*?)<\/Key>[\s\S]*?<\/Contents>/g)]
      .map(([, key]) => ({ key: decodeXml(key) }));
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    const nextToken = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml);
    return { objects, truncated, cursor: truncated && nextToken ? decodeXml(nextToken[1]) : undefined };
  }

  async send(method, key, headers, payload, { allow404 = false, query = null } = {}) {
    let url = this.urlFor(key);
    if (query) {
      url = `${url}?${new URLSearchParams(query).toString()}`;
    }
    let lastErr = null;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt) await this.sleep(250 * 2 ** (attempt - 1));
      // Re-signed each attempt: SigV4 is time-bound, so replaying a stale
      // x-amz-date after a backoff sleep fails as a signature error, which
      // reads like a credential problem rather than a retry problem.
      const signed = signV4({
        method, url, headers, payload,
        accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey,
      });
      let resp;
      try {
        resp = await this.fetch(url, { method, headers: signed, body: method === 'GET' ? undefined : payload });
      } catch (err) {
        lastErr = err;
        continue;
      }
      if (resp.status === 404 && allow404) return null;
      if (resp.ok) return resp;
      const text = await resp.text().catch(() => '');
      lastErr = new Error(`R2 ${method} ${key} → ${resp.status}: ${text.slice(0, 300)}`);
      if (RETRY_STATUS.has(resp.status)) continue;
      throw lastErr;
    }
    throw lastErr || new Error(`R2 ${method} ${key} failed`);
  }
}

function decodeXml(s) {
  return s.replace(/&(lt|gt|amp|quot|apos|#39);/g, (_, e) => (
    { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", '#39': "'" }[e]
  ));
}

/* ── KV as a Map ────────────────────────────────────────────────────────── */

export function memoryKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    // expirationTtl is accepted and ignored: the process is shorter-lived than
    // any TTL we set (the cookie's is 90 minutes).
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, String(value)); },
    async delete(key) { store.delete(key); },
  };
}

/* ── Assembly ───────────────────────────────────────────────────────────── */

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Read a required credential, trimmed.
 *
 * **The trim is load-bearing, not tidiness.** On 2026-08-25 a regenerated
 * `R2_ACCESS_KEY_ID` was stored with a trailing newline from the paste. It
 * lands verbatim inside the SigV4 `Authorization` header, and a newline is
 * illegal in a header value, so undici threw
 * `TypeError: Headers.append: "AWS4-HMAC-SHA256 Credential=…" is an invalid
 * header value` and the request was never sent. That produces **no status
 * code at all**, so it looks nothing like the 401 the same pipeline had been
 * throwing an hour earlier — the two were easy to confuse.
 *
 * Trimming after the emptiness check would also be wrong: `"   "` is truthy,
 * so an untrimmed guard passes and the failure surfaces much later inside
 * signV4 rather than naming the secret that is missing.
 *
 * `.env` parsing already trims (see loadDotEnv in the stats script); this
 * closes the same hole on the repo-secrets path.
 */
function need(source, name) {
  const v = typeof source[name] === 'string' ? source[name].trim() : source[name];
  if (!v) throw new Error(`${name} is not set — add it to the workflow's repo secrets.`);
  return v;
}

/**
 * Build the `env` object `src/index.js` expects, from process.env.
 *
 * Required: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, ORBIT_D1_DATABASE_ID,
 * R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, SPACETRACK_IDENTITY,
 * SPACETRACK_PASSWORD.
 *
 * Optional (wave 6, the daily brief): ORBIT_AI_CARDS to turn narrative
 * generation on at all, then ORBIT_AI_PROVIDER / ORBIT_AI_MODEL and whichever
 * credential that provider needs. All absent is a supported state — the brief
 * is written from its SQL facts and simply carries no narrative.
 *
 * @param {object} [source] defaults to process.env
 * @param {object} [overrides] injected pieces, for tests
 */
export function createEnv(source = process.env, overrides = {}) {
  const accountId = need(source, 'CLOUDFLARE_ACCOUNT_ID');
  const aiProvider = (source.ORBIT_AI_PROVIDER || 'workers-ai').toLowerCase();
  return {
    ORBIT_DB: overrides.ORBIT_DB || new D1Http({
      accountId,
      databaseId: need(source, 'ORBIT_D1_DATABASE_ID'),
      apiToken: need(source, 'CLOUDFLARE_API_TOKEN'),
      apiBase: source.CLOUDFLARE_API_BASE || API_BASE,
    }),
    ORBIT_R2: overrides.ORBIT_R2 || new R2S3({
      accountId,
      bucket: source.ORBIT_R2_BUCKET || 'orbit-data',
      accessKeyId: need(source, 'R2_ACCESS_KEY_ID'),
      secretAccessKey: need(source, 'R2_SECRET_ACCESS_KEY'),
      endpoint: source.R2_ENDPOINT || null,
    }),
    ORBIT_KV: overrides.ORBIT_KV || memoryKV(),
    // `in` rather than `||`: a test injecting `null` is asserting the
    // no-model path, which is a different case from "not overridden".
    ORBIT_AI: 'ORBIT_AI' in overrides ? overrides.ORBIT_AI : createAI(source),
    ORBIT_AI_CARDS: source.ORBIT_AI_CARDS,
    ORBIT_AI_MODEL: source.ORBIT_AI_MODEL || DEFAULT_MODELS[aiProvider] || undefined,
    SPACETRACK_IDENTITY: source.SPACETRACK_IDENTITY,
    SPACETRACK_PASSWORD: source.SPACETRACK_PASSWORD,
    SPACETRACK_BASE: source.SPACETRACK_BASE || 'https://www.space-track.org',
  };
}
