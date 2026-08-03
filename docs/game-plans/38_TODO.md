# Plan 38 — Task List

One task per session. Each is self-contained: it names the files, the gate, and what
"done" means, so a cold session can start from this file plus
[the plan](38_public_dashboard_and_brief_news_plan.md) without re-deriving context.

**Every task ends with `npm test` green.** Tasks 1–3 are invisible to the running site;
the site changes at task 4.

Status: `[ ]` not started · `[~]` in progress · `[x]` done (record the commit).

---

## [x] 1 — `charts.js` + pure helpers, tests first

**Why first:** pure functions over fixtures, testable with no ingest run. The first draft
had the artifact first, which ships a payload with no consumer and nothing for a
guardrail to go red against.

**Build**
- `public/shared/charts.js` — `bars()`, `stackedBars()`, `svgLine()`, `svgHistogram()`.
  DOM-node output, never `innerHTML` (repo rule). Reuse the existing `.st-bar` classes
  (`spacetrack.css:776`).
- Pure helpers in the same module or a sibling: `bin(values, {min,max,width})`,
  `cumulative(rows, key)`, `niceScale(min, max, ticks)`.
- `workers/orbit-ingest/test/charts.test.mjs`, following the `catalog-compute.test.mjs`
  import pattern (the harness already reaches into `public/`).

**Do first, before the implementation:** write the `bin` and `cumulative` tests and watch
them fail against a naive version — last-bin-edge off-by-one, and a cumulative that
resets across a year gap instead of carrying forward. CLAUDE.md: a check that has never
gone red has not been tested.

**Also in this task**
- Start `prefers-reduced-motion` handling here — one gate in this module + one CSS block.
  The repo has none anywhere today; charts are where it begins.
- Decide open question #3: move `boxSegments()` out of
  `public/spacetrack/brief/brief.js:174` into `charts.js`. Recommended yes — otherwise
  stacked-bar logic exists twice the day `stackedBars` ships.

**Done when:** `npm test` green with the new suite; no page imports it yet.

---

## [x] 2 — `launch_site` ingest (retires the AGENTS.md wart)

**Why:** `satcat.LAUNCH` is a launch **date**, not a site name — the first draft of this
plan was wrong about this, and `d1/orbit.sql:98-99`'s comment is what misled it. The
authoritative source is Space-Track's `launch_site` class (~60 static rows), per
`docs/game-plans/Space-Track.org-glossary.pdf`.

**Build**
- `d1/orbit.sql`: `launch_sites (SITE_CODE PRIMARY KEY, LAUNCH_SITE, updated_at)`.
- `workers/orbit-ingest/src/spacetrack.js`: `Q.launchSites`.
- `workers/orbit-ingest/src/ingest-launch-sites.js`, upsert pattern from
  `ingest-satcat.js`.
- Wire into **`runWeekly`** in `index.js` (not `runDaily` — the data is static, the daily
  job is already the long one, and weekly currently runs only `ingest-decay-60day` +
  `feed`). Wrap in `step()` so a failure cannot take the job down.
- **Fix `d1/orbit.sql:98-99`'s misleading comment and the `AGENTS.md:50` row in this same
  commit** — retire the wart, don't relocate it.
- Extend `schema.test.mjs` for the new table.

**Fallback if the pull is unavailable:** static `public/data/launch-sites.json`, same
shape. Not preferred — a hand-maintained guess where an authoritative table exists.

**Done when:** `npm test` green; migration applied locally. Remote D1 migration is a
deploy-day step, not part of this task.

---

## [x] 3 — Extend `buildAnalytics` to the new artifact shape

**Files:** `workers/orbit-ingest/src/derive.js:514`, `workers/orbit-ingest/test/derive.test.mjs`

**Add to `catalog/analytics.json`** (see the plan's A1 block for the full JSON shape):
`tracked`, `by_type`, `by_regime`, `launches_by_year`, `regime_by_year`,
`operator_by_year`, `cohort_on_orbit`, `rcs_sizes`, `altitude_bins`, `inclination_bins`,
`decays_by_month`; add `name` to `top_launch_sites` rows by joining task 2's map.

**Three things that are easy to get wrong**
- **Historical vs on-orbit-now split.** Launch series run over the whole catalog
  including decayed (existing, deliberate). The new distributions — `altitude_bins`,
  `inclination_bins`, `by_regime` — must filter `DECAY_DATE IS NULL`. Both rules now live
  in one artifact: **say which is which in the section comment**, or a later edit
  silently mixes them.
- **`decays_by_month` comes from `objects.DECAY_DATE`, NOT from `events`.** `events` only
  holds what the ingest has observed since it started running; sourcing it there renders
  a 24-month chart with mostly zeros, which reads as "reentries stopped."
- Mean altitude is `(APOAPSIS + PERIAPSIS) / 2` — both are existing columns.

**Keep compatible:** `functions/api/analytics.js`'s reduced-form D1 fallback shape and
its `stale: true` flag stay as they are.

**Done when:** `npm test` green; `derive.test.mjs` asserts the new keys and the
on-orbit-vs-historical filter on at least one section of each kind.

---

## [x] 4 — Rebuild `/spacetrack/analytics/` sections

**Files:** `public/spacetrack/analytics/{index.html,analytics.js}`,
`public/spacetrack/spacetrack.css`

**This ADDS sections to the existing `.st-card-grid`** (shipped in `25ab2721`/`aea6fc1a`).
Do not rebuild the layout — the grid, `.st-card`, `.st-card--wide`, `.st-stale-note` and
the heatmap matrix all work.

**New sections:** KPI strip (full-width tiles), growth (`svgLine`, two labelled series),
cohort survival (`stackedBars`), altitude + inclination histograms, type & RCS bars.
Launch sites now render real names.

**CSS work that must happen here**
- `.st-card--chart` modifier dropping `max-height: calc(100vh - 140px)`
  (`spacetrack.css:1286`). That cap is right for a feed list and wrong for a chart — a
  growth curve gets clipped and the user scrolls a box inside a page. The mobile block at
  line 1327 already does `max-height: none`, so the pattern exists.
- **Verify at 390px** that `.st-card`'s `overflow-x: hidden` is not clipping
  `.st-country-matrix`'s own `overflow-x: auto` (line 833). Every new wide section
  inherits this interaction.

**Delete** the `SITE_NAMES` hardcode at `analytics.js:19`, but keep `siteLabel()`'s
behavior that an unmapped code renders bare — a wrong name is worse than a code.

**Degraded mode:** extend the existing `staleNote()` so a section whose artifact key is
missing writes its own `.st-hint` instead of drawing an empty chart that looks like zero.

**Gate:** `npm test`; load under `npm run dev` with a clean console; check 390 / 412 /
820 / 1133 / 1400.

---

## [x] 5 — `buildBrief` archive writes

**Files:** `workers/orbit-ingest/src/derive.js`, `workers/orbit-ingest/test/brief.test.mjs`

- Write `brief/<YYYY-MM-DD>.json` alongside the unchanged `brief/latest.json`.
- Write `brief/index.json`: **last 90 days, hard cap**, each entry
  `{ date, new_objects, decays, narrative_source, headline }` — enough for a selector
  *and* a sparkline. Older days stay reachable by `?date=`.
- **Rebuild the index from an R2 `list()` prefix scan, never by appending to the previous
  index.** If the day-card write succeeds and an append-based index write fails, that day
  is permanently missing — a silent gap. A prefix scan self-heals next run.
- Add `narrative_source: 'ai' | 'manual' | 'none'` to the card.
- Failures warn and continue (`recordRun` discipline) — losing an index write must never
  fail the ingest.

**Done when:** `npm test` green; `brief.test.mjs` covers the cap, the `list()` rebuild,
and `narrative_source` on all three paths.

---

## [ ] 6 — `/api/brief?date=` and `?index`

**File:** `functions/api/brief.js` (+ `workers/orbit-ingest/test/brief-index.test.mjs`)

**Preserve the no-D1-fallback invariant.** `brief.js`'s header documents why: the
narrative cannot be regenerated on a read, and recomputed facts paired with an older
sentence break exactly the property the grounding gate holds. `?date=` and `?index` are
R2 reads or a reported-missing 200 — never a D1 rebuild.

**Tests:** archive lists older days; latest stays current; a missing day returns
`available: false` (200, not 404 — "not built yet" is a normal state); `narrative_source`
round-trips `'manual'`; the index respects the 90-day cap.

`json()` in `_catalog.js:29` already sets `X-Data-Source` on every response; keep
`withCitation` on new payload bodies for parity.

---

## [ ] 7 — Rebuild `/spacetrack/brief/`

**Files:** `public/spacetrack/brief/{index.html,brief.js}`, `spacetrack.css`

- Archive selector driven by `?index`, drawn as a clickable 90-day sparkline
  (`svgLine`) rather than a dropdown — that is the "news" affordance the page lacks.
- News groups from `events`, grouped by day, reusing the existing `EVENT_KIND` map at
  `brief.js:90`.
- "Recent launches" proxy: `new_object` filtered to `OBJECT_TYPE = 'PAYLOAD'` —
  **uppercase**; Space-Track stores `PAYLOAD`/`DEBRIS`/`ROCKET BODY`, and the title-case
  bug already bit the admin health panel. Label these *catalog entries*, not launches.
- Provenance badge: the existing `.st-machine` badge asserts fact-checked AI provenance,
  so manual text must show "Edited" instead of passing under it. That is a correctness
  requirement, not decoration.
- **Layout:** asymmetric grid — narrative + facts in a wider left column, activity and
  boxscore in a narrower right rail. Brief is prose + feeds and should read as a wire
  service; Analytics keeps the symmetric instrument grid. The two diverge on purpose.

**Gate:** `npm test`; clean console under `npm run dev`; the five viewports; ≥44px touch
targets on the archive selector.

---

## [ ] 8 — Admin brief editor

**Files:** `functions/api/admin/brief.js`, `public/admin/panels/brief-editor.js`,
one line in `public/admin/registry.js`

Last, because it depends on the auth path (plan 36) and on the archive existing.

- Reuse plan 36's `_middleware.js` HMAC cookie auth — **never a second password system.**
- `POST { date?, narrative, note? }` → overwrites that day's `narrative`, leaves the
  facts untouched, sets `narrative_source: 'manual'`, rewrites the index.
- **Enforce `brief.js`'s `FORBIDDEN` collision/conjunction phrase list on manual text.**
  It is a legal constraint, not a stylistic one. Manual text skips only the *number*
  gate (`checkNarrative`), never the language block.
- `adminJson(body, status)` takes a **positional** status — the options-object signature
  broke every admin error status once already; `admin.test.mjs` guards it.
- Panel DOM via `createElement`; per-panel error render must not blank the dashboard;
  clear `panelTimers` on logout.

---

## [ ] 9 — Wiki glossary + final gates

- `/wiki/` glossary entries for terms this plan introduces: *cohort*, *cumulative catalog
  entries* vs *still on orbit*, *catalog entry vs launch*, *altitude bin*, *launch site
  code*.
- `tests/e2e/test_dashboard_mobile.py`: assert
  `documentElement.scrollWidth <= window.innerWidth` at every viewport — while the matrix
  and histogram containers *do* scroll. Page must not; sections must.
- Full `npm test` green.

**No landing-page sync needed** — this plan adds and removes no route, and CLAUDE.md's
sync rule covers whole routes appearing or disappearing, not new sections on an existing
page.

---

## Standing invariants for every task in this plan

- **`npm test` green before "it works."** Then load the route under `npm run dev` with a
  clean console — a rendering page is not proof; a dead ES module fails silently.
- **Root-absolute cross-package imports** (`/shared/charts.js`), relative intra-package.
  `resolve.mjs` enforces it.
- **No `innerHTML` with API-derived data.** `createElement` throughout.
- **`operator` is derived** — badge it wherever `operator_by_year` is shown.
- **Never claim a historical on-orbit curve.** Growth axes read *cumulative catalog
  entries* and *still on orbit today*. This is the easiest way for this page to state
  something false.
- **Mobile is a requirement, not a pass** — 390 / 412 / 820 / 1133 / 1400, no horizontal
  page scroll, ≥44px targets.
