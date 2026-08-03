# Public Catalog Dashboard + Brief/News Plan

*Revised 2026-08-03. Supersedes the first draft, which was written before commits
`25ab2721` / `aea6fc1a` landed and contained one factually wrong section (A4 — see the
correction below). Every claim in this revision was checked against the working tree,
`d1/orbit.sql`, and the Space-Track glossary PDF in this directory.*

## Context

Two of the five nested `/spacetrack/` pages are underbuilt relative to the data that
already exists in D1:

- **`/spacetrack/analytics/`** is a four-section CSS-bar page backed by one flat R2 read
  (`catalog/analytics.json`, rebuilt daily by `buildAnalytics` at
  [`derive.js:514`](../../workers/orbit-ingest/src/derive.js)). It shows launches by
  decade, top launch sites (mostly as raw codes like `AFETR`), debris families, and a
  country×decade heatmap matrix. No time series, no cohort or orbit-distribution views.
  The dataset is far richer than this page suggests.
- **`/spacetrack/brief/`** is a "today" card backed by `brief/latest.json` (overwritten
  each daily ingest — **there is no archive** — so there is nothing "newsworthy" about
  it) plus three live drops: signal feed, reentry watch, boxscore. The AI narrative is
  facts-first and fact-checked, but it is one card with no history.

Special feature spec #19 ("Analytics Dashboard — statistics for objects, launches,
operators, orbit types *and trends*") is only partially met. Spec #18 (Historical growth)
ships for free from the data we already hold.

What this plan does NOT do: touch the `/admin/` dashboard, expose site traffic or ingest
operational data on a public page, or add a charting dependency. Public analytics page =
**catalog** data; `/admin/` = **site** data (a visitor-count panel would contradict
`#privacy` in plan-37's `/about/` copy).

### What already shipped (do not rebuild it)

`25ab2721` and `aea6fc1a` already landed the layout foundation this plan builds on:

- Both pages dropped the collapsible fixed HUD for a static `.st-card-grid` of
  `.st-card` sections ([spacetrack.css:1259](../../public/spacetrack/spacetrack.css#L1259)).
  **A3 below adds sections to that grid; it does not replace it.**
- Activity (signal feed, reentry watch) and Boxscore moved off the catalog globe page
  onto Brief, with color-coded orbital/decayed segments via `colorForBoxCode`.
- The country×decade matrix became a heatmap with row/column totals
  ([analytics.js:87](../../public/spacetrack/analytics/analytics.js#L87)).
- `.st-stale-note` / `staleNote()` render the `artifactOrDb` degraded flag.
- `analytics.js:19` hardcodes five launch-pad names with an explicit comment that an
  unmapped code stays bare rather than guessing. A1.5 below makes that map complete and
  authoritative; the "never guess a name" rule stays.

### Decisions already made

1. **No charting library.** Repo rule (no build step). Charts are pure SVG/CSS from a
   small `public/shared/charts.js`, Node-testable in the existing orbit-ingest harness.
2. **Public data only.** No `page_views`, no `ingest_runs`, no admin internals.
3. **Both pages are flat-read dashboards** — one artifact read per page, refetched on an
   interval, degraded-reported-as-stale, following `summary.js`'s discipline.
4. **Brief gets an archive** (`brief/YYYY-MM-DD.json`), narrative provenance, and news
   rows from the `events` table.
5. **Reuse plan 36's admin auth** for the manual-brief endpoint — no second password.
6. **The `/api/brief` no-D1-fallback invariant is preserved** for `?date=` and `?index`.
   Those are R2 reads or nothing, for the same reason `brief.js` documents today.

---

## The dataset we are actually drawing from

Everything below is in D1 today; nothing here requires new upstream data **except
A1.5's `launch_site` class**, which is called out explicitly because it is the one new
Space-Track pull this plan adds.

- **`objects`** — full OMM/GP mirror: `LAUNCH_DATE`, `DECAY_DATE`, `OBJECT_TYPE`,
  `COUNTRY_CODE`, `SITE`, `RCS_SIZE`, `SEMIMAJOR_AXIS`, `PERIOD`, `INCLINATION`,
  `APOAPSIS`, `PERIAPSIS`, `EPOCH`, `regime`, `launch_year`, `debris_family`, `operator`,
  `first_seen`, `updated_at`. Powers nearly every analytics panel.
- **`boxscore`** — per-country orbital/decayed/payload/rocket-body/debris tallies, daily.
- **`events`** — the derived signal feed: `new_object`, `decay`, `reentry_predicted`,
  `satcat_change`. This is our **news feed**. **Important limitation: this table only
  holds what the ingest has observed since it started running** — it is not a historical
  record. See A1's `decays_by_month` note.
- **`decay`** — reentry messages incl. 60-day predictions, keyed
  `(NORAD_CAT_ID, MSG_EPOCH)`. Unlike `events` this carries real history.
- **`satcat`** — the satellite catalogue proper. **Its `LAUNCH` column is a launch DATE,
  not a site name** (see A1.5).
- `api_calls`, `page_views`, `ingest_runs` — **admin-only**, listed to say explicitly
  what is *not* used here.

---

## Proposal A — `/spacetrack/analytics/` becomes the catalog dashboard

### A1. Extend the artifact, not the read path

`buildAnalytics` today writes `catalog/analytics.json` with only `launches_by_decade`,
`top_launch_sites`, `debris_families`, `country_by_decade`. Grow it (still one GROUP BY
per section, same ingest step, same day cadence) to:

```jsonc
{
  "generated_at": …,
  "citation": …,
  "tracked": …,
  "by_type":   { "payload": n, "rocket_body": n, "debris": n, "unknown": n },
  "by_regime": { "leo": n, "meo": n, "geo": n, "heo": n },
  "launches_by_decade": […],                                  // keep
  "launches_by_year":   [{ "year": 1957, "n": n }],            // full history
  "regime_by_year":     [{ "year": 2019, "leo": n, "meo": n, "geo": n, "heo": n }],
  "operator_by_year":   [{ "year": 2019, "top": {…}, "other": n }],  // see A1.4
  "cohort_on_orbit":    [{ "decade": 1990, "launched": n, "still_on_orbit": n }],
  "top_launch_sites":   [{ "site": "AFETR", "name": "Cape Canaveral SFS", "n": n }],
  "debris_families":    […],                                  // keep
  "country_by_decade":  { … },                                // keep as-is
  "rcs_sizes":          { "SMALL": n, "MEDIUM": n, "LARGE": n, "UNKNOWN": n },
  "altitude_bins":      [{ "min": n, "max": n, "n": n }],
  "inclination_bins":   [{ "min": n, "max": n, "n": n }],
  "decays_by_month":    [{ "month": "2026-01", "n": n }]       // from `objects.DECAY_DATE`
}
```

Key derivations:

- **`cohort_on_orbit`** — `GROUP BY (launch_year/10)*10` with a `DECAY_DATE IS NULL`
  split. "Of the things launched in the 1980s, how many are still up?" Interesting, free,
  and it is a *survival* statistic, not a timeline.
- **Growth** — `launches_by_year` plus a client-side cumulative sum. A true historical
  on-orbit profile would need a decayed-count-by-date series we do not hold, so the UI
  ships *cumulative catalog entries* and *still-on-orbit today* as two clearly distinct
  series and **never claims** a historical on-orbit curve. This distinction is a label
  requirement, not a nicety (see Risks).
- **`altitude_bins` / `inclination_bins`** — mean altitude per object is
  `(APOAPSIS + PERIAPSIS) / 2`; both are already columns. Bin with the shared `bin()`
  helper from A2, over `DECAY_DATE IS NULL` only (a distribution of *where things are*
  is an on-orbit-now question, unlike the historical launch counts).
- **`decays_by_month`** — **source this from `objects.DECAY_DATE`, not from `events`.**
  The first draft said `events`; that would have rendered a 24-month chart with a few
  months of data and the rest zeros, which reads as "reentries stopped." `objects` and
  the `decay` table both carry real history. Prefer `objects.DECAY_DATE` — one GROUP BY
  on the table already being scanned.

**Correction vs. the ingest step's existing comment:** `buildAnalytics` runs its
aggregates over the *whole* catalog including decayed objects, deliberately, because
"how many launched in the 1980s" is a historical count. That stays true for the launch
series. The new distribution sections (`altitude_bins`, `inclination_bins`, `by_regime`)
are the opposite — they must filter `DECAY_DATE IS NULL`. Both rules now live in one
artifact, so **the section comment must say which sections are historical and which are
on-orbit-now**, or a future edit will silently mix them.

### A1.5. `SITE` code → name — **the corrected version of the old A4**

The first draft said to build the name map from `satcat` `(SITE, LAUNCH)` pairs, citing
`d1/orbit.sql:98-99`'s comment that SATCAT "carries the fields GP does not, chiefly the
human-readable launch site."

**That comment is wrong and the plan step built on it was wrong.** Per the Space-Track
glossary shipped at `docs/game-plans/Space-Track.org-glossary.pdf`:

> **Launch:** Date object was launched in YYYY-MM-DD format.
> **Launch Site:** See `basicspacedata/query/class/launch_site/format/html`

`satcat.LAUNCH` is a **date**. `satcat.SITE` is the same opaque code `objects.SITE`
holds. Grouping `(SITE, LAUNCH)` would yield site-code × launch-date pairs — garbage.
[AGENTS.md:50](../../AGENTS.md#L50) already flags the schema comment as misleading.

**The authoritative source is Space-Track's own `launch_site` class** — a small static
table (~60 rows, `SITE_CODE` → `LAUNCH_SITE`) that this repo has never ingested.

Do this instead:

1. Add a `launch_sites (SITE_CODE PRIMARY KEY, LAUNCH_SITE, updated_at)` table to
   `d1/orbit.sql`.
2. Add `workers/orbit-ingest/src/ingest-launch-sites.js` following `ingest-satcat.js`'s
   upsert pattern, and a `Q.launchSites` query in `spacetrack.js`. It is one request
   against a table that effectively never changes.
3. Wire it into **`runWeekly`** in `index.js` — not `runDaily`. The data is static and
   the daily job is already the long one; the weekly job currently runs only
   `ingest-decay-60day` + `feed`. Guard it with `step()` like every other step so a
   failure cannot take the job down.
4. `buildAnalytics` joins the map in so the artifact ships `{ site, name, n }` and the
   frontend does no lookup.
5. **Delete the `SITE_NAMES` hardcode** at
   [analytics.js:19](../../public/spacetrack/analytics/analytics.js#L19) once the
   artifact carries names — but keep `siteLabel()`'s behavior that an unmapped code
   renders bare. A wrong name is worse than a code; that comment's reasoning survives
   the change.
6. **Fix the misleading comment** at `d1/orbit.sql:98-99` and the AGENTS.md row in the
   same commit, so the wart is retired rather than relocated.

Fallback if the `launch_site` pull turns out to be unavailable or rate-limited: ship
`public/data/launch-sites.json` as a static file with the same shape. Not preferred —
it is a hand-maintained guess where an authoritative table exists.

### A2. `public/shared/charts.js` — pure SVG/CSS primitives, built and tested FIRST

**Build order note (changed from the first draft):** this module comes *before* the
artifact work. It is pure functions over fixture data, testable today with no ingest run.
The first draft had the artifact first, which ships a payload with no consumer and
nothing for a guardrail test to go red against — the opposite of CLAUDE.md's rule.

Pure functions, no framework, DOM-node output (not `innerHTML`, per repo rule):

- `bars(container, rows, { label, value, color, max })` → reuses the existing `.st-bar`
  classes already in `spacetrack.css:776`.
- `stackedBars(container, rows, { segments })` → type×decade, cohort survival. The
  boxscore's existing orbital/decayed segment logic at
  [brief.js:174](../../public/spacetrack/brief/brief.js#L174) is the model; consider
  moving `boxSegments()` into this module rather than leaving a fourth segment
  implementation in the repo.
- `svgLine(container, points, { w, h, xLabel, yLabel, series })` → growth and decay
  trends. Multi-series, because growth needs "cumulative launched" and "still on orbit"
  on one axis.
- `svgHistogram(container, bins, { axis, unit })` → altitude / inclination.

Pure helpers, Node-tested in `workers/orbit-ingest/test/charts.test.mjs` (following the
`catalog-compute.test.mjs` / `signal-compute.test.mjs` import pattern — the harness
already reaches into `public/`):

- `bin(values, { min, max, width })` — shared with the catalog heatmap binning in
  `public/spacetrack/catalog/compute.js` per C2. **One binning implementation, one test.**
- `cumulative(rows, valueKey)` — the growth series.
- `niceScale(min, max, ticks)` — axis ticks that are not ugly.

**Write `bin` and `cumulative` tests first and watch them fail against a naive
implementation** (off-by-one on the last bin edge; cumulative that resets on a year gap
rather than carrying forward). A check that has never gone red has not been tested.

**`prefers-reduced-motion` starts here.** CLAUDE.md notes the repo has no reduced-motion
handling anywhere and that any new animation is where it begins. `.st-bar__fill` already
has a `transition: width 0.3s` — charts add more. Gate all chart transitions in this one
module and in a single CSS block, so it is handled once rather than per-page.

### A3. Dashboard sections — **added to the existing `.st-card-grid`**

The grid, `.st-card`, `.st-card--wide` and `.st-stale-note` already exist and work. Add
sections; do not rebuild the layout.

1. **KPI strip** — `tracked` / payloads / debris / regime split / artifact age, as a
   full-width `.st-card--wide` row of monospace stat tiles at the top of the grid.
2. **Growth** — `svgLine`, two labelled series (cumulative catalog entries; still on
   orbit today). Axis labels carry the distinction.
3. **Cohort survival** — `stackedBars` by decade, on-orbit vs decayed.
4. **Orbit distribution** — two `svgHistogram`s (altitude, inclination), `approx` labels.
5. **Type & RCS** — type split + RCS-size bars.
6. **Launch sites** — top 12, now with real names from A1.5.
7. **Debris families / country×decade matrix** — keep both as they are today.
8. **Degraded mode** — the existing `staleNote()` pattern covers the page-level flag.
   Extend it so a *section* whose artifact key is missing says so in its own `.st-hint`
   rather than rendering an empty chart that looks like "zero."

**New CSS needed — `.st-card` currently fights charts.**
[spacetrack.css:1286](../../public/spacetrack/spacetrack.css#L1286) gives every card
`max-height: calc(100vh - 140px)` + `overflow-y: auto`. That is right for a feed list and
wrong for a chart: a growth curve gets clipped at an arbitrary height and the user
scrolls a box inside a page to see the top of a line. Add a `.st-card--chart` modifier
that drops the cap — the mobile block at line 1327 already does exactly this
(`max-height: none`), so the pattern exists.

**Also check:** `.st-card` sets `overflow-x: hidden`, while `.st-country-matrix`
correctly sets `overflow-x: auto` (line 833). Verify at 390px that the card-level
`hidden` is not clipping the matrix's own scroller instead of letting it scroll. Every
new histogram and wide table inherits this interaction.

### A4. Terminal-grid visual direction

Analytics wants a **denser, instrument-like** grid: full-width KPI strip of stat tiles
with hairline dividers, then charts in the auto-fit flow, then wide tables pinned last.
Charts read as scopes — thin cyan hairline axes, no heavy fills, values in `--font-mono`
matching `.st-card__title`'s 0.72rem/1.4px. Reuse the `--heat` gradient idiom from
`.st-matrix__cell` for histogram bars so the two pages share one visual grammar.

---

## Proposal B — `/spacetrack/brief/` becomes briefs + news archive

### B1. Archive the brief (the enabler)

`buildBrief` writes **both**:

- `brief/latest.json` — unchanged read path, `/api/brief` keeps today's semantics.
- `brief/<YYYY-MM-DD>.json` — the same card, keyed by the day it narrates.

Plus `brief/index.json` so the frontend renders an archive selector without listing R2
keys on every load.

**Index shape and cap (was "open decision #2" — now decided).** The index holds the
**last 90 days, hard cap**, each entry carrying enough to draw a selector *and* a
sparkline:

```jsonc
{ "generated_at": …, "total": 412,
  "days": [{ "date": "2026-08-03", "new_objects": n, "decays": n,
             "narrative_source": "ai", "headline": "…" }] }
```

Older days stay fetchable by direct `?date=`. Without a cap, year three ships a
700-entry JSON to every visitor.

**Rebuild the index from an R2 `list()` prefix scan, do not append to the previous
one.** This is a correction to the first draft's B5. If the day-card write succeeds and
the index write fails, an append-based index permanently omits that day — a silent gap,
not the "dates shift, no false gap" the draft claimed. A prefix scan self-heals on the
next successful run.

### B2. Narrative provenance

The card carries `narrative_status`. Add `narrative_source: 'ai' | 'manual' | 'none'`:

- `'ai'` — status `ok` after the check-gate.
- `'none'` — disabled / skipped / failed gate.
- `'manual'` — authored via `/api/admin/brief`, overriding the AI text for that day.

`checkNarrative()` (the grounding gate that rejects any sentence containing a numeral
absent from the facts) applies to **AI prose only**; manual text is author-signed. The
public page shows today's badge line plus, when manual, "Edited" vs "AI-generated", so
the reader knows which voice they are reading. **This badge is the whole point** — the
existing `.st-machine` badge asserts fact-checked AI provenance, and manual text passing
under it would be a false claim.

### B3. Manual-brief endpoint (`/api/admin/brief`)

Reuse plan 36's auth (`_middleware.js`, HMAC cookie) — never a new password. `POST`
`{ date?: 'YYYY-MM-DD', narrative, note? }`:

- Overwrites `brief/<date>.json`'s `narrative`; the facts stay untouched.
- Sets `narrative_source: 'manual'`.
- **Rejects** any narrative containing a forbidden collision/conjunction phrase.
  `brief.js`'s `FORBIDDEN` list is a *legal* constraint, not a stylistic one — manual
  text gets the same language block AI text does; it only skips the number-gate.
- Rewrites `brief/index.json` after the card write.

Ships as `panels/brief-editor.js` + one line in `registry.js` — plan 36's extension
contract. `adminJson(body, status)` takes a **positional** status; every call site
passes `(body, 401)` (guarded by `admin.test.mjs`).

### B4. Auto news sections

Built entirely off the `events` table:

- **Today / Recent** — signal-feed rows grouped by day. All four kinds already render
  with a label and semantic class at
  [brief.js:90](../../public/spacetrack/brief/brief.js#L90).
- **"Recent launches" proxy** — `new_object` events filtered to `OBJECT_TYPE = PAYLOAD`
  (**uppercase** — Space-Track stores `PAYLOAD`/`DEBRIS`/`ROCKET BODY`; the title-case
  bug already bit the admin health panel). Label it *catalog entry*, not a launch — the
  two differ by days and we are not a launch-authoritative source.
- **Archive sparkline** — the B1 index's `new_objects`/`decays` per day drawn with
  `svgLine`, click-to-load. This is the "news" affordance a dropdown does not give.
- **Featured note** — optional `featured: true` on an archive card surfacing a curated
  operator's note above the auto feed. v2, one flag.

Constraints locked in: `FORBIDDEN` collision language enforced for all narrative text,
AI and manual; AI prose is build-time only, once per day, fact-checked to the number;
nothing here authors news — it renders derived events and posted briefs.

### B5. Brief visual direction

Brief is prose + feeds, not a dashboard — the three-card auto-fit is arguably already
too wide for the narrative at 1400px. Consider an asymmetric grid: narrative + facts in
a wider left column, feeds (activity, boxscore) in a narrower right rail. That reads as
a wire service rather than an instrument panel, which suits the content. Analytics keeps
the symmetric instrument grid; the two pages diverge on purpose.

---

## Cross-cutting

### C1. Panel isolation and mobile

- **Panel isolation** — one section's render failure must not blank the page. Every
  loader catches and writes its own `.st-hint`, as `loadFeed`/`loadBoxscore` already do.
- **Mobile** — dashboards carry wide content. Every chart/table section gets its own
  `overflow-x: auto` container; no horizontal *page* scroll at 390px; ≥44px touch
  targets on the archive selector. Add assertions to a `test_dashboard_mobile.py`
  sibling asserting `document.documentElement.scrollWidth <= window.innerWidth`.
  Note the A3 caveat: assert the *page* does not scroll while the matrix container
  *does*.
- **Citation** — new analytics sections are served through `artifactOrDb`, and
  `json()` in `_catalog.js:29` sets the `X-Data-Source` header on every response, so
  citation shipping is inherited. `withCitation` adds the body field; keep it on new
  payloads for parity.

### C2. plan 34 §2.2 tie-in

Altitude/inclination binning is the same class of maths as the catalog heatmap binning
already extracted to `public/spacetrack/catalog/compute.js`. Extract `bin()` to one
shared module both the globe overlay and the dashboard import. One grouping, one test.

### C3. plan 37 wiki tie-in

The dashboard introduces terms that need glossary entries: *cohort*, *cumulative catalog
entries* vs *still on orbit*, *catalog entry vs launch*, *altitude bin*, *launch site
code*. Add them to `/wiki/`'s glossary in the same session as the UI that introduces
them.

**No landing-page sync needed.** This plan adds no route and removes none — CLAUDE.md's
landing-page rule covers whole routes appearing or disappearing, not new sections on an
existing page. `/wiki/`'s per-route reference is the right place for the detail.

### C4. Attribution

Nothing here adds a second data provider. `launch_site` (A1.5) is the same Space-Track
account under the same citation and the same `api_calls` rate rail — it does not change
the attribution story. Space weather remains out of scope.

---

## Build sequence

Reordered from the first draft so every step has a consumer or a test.

1. **`charts.js` + shared `bin`/`cumulative`/`niceScale` + their Node tests.** Pure
   functions over fixtures; no ingest run needed. Tests written first and seen red.
2. **`launch_site` ingest** — schema, `ingest-launch-sites.js`, `runWeekly` wiring, fix
   the `orbit.sql:98-99` comment and the AGENTS.md row.
3. **Extend `buildAnalytics`** to the A1 shape, joining the site-name map. Update
   `derive.test.mjs`; keep `functions/api/analytics.js`'s reduced-form fallback shape
   compatible.
4. **Rebuild `/analytics/` sections** over the new artifact — KPI strip, growth, cohort,
   distributions, type/RCS — plus `.st-card--chart` and the 390px overflow check.
   Delete `SITE_NAMES`.
5. **`buildBrief` archive writes** — `brief/<date>.json` + `brief/index.json` via
   `list()` prefix scan, `narrative_source` on the card.
6. **`/api/brief?date=` + `?index`** endpoints. Tests in `brief-index.test.mjs`: archive
   lists older days; latest stays current; missing day → `available: false`;
   `narrative_source` round-trips `'manual'`; index respects the 90-day cap.
7. **Rebuild `/brief/`** — archive selector + sparkline, news groups, provenance badges,
   asymmetric grid.
8. **Admin brief editor** — `panels/brief-editor.js` + `/api/admin/brief`, last, because
   it depends on the auth path and on the archive existing.
9. **Wiki glossary additions; `npm test` green; mobile assertions.**

Steps 1–3 are invisible to the running site. The site changes at step 4.

### Out of scope

- Site traffic / visitors on public pages (that is `/admin/`, plan 36).
- Space weather (plan 34 §3.4) — second provider, second citation.
- Ground-station DB beyond the launch-site name map.
- Subscriptions / feeds / push.

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| `.st-card`'s `max-height` + `overflow` clips charts | Medium | `.st-card--chart` modifier before any chart ships; check the matrix scroller at 390px. |
| `buildAnalytics` output drifts from `functions/api/analytics.js`'s fallback | Medium | The reduced-form fallback shape stays unchanged; UI handles a partial artifact via the existing `stale` flag and per-section hints. |
| "On orbit over time" is an approximation | **High** | Axes say *cumulative catalog entries* and *still on orbit today*. Never draw a curve implying a true historical on-orbit profile. This is the easiest way for this page to state something false. |
| `decays_by_month` sourced from `events` shows phantom zeros | Medium | Source from `objects.DECAY_DATE`; `events` has no history before the ingest started. |
| Archive or index write failure takes down ingest | Medium | Same `step()`/try-catch discipline as `recordRun`; warn and continue. Index rebuilt by prefix scan, so a skipped write self-heals. |
| Manual brief appears AI-authored | Medium | `narrative_source` on every card, asserted in tests, badge in the UI. `FORBIDDEN` applies to both. |
| `launch_site` pull adds Space-Track rate pressure | Low | One request, weekly, through the existing `api_calls` rail (25/hr cap). |
| `charts.js` accretes UI state | Low | Keep it pure; DOM ownership stays in each page's module. |

## Open decisions

1. **KPI strip: full-width tiles across the top, or a left sidebar rail?** Recommend
   full-width tiles — the auto-fit grid already handles it via `.st-card--wide`, and a
   sidebar fights the single-column mobile collapse.
2. **Year vs decade axis on growth** — recommend year-major throughout with decade
   reserved for the historical matrix, matching how the data reads.
3. **Does `boxSegments()` move into `charts.js`?** Recommend yes, as part of step 1 —
   otherwise the stacked-bar logic exists twice the day `stackedBars` ships.

---

*Status: revised 2026-08-03. Steps 1–9 above are tracked in
[38_TODO.md](38_TODO.md), one session per task.*
