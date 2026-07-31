# Plan 33 — Space-Track ingest & deep orbit catalog

Status: **ALL SIX WAVES BUILT — LIVE 2026-07-28.** Schema applied to remote D1, all 7 GitHub repo
secrets set, the catalog seeded (**31,629 objects**), Pages redeployed — `/api/search`,
`/api/summary`, `/api/object/:norad` and `source=spacetrack` TLE bundles are all live in
production. The first seed caught a real bug (GP `predicates/` projection silently drops
`TLE_LINE0/1/2`, fixed in `3b6c14b`) that every unit suite had missed — see the *Wave 2b/3
discoveries* note below and `docs/issues-and-resolutions.md`. The next real GP ingest (the
6-hourly cron) backfills the TLE lines via the normal idempotent upsert.

Waves 0-5 and the mobile-audit closeout are pushed; **wave 6 (the daily brief) is this session's
work.** This repo has **no CI**, so a push is not a deploy — going live is
`wrangler pages deploy public --project-name signal-playground`.

**Wave 6's narrative is gated OFF by default and needs one user-side step to switch on** (a
Cloudflare token with *Workers AI: Read*, then the repo variable `ORBIT_AI_CARDS=1`). Nothing
breaks while it is off: the brief is still built and still shown, as a digest of SQL-computed
figures with no sentence over it. See the wave 6 section and the README's *Turning the daily
brief's narrative on*.

**Two decisions taken 2026-07-27 (Ankit) — do not re-litigate:**

1. **Ingest moves to GitHub Actions**, not Workers Paid. The `scheduled()` handler and the
   three crons stay in the repo but are not the deployment path. See *Wave 2b*.
2. **Space-Track gets its own page at `/spacetrack/`.** `/orbit/` stays the cinematic
   Celestrak view; the SPACE-TRACK button becomes a **link to the new page** rather than an
   in-place source switch. See *Wave 3*.

## Context

`/orbit/` ships with a **SPACE-TRACK** source button that is `disabled title="Phase 2"`, and both
backends (`functions/api/tle.js:56`, and the AWS twin `lambda/handlers/relay.py:104`) return
`501 Space-Track source not yet available.` The seam was cut in June 2026 and never filled. The
reference PDFs were downloaded at the same time and live alongside this file
(`Space-Track.org*.pdf`).

Today the globe shows Celestrak group files — a curated few thousand objects across 16 groups.
The goal is to track **the whole on-orbit catalog (~28,000 objects)**, give each object a real
dossier, and add a live feed of what changed. Space-Track is the authoritative source for all
three, and the account (`anksr2gcp@gmail.com`) already exists.

Target is the **standalone Cloudflare playground only**. The AWS/marsapiens copy stays on
Celestrak; its 501 stub is left untouched.

---

## Legal basis (settled — and it constrains the build)

From `Space-Track.org-sps.pdf` p.2 — *Redistribution of Basic SSA Information*:

> USSPACECOM has provided **express blanket approval for transfer/redistribution of basic SSA
> data and services** accessed via www.Space-Track.org **conditioned on appropriate citation.**
> Basic SSA data are Two-Line Elements (TLEs) and Orbital Mean-element Messages (OMMs); SATCAT;
> and Satellite Decay and Reentry Data.

This satisfies the User Agreement's "no transfer without prior express approval" clause
(10 USC 2274(c)(2)) for everything we ship. **No ODR is required.**

Three binding requirements, each a real work item:

1. **Citation is a condition of the approval.** A visible attribution must appear on `/orbit/`
   and in every API response carrying Space-Track-derived data. No citation, no approval.
2. **Credentials are never shared or exposed** (10 USC 2274(c)(3) — "each individual user or
   entity is required to obtain a separate account"). All fetching is server-side; secrets in
   Wrangler secrets; no Space-Track call ever originates from a browser.
3. **`cdm_public` is readable but NOT in the blanket-approved list.** The class exists under
   `basicspacedata` and we *can* query it — but CDM is absent from the enumerated basic-SSA set,
   so we do not redistribute it. We derive our own close-approach screening instead, badged
   `UNOFFICIAL — NOT FOR COLLISION AVOIDANCE`, matching Space-Track's own warning that *"a TLE
   available to the public should not be used for conjunction assessment prediction."*

---

## API budget — designed for minimum calls

Ceiling is **<30 requests/minute and <300 requests/hour**, with per-class retrieval rates whose
breach is grounds for **account suspension** (`Space-Track.org.pdf` p.2).

| Class | Allowed | Our usage | Query |
|---|---|---|---|
| GP (TLEs) | 1 / hour | **1 / 6 h**, delta only | `class/gp/decay_date/null-val/CREATION_DATE/%3Enow-0.28/format/json` |
| SATCAT | 1 / day after 1700 UTC | 1 / day, **delta only** | `class/satcat/file/%3E{lastFile}` |
| DECAY | 1 / day | 1 / day | `class/decay/MSG_EPOCH/%3Enow-1/` |
| 60-day decay | 1 / week, Wed after 1700 UTC | 1 / week | `class/decay/MSG_EPOCH/%3Enow-8/source/60day_msg/` |
| BOXSCORE | 1 / day after 1700 UTC | 1 / day | `class/boxscore/` |
| TIP | 1 / hour | **conditional** — only when reentry predicted <7 days | `class/tip/INSERT_EPOCH/%3Enow-0.042/` |
| GP_HISTORY | 1 / lifetime | **never queried** | — |

**Steady state ≈ 8 calls/day** (4 GP + 3 daily + occasional TIP) against a 7,200/day ceiling —
about 0.1% of the permitted rate. Five call-reduction measures:

- **6-hourly GP, not hourly.** The 1/hour cap is a ceiling, not a target. **The delta window must
  match the cadence or elsets are silently missed** — `now-0.042` is a 1-hour window, so a 6-hour
  cron needs `now-0.25`. We use **`now-0.28`** for overlap margin; upserts are idempotent, so
  re-fetching a few is free and missing any is not. Accuracy cost is negligible: SGP4 drift is
  ~1–3 km/day in LEO, so a 6-hour-older elset is sub-kilometre — invisible on a globe.
- **Bootstrap once, then deltas forever.** One full-catalog pull
  (`class/gp/decay_date/null-val/epoch/%3Enow-10/format/json`, ~28k objects) seeds D1; every
  later run merges only elsets created since. This is the "store it on your own servers; do not
  download it again" pattern the docs mandate.
- **Session cookie cached in KV.** Cookies last 2 h. At 6-hourly cadence each GP run re-auths
  anyway, but the daily jobs firing at 17:20/17:25 UTC share one session.
- **Off-peak minute.** Docs require avoiding the top and bottom of the hour — cron fires at
  **:17** (`17 */6 * * *`), inside the recommended 10–20-minute offset window.
- **`predicates/` projection** — request only the columns we store.

**Safety rail:** the ingest Worker logs every outbound call to a D1 `api_calls` table and
**hard-aborts** if it would exceed 25 calls in any rolling hour. A runaway loop must not be able
to get the account suspended.

---

## Architecture

Cloudflare **Pages Functions cannot run cron triggers** — scheduled handlers are Workers-only
(free plan allows 5 cron triggers per account; we use 3). Ingest therefore lives in a separate
Worker sharing storage bindings with the Pages project.

```
  orbit-ingest Worker              signal-playground (Pages)
   scheduled() × 3 crons             functions/api/*.js
        │                                   │
        ├── KV  ORBIT_KV   (session cookie, last SATCAT file no.)
        ├── D1  orbit-catalog  ◄────────────┤  dossier · search · stats
        └── R2  orbit-data     ◄────────────┘  TLE bundles · feed · watchlist
```

**Why both D1 and R2.** D1 is the queryable source of truth — deltas are cheap upserts, and it
answers "search by name", "group by country", "dossier for NORAD 25544" natively. R2 holds
*derived, pre-rendered* artifacts regenerated after each ingest, so the hot path the globe hits
is a flat object read, never a database query.

**Format: `format/json`, not `format/tle`.** TLE format only covers catalog numbers below
100,000; above that Space-Track emits Alpha-5, which silently corrupts `satnum` in
`satellite.js`. JSON carries `NORAD_CAT_ID` as a true integer *and* `TLE_LINE1`/`TLE_LINE2` as
fields — satellite.js compatibility with a reliable join key. JSON also carries `OBJECT_TYPE`,
`RCS_SIZE`, `COUNTRY_CODE`, `LAUNCH_DATE`, `SITE`, enough to power the dossier without a SATCAT
join for most objects.

**Bootstrap runs locally, not in the Worker.** Parsing 28k objects and upserting them in one
invocation would likely exceed the free-tier Workers CPU limit. The one-time seed runs as a Node
script (`workers/orbit-ingest/scripts/bootstrap.mjs`) writing to remote D1 via
`wrangler d1 execute --remote`. Recurring deltas are a few hundred to ~2k objects and sit
comfortably inside the limit. Better design regardless of host — the seed is a migration, not a
scheduled job.

### Hosting: staying on Cloudflare (Vercel considered, rejected)

The bottleneck is client-side SGP4, not the server — Wave 1 is the performance fix and no host
affects it. Server-side load is ~8 upstream calls/day plus flat blob reads.

- **R2 egress is free.** Serving a ~6 MB catalog plus per-group bundles to every visitor is
  exactly the workload that accrues egress charges on Vercel Blob or S3.
- **Vercel Cron on Hobby is once/day**, forcing the Pro tier; Cloudflare gives 5 crons free.
- Repo is already Cloudflare-native (`wrangler.toml`, `signal-playground`, `scripts/upload_r2.sh`,
  the plan-24 D1 binding). Migrating would mean redoing mars-colony and music deployment too.

If server-side conjunction screening over the full catalog is ever wanted (we do it client-side
instead), Workers CPU limits become binding and this decision is worth revisiting.

---

## Partitioning: what we can slice the catalog by

**Partitioning costs zero extra API calls.** We mirror the whole catalog and slice it in D1, so
every scheme below is a SQL query over data we already hold — not a query per group. This is why
the budget stays at ~8 calls/day no matter how many views we add.

**Tier A — native Space-Track fields** (exact, authoritative, on the GP record):

| Field | Values | Powers |
|---|---|---|
| `OBJECT_TYPE` | Payload, Rocket Body, Debris, Unknown | "satellites only" vs "junk" — the headline filter |
| `COUNTRY_CODE` | US, PRC, CIS, JPN, IND, ESA… | Country view; matches the boxscore CSV already in this folder |
| `RCS_SIZE` | Small, Medium, Large | Radar cross-section; drives point sizing |
| `SITE` | Launch site code | Join `launch_site` class for human names |
| `LAUNCH_DATE` / `DECAY_DATE` | dates | Launch-era views, decay tracking |
| `INCLINATION`, `PERIOD`, `APOGEE`, `PERIGEE`, `ECCENTRICITY`, `MEAN_MOTION` | numeric | Orbit-shape filters |

**Tier B — derived in SQL** (free, computed at ingest):

- **Orbit regime** — the most useful visual partition. Thresholds come from Space-Track's own
  sample queries: LEO = `PERIOD < 128` min, GEO = `PERIOD 1430–1450` min; MEO and HEO fall out of
  the remainder plus eccentricity.
- **Launch year / decade** from `LAUNCH_DATE`.
- **Debris family** by `INTLDES` prefix — every fragment of a breakup shares its parent's
  international designator, so `1999-025*` isolates all Fengyun-1C debris. More robust than
  Celestrak's hand-maintained debris group files.

**Tier C — operator / company: no such field exists.** `COUNTRY_CODE` is the *registering state*,
not the operator, so Starlink is just "US" alongside every NOAA and NRO object. Operator grouping
comes from an `OBJECT_NAME` pattern table we maintain (`STARLINK%`, `ONEWEB%`, `IRIDIUM%`,
`GLOBALSTAR%`, `FLOCK%`/`SKYSAT%` for Planet, `LEMUR%` for Spire, `QIANFAN%`, `GUOWANG%`). Cheap
to build, but **it is our inference, not authoritative data** — it drifts as new constellations
launch and needs periodic review. Label it as such in the UI.

**Bonus — Space-Track's own curated lists.** The `favorites/` predicate exposes administrator-
curated groups usable by any account: **Navigation, Special_Interest, Visible, Weather** (e.g.
`class/gp/favorites/Navigation/EPOCH/%3Enow-30/format/3le`). These replace several hand-maintained
NORAD-ID lists with ones 18 SDS keeps current. Prefer them wherever they fit.

**Back-compat.** Ingest still writes `tle/spacetrack/<group>.txt` to R2 for the existing 16 group
checkboxes, so the current UI works unchanged against `source=spacetrack`. New partitions are
additive — a second filter dimension in the HUD.

---

## Files

**New — ingest Worker** (`workers/orbit-ingest/`)
- `src/index.js` — `scheduled()` dispatching on cron expression
- `src/spacetrack.js` — auth (`POST /ajaxauth/login`, cookie→KV), budget guard, query helpers
- `src/ingest-gp.js`, `src/ingest-satcat.js`, `src/ingest-decay.js`, `src/ingest-boxscore.js`
- `src/derive.js` — group partitioning, event diffing, R2 artifact regeneration
- `src/operators.js` — `OBJECT_NAME` → operator lookup table (Tier C)
- `src/jsonstream.js` — incremental array scanner (the 10-20 MB GP delta)
- `scripts/bootstrap.mjs` — one-time full-catalog seed (`--http` applies it over the D1 API)
- `scripts/env-node.mjs` — the Workers-shaped `env` for Node (wave 2b)
- `scripts/run-ingest.mjs` — the GitHub Actions entry point (wave 2b)
- `wrangler.toml` — 3 crons + R2/D1/KV bindings, kept as the unused fallback

**New — CI**
- `.github/workflows/orbit-ingest.yml` — 3 crons (`17 */6 * * *`, `35 17 * * *`, `40 17 * * 3`)
  + a manual `seed` job, serialised by `concurrency: orbit-ingest`

**New — schema**
- `d1/orbit.sql` — `objects`, `satcat`, `decay`, `events`, `boxscore`, `api_calls`

**New — Pages Functions** (`functions/api/`)
- `_orbit.js` (citation), `_catalog.js` (JSON/CORS/guards), `object/[norad].js`
  (`/api/object/:norad`), `search.js` (+ `facets=1`), `summary.js`. `feed.js` and
  `decay-watch.js` land in wave 4.

**New — shared globe engine** (`public/orbit-engine/`, wave 3)
- `astro.js`, `tle.js`, `sat-engine.js`, `propagate.worker.js`, `vendor/satellite.min.js`,
  `cesium-base.js`

**New — the catalog page** (`public/spacetrack/`, wave 3)
- `index.html`, `spacetrack.js`, `spacetrack.css`

**Modified**
- `functions/api/tle.js` — the 501 became an R2 read of `tle/spacetrack/<group>.txt`
- `wrangler.toml` — R2 + D1 bindings on the Pages project (read side)
- `public/orbit/index.html` — SPACE-TRACK became an `<a>`; the module + engine paths
- `public/orbit/orbital-relay.js` — now the Celestrak *app* on top of the shared engine
- `public/orbit/orbit.css` — `.source-btn--link`
- `public/_headers` — cache rules for `/orbit-engine/` and `/spacetrack/`

---

## Waves

**Wave 0 — port the memory fix first. ✅ SHIPPED `92aadec`.** The standalone `orbital-relay.js`
(807 lines) was *behind* the marsapiens copy (914 lines) and still used per-Entity
`CallbackProperty` — the exact 1.2 GB blowup fixed in the parent as issue **#71**. Ported the
`PointPrimitiveCollection` rewrite before adding object volume, or the Worker would just feed a
leak faster. Also fixed the `iridium-NEXT` baseline-path case bug (`fetchTLE` lowercases the slug,
the file on disk was mixed-case, so Iridium silently always took the slow API path) — and, in
wave 1, its actual source: `scripts/snapshot_tle.sh` wrote the mixed-case name and would have
reintroduced it on the next refresh.

**Wave 1 — Web Worker propagation. ✅ SHIPPED `9d84e8a`.** SGP4 is off the main thread. The worker
builds satrecs once from TLE lines, then per tick returns a transferable `Float32Array` that
`PointPrimitiveCollection` consumes directly; the main thread posts both buffers back for reuse,
so a steady tick allocates nothing on either side. Orbit rings and ground tracks became worker
jobs too, clearing audit finding **M-18**. Measured at 625 visible sats: **53.7 ms** of
main-thread SGP4 per tick → below `performance.now()` resolution. Worker-vs-sync agreement is
**0.10–0.20 m** (Float32 quantisation of ECEF metres). The worker is an optimisation, never a
dependency — it is dropped on error and everything falls back to the synchronous path, which the
E2E suite exercises by killing it deliberately.

**Wave 2 — Space-Track source live. ✅ BUILT (not deployed).** Ingest Worker
(`src/index.js` + four ingest modules + `derive.js` + `operators.js`), D1 schema, R2
artifacts, and the `tle.js` read-through. The source button is enabled and the citation is
in the DOM. 108 unit checks + 7 new E2E checks, none of which touch the network.

Three things came out differently from the plan above, each for a reason worth keeping:

- **The GP delta is not small, so the ingest streams.** A 6.7-hour `CREATION_DATE` window
  returns *most of the ~28k active catalog*, not a handful of rows — 18 SPCS regenerates
  elsets continuously, so nearly everything has a fresh elset in any 6-hour window. That is
  10-20 MB of JSON, and `await resp.json()` would hold the text *and* ~28k parsed objects
  at once, past a Worker's 128 MB limit. `src/jsonstream.js` scans the array incrementally
  and hands each element to the real `JSON.parse`, so resident memory is one row plus the
  current 40-row upsert batch regardless of catalog size.
- **Space-Track sends every scalar as a JSON string** (`"PERIOD": "132.594"`). Stored
  uncoerced, `WHERE PERIOD BETWEEN 1430 AND 1450` becomes a *string* comparison and the GEO
  group silently returns nothing. `derive.js` coerces at ingest; `test/sqlite.test.mjs`
  asserts `typeof(PERIOD)` is `real` in a real SQLite.
- **Group membership is SQL, not a curated list.** All 20 legacy group slugs are predicates
  over our own mirror, so switching source changes nothing else in the UI. Two are *better*
  than the Celestrak equivalents — the four debris groups are `OBJECT_ID` prefix matches, so
  a fragment catalogued next year joins its family automatically, and `last-30-days` is a
  live date predicate. Two are **worse and are flagged `approximate: true`** so the HUD can
  label them: `glo-ops` (GLONASS payloads are catalogued as `COSMOS nnnn`, indistinguishable
  by name, so they are identified by orbit signature — 675.7 min at 64.8°) and `sbas`
  (a hand-listed set of augmentation payloads).

Also fixed while enabling the button: selecting a source called `reloadAllLayers()`, which
only re-fetches the *optional* layer checkboxes. The ISS, the other stations and the
Starlink batch are built once by `loadSatellites()` and live outside `layerState`, so an
in-place switch would have left most of the globe showing Celestrak points under a
"Live data: Space-Track" label. The switch now re-boots the page; the choice is read back
from `localStorage`.

### Plan limits — why the ingest leaves Workers (settled)

The GP job parses and upserts most of the catalog in one invocation. **Workers Free allows
10 ms CPU per invocation** and this needs ~300 ms. Streaming solved the *memory* ceiling, not
the CPU one — no amount of cleverness makes an O(20 MB) parse fit in 10 ms.

**Reducing the cadence does not fix it and was considered.** CPU cost is driven by *rows
processed per day*, which is fixed; cadence only slices it thinner. Estimated per-invocation
parse cost: 6-hourly ~300 ms, 3-hourly ~160 ms, 2-hourly ~110 ms, and **1-hourly — the
maximum rate Space-Track permits for GP — still ~55 ms**, over 5× the limit. Cadence is
therefore a freshness decision, not a workaround, and freshness barely matters: SGP4 drift is
~1–3 km/day in LEO, so a 6-hour-older elset is sub-kilometre and invisible on a globe.

**Decision: GitHub Actions.** Free, no CPU ceiling, and the ingest modules already run under
Node — `scripts/bootstrap.mjs` imports `derive.js` and `jsonstream.js` unchanged.

**Wave 2b — move the ingest runner to GitHub Actions. ✅ BUILT (not deployed).** Not a
rewrite: the ingest modules are written against a deliberately narrow interface
(`prepare().bind().run()/all()/first()`, `batch()`, and R2 `put()/get()`), which is exactly
why `test/fakes.mjs` can stand in for both. It came out as the planned **shim, runner and
workflow**, with one decision that was not in the plan:

- `scripts/env-node.mjs` — an `env` whose `ORBIT_DB` speaks the Cloudflare **D1 HTTP API**
  (`POST /accounts/{id}/d1/database/{uuid}/query`) and whose `ORBIT_R2` speaks the R2
  S3-compatible API. `src/*` is untouched, so every existing test still covers the code that
  runs in production.
- **Parameters are inlined as SQL literals, not sent in the REST API's `params` array** — and
  that is a correctness decision, not a shortcut. The D1 REST schema types `params` as an
  *array of string*. Space-Track already sends every scalar as a JSON string and `derive.js`
  coerces them precisely so `WHERE PERIOD BETWEEN 1430 AND 1450` compares numbers; handing
  those numbers back to a string-typed parameter array would undo that coercion at the last
  hop, silently, because the result is wrong rows rather than an error. `batch()` maps onto
  the API's multi-statement form, so a 40-row upsert batch is one request — ~700 round trips
  for a full delta rather than ~28,000.
- **R2 needs its own credentials.** SigV4 cannot consume a Cloudflare API token, so
  `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` (from an R2 API token) are separate secrets
  rather than a duplicate of `CLOUDFLARE_API_TOKEN`. The signer is pinned to reference
  signatures **generated by botocore** — a hand-rolled signer checked only against itself
  proves nothing.
- `ORBIT_KV` becomes an **in-process Map**. Nothing is lost: the cookie cache exists to share
  a session across invocations, and an Actions run is one process that logs in once. The
  SATCAT cursor already falls back to `SELECT MAX(FILE) FROM satcat` when KV is empty — that
  fallback was written for a cleared KV and is now the normal path.
- `.github/workflows/orbit-ingest.yml` — the three crons, each dispatching to `runGP` /
  `runDaily` / `runWeekly` via `scripts/run-ingest.mjs`, plus a manual `seed` job.
  GitHub cron is **UTC and best-effort late**, so the "after 1700 UTC" jobs sit at 17:35/17:40
  rather than the Worker's 17:20/17:25. `concurrency: orbit-ingest` with
  `cancel-in-progress: false` — two concurrent runs would race each other's upserts *and*
  both spend against a budget whose ceiling is an account suspension.
- `bootstrap.mjs --http` applies the seed over the same transport, so the one-time seed can
  run from Actions against the secrets already stored there instead of needing wrangler.
- Secrets are **repo secrets**: `SPACETRACK_IDENTITY`, `SPACETRACK_PASSWORD`,
  `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` (D1:Edit), `ORBIT_D1_DATABASE_ID`,
  `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`. No Wrangler secrets and no `wrangler deploy` for
  the ingest Worker at all.
- `src/index.js`'s `scheduled()` and the `wrangler.toml` crons stay in the repo, deployable
  and unused — the fallback if the Actions route ever becomes annoying, and they cost nothing.

**Wave 3 — the `/spacetrack/` page. ✅ BUILT and LIVE.** Space-Track's data is broader
and differently shaped than Celestrak's, and the `/orbit/` HUD is furniture built around 16
group checkboxes. It got its own page instead of bending the old one; this is where dashboards
and analysis land as the ideas arrive.

**Going live (2026-07-28) surfaced a real bug the unit suites had missed.** The first seed —
31,629 objects — landed with `TLE_LINE1`/`TLE_LINE2` NULL on every row, silently breaking all
20 group bundles and the entire `source=spacetrack` `/api/tle` path. A `predicates/`
projection on `class/gp` with `format/json`, even one explicitly listing
`TLE_LINE0,TLE_LINE1,TLE_LINE2`, comes back with those three fields simply absent — they are
synthesized by Space-Track from the numeric elements, not stored columns, and being listed in
`modeldef/class/gp` never guaranteed they survive a narrowed projection. Every unit suite
passed throughout because `fixtures/sample_gp.json` was captured as a *full, unfiltered*
response and nothing exercised the narrowed shape actually sent in production — a fixture
being real data is not the same as a fixture matching the query that's actually run. Fixed in
`3b6c14b`: `Q.gpDelta`/`Q.gpFull` no longer build a `predicates/` segment; GP always requests
the full record. See `docs/issues-and-resolutions.md` 2026-07-27/28 for the full incident,
including a second finding — a duplicate `workflow_dispatch` (likely triggered from both the
CLI and the Actions UI within the same couple of minutes) put two real GP calls on the account
26 minutes apart before being caught via `gh run list` and cancelled.

- **The engine was extracted, not forked.** `/orbit-engine/` now holds `astro.js` (orbital
  arithmetic, no Cesium and no DOM), `tle.js` (`parseTLE`/`fetchTLE`), `sat-engine.js`
  (`SatPoint` + `SatEngine`: the collection, the worker bridge, the tick, the shared visuals)
  and `propagate.worker.js` with the vendored `satellite.min.js`. Both pages are ES modules on
  top of it. That engine had already been fixed **twice in two copies** — the
  marsapiens/standalone divergence that opened this plan, about to happen inside one repo.
- **The worker URL is absolute** (`/orbit-engine/propagate.worker.js`). A relative one resolves
  against the *page*, so `/spacetrack/` would have looked for
  `/spacetrack/propagate.worker.js`, failed, and silently fallen back to synchronous SGP4 —
  a performance cliff with no error anywhere. The E2E asserts the worker is live *on the new
  page* for exactly this reason.
- `public/spacetrack/` — its own Pages directory, so `/spacetrack/` routes with no config
  change. It loads `/orbit/orbit.css` for the shared HUD design system and adds only
  `spacetrack.css`, so the two pages read as one instrument rather than two products.
  `/orbit/` keeps the Celestrak cinematic view, unchanged.
- **The SPACE-TRACK button is now an `<a>` to `/spacetrack/`**, replacing the in-place source
  switch built in wave 2. That retires the `location.reload()` workaround and the E2E dance
  around a destroyed execution context. `derive.test.mjs` now asserts a
  `<button class="source-btn">` has *not* come back, which is what a regression would look like.
- Filters → `/api/search?...&tle=1` → points on the globe, coloured by object type; click →
  `/api/object/:norad` → a dossier joining GP, SATCAT and the decay predictions. Tier A/B/C
  filters are object type · country · orbit regime · launch era · operator, with `operator`
  labelled **derived** everywhere it appears — it is our inference from the name, and a filter
  that looks authoritative and is not is worse than one that is absent.
- The dossier resolves GP's `APOAPSIS`/`PERIAPSIS` and SATCAT's `APOGEE`/`PERIGEE` into one
  `apogee_km`/`perigee_km` pair, **both altitudes**, so the frontend cannot get it wrong. The
  ISS is identified by NORAD **25544**, never by a string match on "ISS"/"ZARYA" — audit
  finding **M-19**, and "ISS (NAUKA)" and "ISS DEB" would both match a substring test.
- `/api/search` sort keys are **whitelisted**: the sort column is the one place in the
  statement where a bound parameter cannot be used.

**Wave 4 — signal feed. ✅ BUILT.** The write side (event recording, `feed/latest.json`) shipped
back in wave 2; wave 4 is the read side and the UI.

- `functions/api/feed.js` — `GET /api/feed?limit=`. Reads the R2 `feed/latest.json` artifact
  first (flat object read, same discipline as `summary.js`); falls back to a live `events` query
  in D1 when the artifact is missing or corrupt, matching `buildFeed()`'s own shape so the two
  paths agree.
- `functions/api/decay-watch.js` — `GET /api/decay-watch?limit=`. Ranks objects by their
  **soonest** predicted reentry, using each object's *latest* decay message — a later 60-day or
  TIP prediction supersedes an earlier one, found via a `(NORAD_CAT_ID, MAX(MSG_EPOCH))` subquery
  join rather than a window function (D1's SQLite build isn't guaranteed to have them, and no
  other query in this package uses one). Excludes objects already marked `DECAY_DATE` — a stale
  prediction for something confirmed down is noise. Each row carries a `days_until` countdown.
  These are Space-Track's **own** predictions, so the response explicitly says this is not the
  project's derived conjunction screening (that's wave 5).
- `functions/api/boxscore.js` — `GET /api/boxscore`. A flat read of the `boxscore` table
  (ranked by `COUNTRY_TOTAL` descending); small enough (122 rows) to skip an R2 artifact.
- `public/spacetrack/` — one new HUD panel, `// SIGNAL FEED` (bottom right, same collapsible
  chip pattern as the other three panels), with three sections: recent events, decay watch and
  top-country boxscore. Each section fails soft into its own hint text rather than throwing —
  the same discipline as the filter form's failed-query message.
- Unit tests: `workers/orbit-ingest/test/pages-api.test.mjs` — R2-artifact-first / D1-fallback
  for feed, latest-message-wins and already-decayed-exclusion for decay-watch, ranking for
  boxscore. **29/29 passing.**
- E2E: `tests/e2e/test_orbit.py` — the panel and its 9 child elements exist, the three loaders
  are exposed for debugging, and a failed fetch (the static test server has no Pages Functions)
  reports in its hint instead of throwing. **63/63 passing.**

**Wave 5 — derived conjunction screening. ✅ BUILT.** Close-approach detection in a Web Worker
over the rendered slice, permanently badged `UNOFFICIAL — NOT FOR COLLISION AVOIDANCE`.

- `public/orbit-engine/conjunction.js` — the maths, with **no propagator in it**. The caller
  injects `sample(i, tMs, out, offset)`, which is what lets the whole driver be unit-tested in
  Node against analytic two-body orbits whose closest approach is known in closed form.
- **The coarse march is complete, not best-effort.** A pair's true minimum is at most Δt/2 from
  a coarse sample, so at the nearest sample it is within `d_min + v_rel·Δt/2`. The capture gate
  is therefore *derived* — `gate = threshold + MAX_REL_SPEED·Δt/2` — never tuned, and
  `MAX_REL_SPEED` is twice surface escape speed (22.4 km/s), which nothing still bound to Earth
  can exceed. At the shipped Δt = 15 s the gate is 178–193 km. A tuned gate would fail silently
  and look like "there were no conjunctions", so `maxStepSec()` inverts the relation and the
  tests assert it both ways.
- **Refinement is a two-pass linear TCA from state vectors**, not a ternary search: relative
  acceleration between two nearby objects is ~1e-4 km/s², so over the ±15 s bracket the straight-
  line minimum is exact to well under a metre. Measured against the closed-form answers it
  converges to **<1 mm and <1 ms**, so the test tolerances are set there — loose ones would let a
  regression to a single pass (which reports the separation at the *sample*, ~115 km out) through.
- **The sieve compares RADII, not altitudes.** Perigee/apogee come from `satrec.a` and
  `satrec.ecco` rather than the catalog's `APOGEE`/`PERIAPSIS` fields — which are altitudes, the
  trap recorded above — so the screen also works for an object with no catalog row.
- **No spatial broadphase, deliberately.** The slice is capped at 500 objects, so the worst case
  is ~125k squared-distance tests per step against ~500 SGP4 calls. A grid optimises the term
  that is a handful of flops, not the one that is hundreds. The static shell sieve, which removes
  pairs *once* before the time loop, is the part worth doing — a LEO×GEO pair costs zero
  propagations, and the tests assert exactly that rather than merely asserting zero results.
- **A second worker, not the propagation worker.** `propagate.worker.js` ticks every 280 ms and
  is what keeps the globe moving; a screen is seconds of solid SGP4. `screen.worker.js` is also a
  **module** worker (the first in this repo) because it imports `conjunction.js` — `importScripts`
  cannot load an ES module, and a classic-script copy of the maths would be the forking mistake
  plan 33 exists to prevent. Note the distinction from the wave-3 trap: a relative *worker URL*
  resolves against the page, but a relative *import specifier* resolves against the module.
- **There is no synchronous fallback**, unlike the propagation worker. A main-thread screen would
  lock the page for ten seconds with no way to interrupt; declining and saying so is the honest
  failure. `screen-client.js` reports which case the caller is in.
- **Two honesty affordances in the UI, both from the first real run.** Each row shows the *age of
  the two element sets* — SGP4 on a public TLE drifts kilometres within days, so a sub-km miss off
  week-old elements is precision the input does not have. And a pair whose relative speed is under
  100 m/s is labelled **co-orbiting** rather than given a time: its separation is flat across the
  window, so the solver's "TCA" is wherever rounding landed, and naming the formation is both
  truer and more useful.
- CONJUNCTIONS shares the bottom-right slot with SIGNAL FEED via a new `data-hud-slot` attribute —
  collapsed they are chips at distinct offsets, and expanding one closes its slot-mate, which
  generalises the one-at-a-time rule the mobile layout already used.
- **Measured cost** on the worst case (500 objects that all survive the sieve, ~100k pairs):
  **0.75 s / 2.4 s / 7.4 s** for the 30-min / 2-h / 6-h windows. Slower hardware scales linearly,
  which is why the run is chunked, reports progress and is fired by a button rather than
  automatically.
- **`satellite.min.js` is not the same module in Node as in the browser.** Node's syntax detection
  sees no import/export, treats it as CommonJS, and the UMD takes the `module.exports` branch —
  so `globalThis.satellite` is never set and a bare `satellite.x` is a ReferenceError. In a
  browser module worker there is no `module`, so it falls through to globalThis and works. Use a
  **default import** in Node. This first showed up as a benchmark that silently screened zero
  objects, so `screen.worker.js` now throws when the global is missing rather than producing a
  clean-looking empty result.
- **τ is clamped to one step and the reported miss is evaluated at the CLAMPED τ.** A correctness
  guard, not a tuning detail: `τ = −(Δr·Δv)/|Δv|²` blows up as `|Δv| → 0`, and a near-co-orbiting
  pair — one constellation plane, or one launch's debris — has exactly that geometry. Its
  unconstrained minimum can sit thousands of seconds away, long after the orbits have curved and
  `|Δr + Δv·t|` has stopped meaning anything; reporting it would invent approaches that never
  happen, at a time that can fall outside the window. Clamping costs nothing on a real crossing
  (τ there is a fraction of a step) and completeness is untouched, because the march visits every
  step anyway. The test asserts the invariant rather than a number: **for every row, the reported
  miss equals what an independent propagation finds at the reported TCA.**
- Unit tests: `workers/orbit-ingest/test/conjunction.test.mjs`, **25/25** — completeness against a
  TCA placed exactly mid-step, threshold vs gate, one row per pair however many crossings, the
  sieve costing zero propagations, the extrapolation guard above, and the cross-file invariants
  (the worker imports the shared maths; the client passes `{type:'module'}`; the badge is in the
  markup).
- E2E: `tests/e2e/test_orbit.py` — **91/91**. Injects a co-orbiting twin (one real elset with the
  mean anomaly nudged 0.05°) via `addObjects()`, runs the screen, then **re-propagates both
  objects on the main thread with satellite.js at the TCA the worker reported**: agreement is
  sub-millimetre.
- **The E2E's own twin-TLE helper had a bug that made the test pass for the wrong reason.** It
  formatted a 6-digit catalog number into the 5-wide field, so the line grew a character and every
  field after it shifted — satellite.js read the twin's inclination and mean motion off by a
  column. The test still passed, because the *comparison* used the same corrupted line. A TLE is a
  fixed-column format, so `twin_tle()` now asserts each field width and that the line length is
  unchanged.

**Mobile pass (not a wave — an audit closeout). ✅ DONE 2026-07-28.** All 16 findings in
`docs/mobile-audit-orbit-spacetrack.md` fixed across both pages and the shared engine, and
covered by a new `mobile_gate()` in `tests/e2e/test_orbit.py` running at 390×844 / DPR 3.

- `tuneViewerForDevice()` in the shared engine: **render on demand** (`requestRenderMode`, with
  `maximumRenderTimeChange` as a clock backstop so lighting keeps up on a page with no
  satellites) plus a resolution cap. A still camera now draws at the propagation tick's ~4 fps
  rather than 60. `SatEngine.requestRender()` is called from all six paths that change the
  scene — this is a **silent-failure** optimisation: miss one call and the globe freezes while
  positions, tick counts, worker agreement and `scene.pick()` all keep passing, so the gate
  counts `postRender` events and fails at zero.
- **The audit's top finding was wrong and its fix would have hurt.** H1 claimed Cesium renders
  at `devicePixelRatio` (9× the pixels on a phone). Measured: `useBrowserRecommendedResolution`
  defaults `true`, a 375×812 CSS canvas has a 375×812 buffer — ratio **1.0**. The recommended
  `resolutionScale = 1/dpr` would have cut it to a third. Shipped a guard (pin the flag) plus
  the saving that existed (0.85 below 600px). Same family as the GP-predicates lesson: a
  plausible claim about someone else's default is worth one measurement before acting on it.
- **Safe areas use `calc(base + inset)`, never `max(px, env(…))`.** The HUD panels are stacked
  chips at deliberately distinct offsets; `max()` collapses the gap as soon as an inset exceeds
  the smaller offset and puts one panel's toggle back under another's body.
- **CSS cascade order beat the obvious fix**: overrides in the main mobile block lost to
  `.refresh-btn`/`.source-btn` base rules declared *later* in `orbit.css`. Their mobile sizing
  lives in a trailing block now. Caught only because the check measured the element rather than
  asserting the rule existed.

**Wave 6 — the daily brief. ✅ BUILT.** Narrative cards, generated **once per day at ingest** and
stored as R2 JSON, read back by a flat object GET. Never per-request: visitor traffic must not be
able to drive inference cost, and a model call on the read path would also make the card differ
between two people looking at the same page on the same day.

The plan above said "drop without consequence if the output reads as filler". That phrase drove
the design more than anything else in it, in two directions.

- **The card is facts first and narrative second, so there is nothing to drop.**
  `collectFacts()` computes every number in SQL; the model is only ever asked to *phrase* those
  numbers and is never the source of one. The artifact carries the facts whether or not a
  narrative was produced, and the panel renders them either way — with generation off, DAILY
  BRIEF is a digest of figures that are all still true. "Droppable without consequence" became a
  property of the artifact rather than a promise about a future decision.
- **The gate makes filler the *only* bad outcome.** The failure this wave is actually exposed to
  is not dullness — it is a fluent sentence with an invented number in it, sitting in a panel
  beside columns of measured data that lend it credibility, where nothing downstream would ever
  catch it. So `checkNarrative()` rejects any narrative containing a numeral that is not in the
  facts it was given. **Including one the model computed correctly**: three new objects out of
  five tracked really is 60%, and it is still rejected, because "the model did arithmetic" and
  "the model made it up" are indistinguishable from the output alone. This is the same shape of
  defence as wave 5's *derived* capture gate — an assertion that makes the bad outcome
  impossible rather than unlikely — and it is the same family as the GP-predicates bug: the
  symptom would have been plausible-looking content, never an error.

Everything else follows from those two:

- **A rejection is recorded, never swallowed.** `narrative_status` carries `rejected: unsupported
  number "8842"` into the artifact and the panel says *narrative withheld — failed its
  fact-check*. A card that quietly stopped generating would look identical to a quiet day, which
  is the silent-zero failure mode this project keeps running into.
- **A quiet day is never narrated.** Asking a model to describe nothing happening produces filler
  by definition, so `isQuiet()` skips generation entirely rather than spending a call on it.
- **The narrative also may not mention conjunctions or collisions** — a content rule with a legal
  basis rather than a stylistic one. CDM is the single class absent from USSPACECOM's enumerated
  basic-SSA set, and the only close-approach surface on this site is badged UNOFFICIAL and derived
  in the visitor's own browser; a daily narrative asserting collision risk would be an unbadged
  claim about exactly the thing we do not redistribute.
- **The badge sits above the paragraph**, like the conjunction panel's — a provenance note read
  after the sentence is a provenance note read too late. The text goes in via `textContent`: this
  is the one string on the page written by a language model, and "a model is unlikely to emit
  markup" is not a security boundary. The E2E asserts an `<img onerror>` in a narrative creates no
  element.
- **`/api/brief` has no fallback, unlike `/api/feed`.** Rebuilding the card on a read would either
  need inference — the thing this wave exists to prevent — or would pair freshly-computed facts
  with a sentence that was checked against *older* ones, quietly breaking the exact property the
  gate holds. A missing artifact is reported as missing, at 200, because "not built yet" is a
  normal state. A unit test hands the endpoint a D1 that throws if touched.
- **Workers AI is the default provider, and the choice was nearly free.** One call a day from an
  Actions runner makes both latency and cost irrelevant — which is most of what a faster inference
  host sells — so the tiebreak was operational surface, and Workers AI adds none: the account, D1,
  R2 and token plumbing already exist, and enabling it is one extra permission on a token already
  in the repo secrets rather than a new vendor and a new ToS. `src/brief.js` is written against the
  **binding interface** (`env.ORBIT_AI.run(model, input)`), so `scripts/ai-node.mjs` can put Groq
  behind the same call with nothing above it changing, and a bigger model
  (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) is available without leaving Cloudflare.
- **Gated, and the gate is off.** No model call happens anywhere unless `ORBIT_AI_CARDS` is set.
  A test asserts the **Pages project does not bind Workers AI** — that absence is an invariant,
  not an accident of configuration, because an AI binding on Pages is the one thing that would
  make per-request inference possible.
- **`scripts/brief-preview.mjs` exists so the wave's own exit criterion can be applied.** "Reads
  as filler" is a judgement about prose, so it needs a way to see the prose — without turning the
  feature on in production, waiting a day for the cron and then looking at the live site. It
  prints the facts, the prompt, and the gate's verdict; `--n 5` shows the rejection *rate*.
  Nothing is written to R2 without `--write`. **A high rejection rate is a reason to change the
  model, never to loosen the gate.**
- Unit tests: `workers/orbit-ingest/test/brief.test.mjs` — **31/31**, facts against a real
  `node:sqlite` (latest-decay-message-wins, the 24 h window, the 7-day horizon) and the gate
  against a deliberately hallucinating stub model, asserting the card ships *without* a narrative
  rather than with a plausible fiction. Plus 5 in `pages-api`. **222 unit checks total.**
- **Verifying the wave found three defects, none of them via a failing test.** The `DECAY_EPOCH`
  fixture was ISO-8601 while Space-Track sends `2026-07-26 04:12:00` (`varchar(24)`, no zone) —
  the *same* "real data, wrong query shape" gap as the GP `predicates/` bug, caught this time by
  re-reading the fixture against `modeldef_decay.json` rather than by a red test. Under it: a
  horizon comparing two different date formats, and a `Date.parse()` that V8 reads as **local
  time**, which returned 5 days for a 4.0-day reentry under `TZ=America/Los_Angeles`.
  `/api/decay-watch` had the identical parse and was fixed too — wave 6 put DAILY BRIEF directly
  above DECAY WATCH listing the same objects, so a one-day disagreement between them would be
  visible on screen. The suite now runs green under three timezones and asserts the fixture *is*
  Space-Track's format.
- **Deploying and then curling production found two more, one of them mine and freshly shipped.**
  The timezone fix nulled *every* countdown on `/api/decay-watch` (200 of 200), because
  Space-Track's hour is **not zero-padded** — `1957-12-01 0:00:00` rewritten to `...T0:00:00Z` is
  not valid ISO and `Date.parse` returns NaN. Same error as the entry above, one layer down, and
  for the same reason: the fixtures were *generated* rather than captured, so both sides of every
  assertion agreed with each other about a format production does not use. Components are now read
  with a regex and assembled with `Date.UTC`. Then, with countdowns working, the live watch list
  opened with **Sputnik 1 at −25,076 days** — the `decay` table holds historical decay messages
  alongside forward predictions and the query had only an upper bound. The brief's own
  `reentry_watch` had the identical hole and would have rendered `reentry ~-25076d`, so both now
  floor the window at today's UTC date.
- **The new chip measurement found two overlaps that had already shipped.** `#results-hud` sat at
  the same 64px mobile offset as `#signal-hud` and covered it **entirely** — they are in different
  corners on a desktop and only collide once the phone rules make both full-width — and
  `#signal-hud`/`#conj-hud` overlapped by 10px, because a collapsed chip is **62px** on mobile
  (a 44px toggle plus 8px padding and borders) while the offsets kept the 52px step from when it
  was ~40px. **The mobile audit broke its own "distinct offsets so none covers another's toggle"
  invariant when it grew the touch targets**, and the comment asserting "~40px" had been wrong ever
  since. Stack is now 64 / 134 / 204 / 274. Every rule involved was correct, present and applied;
  only the geometry was wrong — which is why the check measures rects, the same lesson as the
  `.refresh-btn` cascade finding.
- E2E: `tests/e2e/test_orbit.py` — the panel is hidden when no brief exists, a facts-only card
  still renders (the droppability property, asserted rather than assumed), the badge precedes the
  narrative, markup in a narrative stays inert, a withheld narrative is stated, and the **three**
  collapsed chips now sharing the bottom-right slot do not overlap — measured at both 1400×900 and
  390×844, because the offsets that keep them apart are hand-measured and a covered toggle is a
  control the visitor cannot reach.

---

## Verification

- **Never test against production Space-Track.** The docs offer a test server for script
  development — request access via Contact Us before the first live ingest. Until then develop
  against captured JSON fixtures; suspension is real and manual to reverse.
- `wrangler dev` for Pages Functions; `wrangler dev --test-scheduled` +
  `curl 'http://localhost:8787/__scheduled?cron=17+*/6+*+*+*'` to fire ingest locally.
- `wrangler d1 execute orbit-catalog --local --file d1/orbit.sql`, then assert row counts after a
  fixture ingest and confirm a second run upserts rather than duplicates.
- Assert the budget guard: feed it a fixture that would trigger 40 calls, confirm it aborts.
- **Perf gate on Wave 1** ✅ — `tests/e2e/test_orbit.py --perf`: 625 visible / 1215 tracked over
  5 minutes, heap **83.8 → 78.5 MB** (flat). Frame rate is deliberately *not* asserted: WebGL on
  this box is SwiftShader at ~0.3 fps no matter what the page does, so an fps threshold would
  measure the rasteriser rather than the change. The main-thread cost of a tick is asserted
  instead — that is the claim, and it is CPU-bound rather than rasteriser-bound.
- **Never sleep a fixed interval and assume a worker tick landed.** At 0.3 fps the main thread can
  go seconds without running the handler that applies worker positions, so `time.sleep()` reads a
  several-second-stale coordinate. That produced a 23.7 km "coordinate bug" that was pure sampling
  error. `wait_ticks()` synchronises on a `tickCount` the page exposes; real drift is 0.10 m.
- **E2E: this repo had no orbit tests at all.** ✅ `tests/e2e/test_orbit.py` (**50 checks**,
  all green) covers the engine shape, propagation, worker agreement, the no-worker fallback,
  layer toggle/teardown, baseline resolution, console errors, the citation's presence and
  visibility on **both** pages, and — from wave 3 — that SPACE-TRACK is a link rather than a
  button, that `/spacetrack/` boots on the *shared* engine, that its worker resolves from the
  absolute URL, that its filter controls exist, and that a failed query reports rather than
  throws. Extend it with the feed render in wave 4.
- **Unit suites** ✅ `npm test` in `workers/orbit-ingest/` runs **185 checks** with no network
  and no wrangler: `spacetrack` (auth + budget guard), `schema` (schema vs `modeldef`),
  `derive` (regime/typing/groups/citation/streaming), `ingest` (all four jobs against
  fixtures), `sqlite`, `env-node`, `pages-api` and `conjunction`. `conjunction` is frontend
  code in this package for the same reason `pages-api` is — one `npm test` entry point — and
  it drives the real screening driver against analytic two-body orbits, so the assertions are
  against closed-form answers rather than against the implementation. The three SQL suites:
  - `sqlite` applies `d1/orbit.sql` to an in-memory `node:sqlite` — this is what proves the 20
    group predicates compile *and* match, that a re-ingest upserts rather than duplicates, and
    that `first_seen` survives it.
  - `env-node` drives the Actions shim's generated SQL through the same engine, asserting
    `typeof(PERIOD)` is `real` — the REST-params trap — and pins SigV4 to botocore's output.
  - `pages-api` calls the Pages Functions' `onRequest` directly against a seeded schema. It
    lives in this package because those Functions are the *read* side of the schema this
    package owns the write side of; one applied schema, both sides checked. It caught
    `Number.parseInt` accepting trailing garbage, so `/api/object/25544;%20DROP...` answered
    200 with a real dossier (never an injection — the value is bound — but a malformed path
    returning a plausible record hides the caller's bug).
- **Never sleep across a source switch either.** `location.reload()` destroys the execution
  context, so a `page.evaluate` issuing the click races the navigation and throws
  "Execution context was destroyed". `switch_source()` dispatches the click and then polls
  through the gap. Same family of trap as the fixed-sleep one above.
- Confirm the citation string is present in the DOM and in API responses — it is a condition of
  the redistribution approval, so it belongs in the test suite, not just the markup.

## User-side prerequisites (Ankit — no Cloudflare account access from here)

**✅ DONE 2026-07-28** — all steps below completed: R2 bucket/D1/KV created, schema applied to
remote D1, R2 API token created, all 7 GitHub repo secrets set, catalog seeded (31,629
objects), Pages redeployed. Kept below for reference / for re-seeding into a new environment.

**Step 1 — now.** Account-level resources. Run from `standalone/` (that is where the wrangler
account cache lives and where the printed IDs get pasted into `wrangler.toml`):

```bash
cd standalone && source ~/.nvm/nvm.sh
npx wrangler r2 bucket create orbit-data
npx wrangler d1 create orbit-catalog        # prints database_id
npx wrangler kv namespace create ORBIT_KV   # prints id   (wrangler v3: kv:namespace create)
```

**Step 2 — apply the schema.** Once per environment, from `standalone/`:

```bash
npx wrangler d1 execute orbit-catalog --remote --file d1/orbit.sql
```

**Step 3 — create an R2 API token.** Cloudflare dashboard → R2 → *Manage API tokens* →
**Object Read & Write** on `orbit-data`. It prints an **Access Key ID** and a **Secret Access
Key**. These are *not* the same thing as a Cloudflare API token and cannot be derived from
one: R2 object writes go through the S3-compatible endpoint, which means SigV4, and SigV4
cannot consume a bearer token.

**Step 4 — add the repo secrets** (GitHub → Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `SPACETRACK_IDENTITY` | `anksr2gcp@gmail.com` |
| `SPACETRACK_PASSWORD` | the account password — there is no API key |
| `CLOUDFLARE_ACCOUNT_ID` | from the Cloudflare dashboard sidebar |
| `CLOUDFLARE_API_TOKEN` | a token with **D1:Edit** |
| `ORBIT_D1_DATABASE_ID` | `e5fe1563-71ef-4fb4-9e04-554c87caf821` |
| `R2_ACCESS_KEY_ID` | from step 3 |
| `R2_SECRET_ACCESS_KEY` | from step 3 |

**Step 5 — seed the catalog.** Either from Actions (**Run workflow → job: `seed`**), which
also builds the R2 artifacts in the same run, or locally:

```bash
# ONE upstream call. Iterate with --from-file — GP is capped at 1/hour and a
# failed run costs the whole hour.
SPACETRACK_IDENTITY=anksr2gcp@gmail.com SPACETRACK_PASSWORD=... \
  node workers/orbit-ingest/scripts/bootstrap.mjs --remote
```

**Step 6 — redeploy Pages** so `functions/api/tle.js` and the new catalog endpoints pick up
the R2 and D1 bindings:

```bash
npx wrangler pages deploy public --project-name signal-playground
```

There is **no `wrangler deploy` and no `wrangler secret put`** for the ingest Worker. The old
warning still applies to anything that does use Wrangler: `secret put` is **Worker-scoped, not
account-scoped**, so running it from `standalone/` would attach the credentials to the *Pages*
project — both wrong, and the one place they must never live.

**Auth has no API key.** Space-Track has no token or key system: the two secrets above *are* the
credentials. `POST https://www.space-track.org/ajaxauth/login` with
`identity=<email>&password=<password>` returns a session cookie valid 2 hours, extended another
2 hours by `GET /app/data/whoami` (hence the KV cache). The docs are emphatic that *any* other
login URL fails.

**Test server: optional, worth requesting, not a blocker.** The docs condition it — request access
*"if you ... believe that developing/testing [your scripts] could violate our API guidelines."*
Production use here is ~8 calls/day against a 7,200/day ceiling, nowhere near the limit; the risk
is purely in iteration, since GP is capped at 1/hour and debugging an ingest script means running
it dozens of times. Ask via Contact Us (`space-track.org/documentation#contact`), but develop
against captured JSON fixtures meanwhile rather than waiting.
