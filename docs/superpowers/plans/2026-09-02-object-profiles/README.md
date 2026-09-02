# Object Profiles — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.
>
> **Read this file plus your one task file, nothing else.** The shared material — goal,
> architecture, global constraints, and the cross-task interface summary — is all here and
> is deliberately not repeated in the task files. A task file is self-contained for its own
> work and silent about everyone else's.

**Goal:** Add a descriptive knowledge base for every catalogued object — mission purpose,
operator, bus, mass, status, each fact carrying its source and licence — served as a new
`/objects/` encyclopedia route and as an inline panel on `/spacetrack/`.

**Architecture:** A second D1 database (`orbit-profiles`, bound `PROFILE_DB`) isolated from
the hard-won orbital read budget in `orbit-catalog`. A new write-side Worker
(`workers/orbit-profiles/`) whose bulk import runs as a GitHub Actions job; Pages Functions
stay read-only. Cross-database joins are impossible in D1, so the API layer composes:
`/api/object/<norad>` gains a `profile` key fetched alongside its existing queries.

**Tech Stack:** Vanilla ES modules, no build step. Cloudflare D1 + R2 + Pages Functions.
Node 22+ for the ingest (plain ESM, zero dependencies). `node:test`-free — the existing
suite uses hand-rolled assertion helpers, match them.

**Spec:** [`docs/superpowers/specs/2026-09-02-object-profiles-design.md`](../../specs/2026-09-02-object-profiles-design.md)

---

## Global Constraints

Every task's requirements implicitly include this section.

### From the spec

- **Licence allowlist is an enforcement mechanism, not a policy note.** Ingest refuses to
  write any field whose `source_id` is absent from the `sources` table. v1 rows only:
  NSSDCA, GCAT, Space-Track SATCAT, NASA/USGS/NOAA imagery.
- **Hard-excluded sources**, never ingested under any circumstance: Gunter's Space Page
  (no licence), commercial operator sites (Maxar/Planet/SpaceX), ESA eoPortal (CC BY-SA),
  SatNOGS DB (CC BY-SA), Wikipedia (CC BY-SA). Share-alike would infect our output.
- **The model never sources a number.** Tier 1 = structured facts from allowlisted sources.
  Tier 2 = deterministic templated prose, no model call (~25k objects). Tier 3 = generated
  prose from verified Tier 1 facts only (~3k objects).
- **The numeral validator is mandatory.** Reject any sentence containing a numeral absent
  from the input facts, *including a correct derived one* — from the output alone a correct
  derivation is indistinguishable from an invention. A rejected sentence falls back to
  Tier 2. Modelled on `checkNarrative()` in `workers/orbit-ingest/src/brief.js`.
- **Match on COSPAR ID (`OBJECT_ID`), never on name.** "ISS (NAUKA)" and "ISS DEB" both
  substring-match — the trap documented at `functions/api/object/[norad].js:11-13`.
- **`PROFILE_DB` unbound or row missing ⇒ `profile: null`, endpoint behaves exactly as
  today. Never a 500.**
- **No chatbot.** Descriptive retrieval only — assessed and rejected in the spec.
- **Resumability is a requirement.** Every pipeline stage checkpoints by last-completed
  NORAD; a run that dies at object 14,000 restarts at 14,000. A Groq 429 is
  backoff-and-continue, not failure.
- **`operator` remains derived** — every endpoint returning it also returns
  `operator_derived: true`, and the UI badges it as derived.
- **The Space-Track citation is legally required** on every API response as `X-Data-Source`
  — use `withCitation`/`json` from `functions/api/_catalog.js`, never hand-roll a response.

### From the repo (CLAUDE.md / AGENTS.md)

- **No build step.** What you write is what the browser parses. Three consequences:
  a syntax error in one ES module executes zero statements of that module; module
  specifiers are filesystem arithmetic against the *importing file's* directory; browsers
  do not add `.js`.
- **Cross-package references are root-absolute** (`/orbit-engine/…`, `/css/tokens.css`).
  Intra-package imports stay relative (`./shared/utils.js`).
- **Cache-control for `/css/*` and `/js/*` can never be `immutable`** — filenames are not
  content-hashed. Use `max-age=3600, stale-while-revalidate=86400`.
- **`workers/orbit-ingest/` is the only writer to `orbit-catalog`.** Pages Functions are
  read-only. This plan preserves that and adds a second writer for a *different* database.
- **Mobile responsiveness is a requirement, not a pass.** Verify at 390×844, 412×915,
  820×1180, 1133×744, 1400×900 (the table in `tests/e2e/test_mobile_responsive.py`).
  Touch targets ≥ 44px. No horizontal page scroll at any viewport — wide content scrolls in
  its own `overflow-x: auto` container. `<meta name="viewport" content="…, viewport-fit=cover">`
  on every page.
- **Route-sync obligation.** `/objects/` is a whole new route, so the session that adds it
  must also update: the route table in `AGENTS.md`, `public/index.html`'s `.app-grid` +
  footer nav, `public/wiki/index.html`'s `#apps`, and `_redirects` + `_headers`. This is
  Task 9 and it is not optional.
- **`npm test` stays offline.** Ingest tests use fixtures, matching
  `workers/orbit-ingest/fixtures/`. No network in any test.
- **Code quality gates:** cyclomatic complexity ≤ 10 per function; functions under ~60
  lines; one reason to change per file (split past ~250 lines); logic takes interfaces,
  never concrete engine types or globals.

### Commands

```bash
npm test                                    # syntax + resolve + ingest suite — offline, seconds
npm run dev                                 # wrangler pages dev public → :8788
cd public && py -3 -m http.server 8931      # static-only, faster for pure frontend work
```

---

## File Structure

**New — the write side:**

| Path | Responsibility |
|---|---|
| `d1/profiles.sql` | `orbit-profiles` schema. Idempotent, re-runnable as a migration, mirroring `d1/orbit.sql`'s conventions. |
| `workers/orbit-profiles/package.json` | Test script only, zero dependencies. |
| `workers/orbit-profiles/wrangler.toml` | Write-side `PROFILE_DB` binding + `ORBIT_R2`. No crons — the bulk pass is an Actions job. |
| `workers/orbit-profiles/src/sources.js` | The licence allowlist: `SOURCES`, `assertAllowed()`, `seedSources()`. |
| `workers/orbit-profiles/src/match.js` | COSPAR normalisation + the catalogue↔NSSDCA/GCAT join. |
| `workers/orbit-profiles/src/facts.js` | Writes `profiles` + `profile_fields`; conflict resolution by `sources.priority`. |
| `workers/orbit-profiles/src/prose-tier2.js` | Deterministic templated prose. No model, no network. |
| `workers/orbit-profiles/src/validate.js` | The numeral validator. Pure, no I/O. |
| `workers/orbit-profiles/src/prose-tier3.js` | Groq-backed generation, gated by `validate.js`. |
| `workers/orbit-profiles/src/images.js` | Fetch → WebP → R2 + `images` rows. |
| `workers/orbit-profiles/src/checkpoint.js` | Resumability: last-completed NORAD per stage. |
| `workers/orbit-profiles/src/index.js` | Stage orchestration (`runMatch`/`runFacts`/`runProse`/`runImages`), mirroring `orbit-ingest/src/index.js`'s `step()` pattern. |
| `workers/orbit-profiles/scripts/run-profiles.mjs` | The Actions entry point. |
| `workers/orbit-profiles/scripts/env-node.mjs` | Re-exports `orbit-ingest`'s shim, rebound to `PROFILE_DB`. |
| `.github/workflows/orbit-profiles.yml` | Bulk import job, `workflow_dispatch` + chunked. |

**New — the read side:**

| Path | Responsibility |
|---|---|
| `functions/api/_profiles.js` | `requireProfileDb`, `profileFor(env, norad)`, shared shapes. |
| `functions/api/profile/[norad].js` | `GET /api/profile/<norad>` — profile alone, for the panel. |
| `functions/api/objects.js` | `GET /api/objects?…` — encyclopedia index, extends the `search.js` facet pattern. |
| `functions/objects/[norad]/index.js` | The crawlable shell: server-injected `<title>`, meta description, JSON-LD. |
| `public/objects/index.html` + `objects.js` | The encyclopedia index page. |
| `public/objects/object.js` | Detail-page client render, hydrating the shell. |
| `public/objects/objects.css` | Route styles. |
| `public/shared/profile-panel.js` | Flow 2 — the inline `/spacetrack/` panel. Shared, root-absolute. |

**Modified:**

| Path | Change |
|---|---|
| `functions/api/object/[norad].js` | Add the `profile` key to the existing `Promise.all`. Null-safe. |
| `workers/orbit-ingest/scripts/ai-node.mjs` | Add `openai/gpt-oss-20b` to `DEFAULT_MODELS.groq`-adjacent config. |
| `public/shared/dossier.js` | Mount the profile panel; link out to `/objects/<norad>/`. |
| `public/index.html`, `public/wiki/index.html`, `AGENTS.md`, `public/_redirects`, `public/_headers`, `public/sitemap.xml` | Route sync (Task 9). |
| `package.json` | Add `workers/orbit-profiles` to the `test` script. |

---

## Task Sequence

Each task ends with an independently testable deliverable and its own commit.

| # | Task | Deliverable | File |
|---|---|---|---|
| 1 | Schema + provisioning | `orbit-profiles` D1 exists, schema applied, bindings wired, test harness runs | [01-schema.md](01-schema.md) |
| 2 | Source allowlist | A non-allowlisted `source_id` is physically rejected | [02-sources.md](02-sources.md) |
| 3 | The numeral validator | Written first, watched red on a real fabricated number | [03-validator.md](03-validator.md) |
| 4 | COSPAR matching | The "ISS (NAUKA)" / "ISS DEB" trap is covered by a fixture | [04-matching.md](04-matching.md) |
| 5 | Facts + Tier 2 prose | `profiles` + `profile_fields` written; every object has prose | [05-facts-tier2.md](05-facts-tier2.md) |
| 6 | Tier 3 prose + pipeline | Generation gated by Task 3's validator; four resumable stages | [06-tier3-pipeline.md](06-tier3-pipeline.md) |
| 7 | Images | WebP + thumbnail in R2, `images` rows, typed placeholder on miss | [07-images.md](07-images.md) |
| 8 | API surface | Three endpoints; `/api/object` degrades to `profile: null` | [08-api.md](08-api.md) |
| 9 | `/objects/` route + route sync | Index + detail pages, crawlable shell, all six sync points updated | [09-route.md](09-route.md) |
| 10 | `/spacetrack/` inline panel | Flow 2, mobile-verified at all five viewports | [10-panel.md](10-panel.md) |

Tasks 2, 3 and 4 are independent of each other and each depends only on Task 1. Tasks 5–7
are sequential. Task 8 depends on 5. Tasks 9 and 10 both depend on 8 and are independent of
each other.

---

## Interface Summary

Every cross-task signature. A task's implementer sees only their own task file — this table
is how they learn the names and types their neighbours use. **Do not restate these in task
files; do not diverge from them.**

### `workers/orbit-profiles/src/sources.js` (Task 2)

```js
/** @type {Record<string, {id, name, url, license, attribution_text, priority}>} */
export const SOURCES;
/** @throws {Error} when sourceId is not in SOURCES */
export function assertAllowed(sourceId);
/** @returns {boolean} */
export function isAllowed(sourceId);
/** Upserts every SOURCES row into the `sources` table. @returns {Promise<number>} */
export async function seedSources(db);
```

`SOURCES` keys, exactly: `'nssdca'`, `'gcat'`, `'spacetrack-satcat'`, `'nasa-imagery'`.
Priorities: `nssdca` 100, `gcat` 90, `spacetrack-satcat` 80, `nasa-imagery` 50.

### `workers/orbit-profiles/src/validate.js` (Task 3)

```js
/**
 * @param {string} prose
 * @param {Record<string, any>} facts   the verified Tier 1 facts the prose was generated from
 * @returns {{ok: boolean, rejected: string[], reason: string|null}}
 *   `rejected` holds each offending sentence verbatim; `reason` names the first
 *   unsupported numeral. ok === true iff rejected.length === 0.
 */
export function validateProse(prose, facts);

/** Every numeral in `text`, normalised (commas stripped, trailing zeros trimmed). @returns {string[]} */
export function extractNumerals(text);

/** Every numeral appearing anywhere in `facts`, normalised the same way. @returns {Set<string>} */
export function factNumerals(facts);
```

### `workers/orbit-profiles/src/match.js` (Task 4)

```js
/**
 * Canonical COSPAR form: `1998-067A`. Accepts `1998-067A`, `98067A`, `1998-067  A`.
 * @returns {string|null} null when the input is not a COSPAR designator
 */
export function normalizeCospar(raw);

/**
 * @param {Array<{NORAD_CAT_ID: number, OBJECT_ID: string}>} catalogRows
 * @param {Array<{cospar: string, [k: string]: any}>} sourceRows
 * @returns {{matched: Map<number, object>, unmatchedNorad: number[], unmatchedSource: object[]}}
 */
export function matchByCospar(catalogRows, sourceRows);
```

### `workers/orbit-profiles/src/facts.js` (Task 5)

```js
/** @typedef {{value: any, source_id: string, source_url: string, confidence: number}} Fact */

/**
 * Higher `sources.priority` wins; ties broken by source_id ascending for determinism.
 * Conflicts are returned, never silently dropped.
 * @param {Record<string, Fact[]>} candidatesByField
 * @returns {{fields: Record<string, Fact>, conflicts: Array<{field, kept, dropped}>}}
 */
export function resolveConflicts(candidatesByField);

/**
 * Writes one `profiles` row + one `profile_fields` row per populated field.
 * Calls assertAllowed() on every fact before writing — this is the enforcement point.
 * @returns {Promise<{profiles: number, fields: number}>}
 */
export async function writeFacts(db, norad, resolved, spine);
```

`spine` is the `profiles` column set: `{cospar, official_name, mission_summary,
operator_name, owner_country, bus, manufacturer, launch_mass_kg, power_w,
design_life_years, mission_type, status}`.

### `workers/orbit-profiles/src/prose-tier2.js` (Task 5)

```js
/**
 * Deterministic, no model call, no network. Same input always yields the same string.
 * @param {object} row  a catalogue row: OBJECT_NAME, OBJECT_TYPE, OBJECT_ID, LAUNCH_DATE,
 *                      INCLINATION, APOAPSIS, PERIAPSIS, COUNTRY_CODE, regime
 * @returns {string} one or two sentences; never claims a mission for debris or a rocket body
 */
export function tier2Prose(row);
```

### `workers/orbit-profiles/src/prose-tier3.js` (Task 6)

```js
/**
 * @param {object} ai        the ai-node.mjs client interface: `run(model, input) => {response}`
 * @param {string} model
 * @param {Record<string, any>} facts
 * @param {string} fallback  the Tier 2 string used when validation rejects
 * @returns {Promise<{prose: string, tier: 2|3, rejected: string[]}>}
 *   tier === 2 whenever validation rejected or the call failed. Never throws on a 429.
 */
export async function tier3Prose(ai, model, facts, fallback);
```

### `workers/orbit-profiles/src/checkpoint.js` (Task 6)

```js
/** @returns {Promise<number>} last completed NORAD for `stage`, or 0 */
export async function readCheckpoint(db, stage);
/** @returns {Promise<void>} */
export async function writeCheckpoint(db, stage, norad);
```

`stage` is one of `'match'`, `'facts'`, `'prose'`, `'images'`.

### `workers/orbit-profiles/src/images.js` (Task 7)

```js
/**
 * @returns {Promise<{r2_key: string, thumb_key: string, width: number, height: number}|null>}
 *   null when the fetch fails or the source is not allowlisted — never throws.
 */
export async function ingestImage(env, norad, {url, credit, license, source_id});
```

R2 key shape: `profiles/<norad>/primary.webp` and `profiles/<norad>/thumb.webp`.

### `functions/api/_profiles.js` (Task 8)

```js
/** @returns {Response|null} 503 when PROFILE_DB is unbound — callers that REQUIRE it use this */
export function requireProfileDb(env);

/**
 * The composable read. Never throws, never 500s.
 * @returns {Promise<object|null>} null when PROFILE_DB is unbound OR the row is missing
 */
export async function profileFor(env, norad);
```

### Response shapes (Task 8)

`GET /api/profile/<norad>` → `{citation, profile, fields, images}` where `fields` is
`Array<{field, source_id, source_url, confidence}>` and `images` is
`Array<{r2_key, thumb_key, credit, license, source_url, is_primary}>`.

`GET /api/objects?…` → `{citation, total, limit, offset, operator_derived: true, results}`
— the same envelope `search.js` returns, so the frontend patterns transfer.

`GET /api/object/<norad>` → its existing body **plus** a `profile` key, `null` when absent.
Nothing else about that response changes.

### `public/shared/profile-panel.js` (Task 10)

```js
/**
 * @param {{mount: HTMLElement, getApiBase: () => string}} opts
 * @returns {{show: (norad: number) => Promise<void>, hide: () => void}}
 */
export function createProfilePanel(opts);
```

---

## Testing

Per the spec, plus the repo's own gates:

- **Numeral validator** — written first (Task 3), watched red on a real fabricated-number
  case before the generator exists.
- **Source allowlist** — a test asserting a non-allowlisted `source_id` is rejected.
- **COSPAR matching** — a fixture covering the "ISS (NAUKA)" / "ISS DEB" name trap.
- **`npm test` stays offline** — fixtures only, matching `workers/orbit-ingest/fixtures/`.
- **`tests/e2e/`** for the new route's behaviour; mobile viewports per
  `test_mobile_responsive.py`.

New test files live in `workers/orbit-profiles/test/` and follow the existing suite's
conventions: plain `node --no-warnings test/x.test.mjs`, hand-rolled assertions, fakes from
a local `test/fakes.mjs` modelled on `workers/orbit-ingest/test/fakes.mjs`.

---

## Deferred (do not build)

Named here so no task silently pulls them in:

- **Tier 4 enrichment** — the human-triggered web-search pass for notable thin-Tier-1
  objects. A later phase; v1 proves the spine first.
- **ESA eoPortal / SatNOGS ingestion** — share-alike segregation is not worth the
  complexity in v1.
- **CZML export** of a selected object.
- **A chatbot or any conversational layer** — explicitly rejected in the spec.
