---
paths:
  - "workers/orbit-ingest/**"
  - "functions/api/**"
  - "d1/**"
---

# Ingest, D1 read-cost, and the Space-Track budget

## Reading the D1 dashboard (learned 2026-08-25)

**D1 bills rows the engine *visits*, not rows returned.** A `LIMIT` bounds output, never
the scan behind it.

- **The `Rows read / rows returned` ratio is the signal**, not `Count` or `Rows read`
  alone. ≈1 is an index seek; thousands is a scan wearing a `LIMIT`. Sort by it first.
  **Never sort by `Count`** — that is how the 2026-08-25 session spent itself on the group
  bundles (~10% of reads, high count because paged) while missing `buildAnalytics()` (~84%,
  low count, ratio 16,195). Export with
  `node workers/orbit-ingest/scripts/d1-query-stats.mjs --hours 1` and read
  `docs/d1-read-model.md` before optimising anything.
- Use a window **shorter than the time since your deploy** — a 24h window still contains
  pre-fix runs and makes a landed fix look dead.
- **Never extrapolate an hour containing a cron run into a daily rate** — the 17:xx hour
  holds the whole daily job. Query counts are bucketed by hour, so one daily run can look
  like "10 executions".
- **High `Count` on `TLE_LINE1` queries is the ingest, not user traffic.**
  `buildGroupArtifacts()` runs 21 bundles × 4 GP runs/day. Check `ingest_runs` timings first.
- **`ingest_runs.d1_requests` counts HTTP round trips**, not rows or statements. A fix that
  trades round trips for rows makes that column go *up* while cost goes down. Judge
  rows-read work only in the Cloudflare D1 dashboard.

## Verifying an ingest change the same session

**Ingest changes are not live on push.** `functions/api/` deploys via Pages immediately;
`workers/orbit-ingest/` only runs on its Actions schedule. To trigger:

```bash
gh workflow run orbit-ingest -f job=gp        # one upstream call, guarded 25/hr
gh workflow run orbit-ingest -f job=gp -f use_test_server=true   # zero budget
```

- `gp` = group bundles only, one Space-Track call. For a pure-perf change the resulting
  per-group counts must be **identical** to the previous run's.
- `daily` runs three upstream ingests (SATCAT/DECAY/BOXSCORE, once-per-day after 1700 UTC)
  but exercises every artifact builder — use it to verify an artifact or read-cost change.
- The artifact steps (`artifacts`, `full-catalog`, `summary`, `feed`, `analytics`,
  `brief`) make **zero** upstream calls.
- The TEST server is `https://for-testing-only.space-track.org` — same API/credentials,
  none of the production rate budget, but its catalog is a **separate deployment** so
  never read a prod-vs-test bundle-count diff as a regression.

## D1 query invariants (do not "optimise" again)

- **Catalog-wide reads page by KEYSET (`NORAD_CAT_ID > last`), never `OFFSET`.** SQLite
  can't seek an offset — `LIMIT n OFFSET k` is quadratic. Measured: OFFSET visits 405k
  rows to return 27k; keyset visits 27k. `pagedRows()` takes `{select, from, where}` not a
  finished SQL string — the cursor ANDs *into* the `WHERE`. Every caller selects/orders by
  `NORAD_CAT_ID`.
- **The group-bundle queries are at their floor** — all 21 measured 2026-08-25, not
  modelled. Every candidate fix was tried and is worse (`NORAD_CAT_ID` is the rowid, so
  `idx_objects_type` already resolves as `(OBJECT_TYPE=? AND rowid>?)`). A forced
  `INDEXED BY` is fragile — any non-name predicate (the keyset cursor included) demotes it
  SEARCH→SCAN, which is why `sqlite.test.mjs`'s EXPLAIN test runs *with* the cursor clause.
- **`buildAnalytics()` was the real cost, fixed 2026-08-26:** 16 unindexed `GROUP BY`
  tallies + a `SELECT *` became one column-scoped SELECT folded in memory
  (`foldAnalytics()`) — 17 scans over `objects` → 3, output byte-identical, guarded by
  three tests in `pages-api.test.mjs`. Preserve the historical vs on-orbit-now
  (`DECAY_DATE IS NULL`) split.
- **`decay` holds messages back to Sputnik 1.** "Latest per object" must be a correlated
  `NOT EXISTS` against the `(NORAD_CAT_ID, MSG_EPOCH)` PK, never `GROUP BY … MAX()` — the
  planner full-scans the latter (cost 53.67M rows read once).
- **`parseEpochUTC` and `CITATION` are duplicated across bundles on purpose**, asserted
  byte-identical by `derive.test.mjs`. Do not de-dupe.

## Deploy confirmation

`wrangler.toml`'s `name` is inert for Pages (the dashboard git integration owns deploys)
but it IS parsed and validated — a Workers-only key fails the build while `ci` stays green
(`ci.yml` only runs `npm test`). After a push, confirm the deploy shipped:

```bash
gh api repos/<owner>/<repo>/commits/<sha>/check-runs \
  --jq '.check_runs[] | "\(.name): \(.conclusion)"'    # want "Cloudflare Pages: success"
```

Live project is **`orbit-relay-web`** (verified `wrangler pages project list`).
`signal-playground` is a separate stale project — deploying there ships to the wrong site.
Runtime bindings for Functions go in the Pages dashboard, never `wrangler.toml`.
