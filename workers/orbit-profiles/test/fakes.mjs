/**
 * Shared fakes for the profile-ingest tests.
 *
 * These record what was executed rather than simulating SQLite. That is a
 * deliberate limit: what is worth asserting here is the SQL and the bindings we
 * generate — column/value alignment, the allowlist check firing before a write,
 * batch shape — and a hand-rolled SQLite would let a wrong assumption pass by
 * being wrong in the same way twice. Semantics that need a real engine belong
 * in `wrangler d1 execute --local`.
 *
 * Modelled on workers/orbit-ingest/test/fakes.mjs. Kept separate rather than
 * imported across worker boundaries so this package stays self-contained.
 */

/**
 * @param {(sql:string, args:any[]) => any} [respond]
 *        return `{results}` / a row object for reads; undefined falls through
 *        to an empty result.
 */
export function fakeDB(respond = () => undefined) {
  const executed = [];   // every statement that reached run/all/first/batch
  const db = {
    executed,
    prepare(sql) {
      const stmt = {
        sql,
        args: [],
        bind(...a) { stmt.args = a; return stmt; },
        async run() { executed.push({ sql, args: stmt.args }); return { meta: { last_row_id: executed.length } }; },
        async all() {
          executed.push({ sql, args: stmt.args });
          const r = respond(sql, stmt.args);
          return r && r.results ? r : { results: r || [] };
        },
        async first() {
          executed.push({ sql, args: stmt.args });
          const r = respond(sql, stmt.args);
          return Array.isArray(r) ? (r[0] ?? null) : (r ?? null);
        },
      };
      return stmt;
    },
    async batch(stmts) {
      for (const s of stmts) executed.push({ sql: s.sql, args: s.args, batched: true });
      return stmts.map(() => ({ meta: {} }));
    },
  };
  return db;
}

export function fakeR2() {
  const puts = new Map();
  return {
    puts,
    async put(key, body, opts) { puts.set(key, { body, opts }); },
    async get(key) {
      const v = puts.get(key);
      return v ? { body: v.body, text: async () => String(v.body) } : null;
    },
    async delete(key) { puts.delete(key); },
    // No pagination: tests here never approach R2's 1000-key page size.
    async list({ prefix = '' } = {}) {
      const objects = [...puts.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((key) => ({ key }));
      return { objects, truncated: false, cursor: undefined };
    },
  };
}

/**
 * The ai-node.mjs client interface: `run(model, input) => {response}`.
 *
 * `respond` may throw — Tier 3 must treat a 429 as backoff-and-continue rather
 * than failure, and the only way to test that is a fake that can fail.
 *
 * @param {(model:string, input:any) => any} [respond] the `response` string, or a
 *        full `{response}` object.
 */
export function fakeAI(respond = () => '') {
  const calls = [];
  return {
    calls,
    async run(model, input) {
      calls.push({ model, input });
      const r = await respond(model, input);
      return r && typeof r === 'object' ? r : { response: r ?? '' };
    },
  };
}

/** Statements whose SQL matches `re`, in execution order. */
export const matching = (db, re) => db.executed.filter((e) => re.test(e.sql));
