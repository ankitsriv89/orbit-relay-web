/**
 * Shared fakes for the ingest tests.
 *
 * These record what was executed rather than simulating SQLite. That is a
 * deliberate limit: the assertions worth making here are about the SQL and the
 * bindings we generate — column/value alignment, numeric coercion, batch
 * shape — and a hand-rolled SQLite would let a wrong assumption pass by being
 * wrong in the same way twice. Semantics that need a real engine belong in the
 * `wrangler d1 execute --local` check the plan calls for.
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

export function fakeKV(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    store: m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, v); },
  };
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
  };
}

/** Statements whose SQL matches `re`, in execution order. */
export const matching = (db, re) => db.executed.filter((e) => re.test(e.sql));

/** A Response whose body streams `text` in `size`-byte pieces. */
export function chunkedResponse(text, size = 64 * 1024) {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (i >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(i, i + size));
      i += size;
    },
  }));
}
