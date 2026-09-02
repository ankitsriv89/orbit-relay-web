# Object Profiles — design

**Date:** 2026-09-02
**Status:** approved design, not yet planned
**Scope:** a descriptive knowledge base for every catalogued object, browsable as
an encyclopedia and as an inline panel on `/spacetrack/`.

---

## Goal

Today the site answers *where is this object*. It cannot answer *what is it*.
This adds the second half: mission purpose, operator, bus, instruments, mass,
status — one profile per catalogued object, ~28k of them, each carrying the
source and licence of every fact in it.

The comparable products each hold one half. Gunter's Space Page has the
descriptions and no live data, no API, no debris coverage. The tracking sites
(N2YO, Heavens-Above, CelesTrak) have live orbits and no real descriptions.
Nothing combines full-catalogue coverage, verified descriptive profiles, a live
per-object timeline, and a queryable API. That intersection is the product.

**Explicitly not in scope: a chatbot.** Assessed and rejected — a conversational
layer dissolves the fact/prose boundary this design is built to enforce, and
would invent missions for the ~25k debris objects that have none. Descriptive
retrieval only.

---

## Two consumption flows, one database

**Flow 1 — the encyclopedia.** A new `/objects/` route. Index page filters and
orders by country, launch year, type, operator, status. Each object has a detail
page at `/objects/<norad>/`. This is the SEO surface.

**Flow 2 — the inline brief.** On the existing `/spacetrack/` catalogue page,
selecting an object opens a summary panel in a second viewport: condensed
profile, thumbnail, key facts, link out to Flow 1.

One database, one API, two presentations. The panel is the profile minus the
long-form sections; it is not a second data path.

---

## What already exists and must not be duplicated

Read these before writing anything:

- `functions/api/object/[norad].js` — already returns a dossier joining
  `objects` (GP elset), `satcat`, and `decay`. It also already reads an
  **`events` table keyed by NORAD (`ts, kind, title, detail`)**. That table *is*
  the per-object timeline; it is populated daily by the existing ingest. Flow 1's
  timeline requirement is largely already met — this design consumes it, it does
  not rebuild it.
- `functions/api/search.js` — already does faceted filtering across type ·
  country · regime · era · operator, each with an index behind it. The
  encyclopedia index extends this pattern rather than reinventing it.
- `functions/api/_catalog.js` — `json`, `withCitation`, `cached`, `requireDb`,
  `safeParse`. All new endpoints use these; `withCitation` carries the legally
  required `X-Data-Source`.
- `workers/orbit-ingest/` — the **only** writer to `orbit-catalog`. Pages
  Functions are read-only. That separation is load-bearing and this design
  preserves it.

---

## Architecture

### Storage: a second D1 database

`orbit-profiles`, bound as `PROFILE_DB`. Read-side binding on the Pages project,
write-side on a new Worker.

Separate from `orbit-catalog` because the orbital read budget was hard-won over
two sessions of query folding, and profile queries (text search, faceted filters
over 28k rows) are a different and heavier access pattern. Isolating them means
a profile query regression cannot degrade the globe.

Cross-database joins are not possible in D1. The API layer composes instead:
`/api/object/<norad>` gains a `profile` key fetched in its existing
`Promise.all`. **If `PROFILE_DB` is unbound or the row is missing, the key is
`null` and the endpoint behaves exactly as it does today.**

### Ingest: a new Worker, not the existing one

`workers/orbit-profiles/`. Not folded into `orbit-ingest`, which runs on a
6-hourly Space-Track cadence against a rate budget whose ceiling is account
suspension. Separate Workers keep the failure domains apart: a stuck enrichment
run cannot delay a GP delta.

The **bulk import runs as a GitHub Actions job**, not a cron Worker — a 28k-object
pass exceeds Worker CPU limits.

---

## Schema

### `sources` — the licence allowlist

`id`, `name`, `url`, `license`, `attribution_text`, `priority`, `retrieved_at`.

**Ingest refuses to write any field whose `source_id` is absent from this
table.** This is the enforcement mechanism, not a policy note: a source that has
not been licence-reviewed cannot physically enter the database.

v1 rows only: NSSDCA, GCAT, Space-Track SATCAT, NASA/USGS/NOAA imagery.

### `profiles` — the structured spine

One row per NORAD: `norad`, `cospar`, `official_name`, `mission_summary`,
`operator_name`, `owner_country`, `bus`, `manufacturer`, `launch_mass_kg`,
`power_w`, `design_life_years`, `mission_type`, `status`, `prose`, `prose_tier`,
`updated_at`.

### `profile_fields` — provenance sidecar

`norad`, `field`, `source_id`, `source_url`, `confidence`. One row per populated
field. This is what lets the UI render *launch mass: 6,161 kg (NSSDCA)* and what
makes the database auditable. A sidecar rather than inline columns because 15
fields would otherwise mean 15 extra provenance columns.

### `images`

`norad`, `r2_key`, `thumb_key`, `width`, `height`, `credit`, `license`,
`source_url`, `is_primary`. R2 holds a compressed WebP plus a thumbnail.

---

## Licensing — the constraint that shapes source selection

The governing fact: **facts are not copyrightable (*Feist v. Rural Telephone*,
1991), but a selection and arrangement of facts can be.** Extracting atomic
fields into our own schema and generating our own prose is sound. Ingesting
another site's curated structure and descriptive text is not.

**Use — public domain or CC-BY only:**

| Source | Licence | Notes |
|---|---|---|
| NASA NSSDCA | Public domain (17 U.S.C. §105) | Best descriptive source. Keyed by COSPAR. |
| NASA / USGS / NOAA imagery | Public domain | NASA *logo/insignia* protected separately — not an issue for satellite imagery. |
| Space-Track SATCAT | Already licensed, citation already carried | Backbone of Tier 2 prose. |
| GCAT (McDowell) | CC-BY | Best structured launch history in existence. Attribution is an `<a>` tag. |
| CelesTrak | Free with attribution | |

**Exclude — share-alike would infect our output:**

- **ESA eoPortal** (CC BY-SA 3.0 IGO) — a few hundred EO missions, not worth the
  licensing complexity in v1.
- **SatNOGS DB** (CC BY-SA) — cubesat transmitter data, defer for the same reason.
- **Wikipedia** (CC BY-SA) — same.

**Exclude — no licence at all:**

- **Gunter's Space Page** — no stated licence, all rights reserved by default.
  Systematically ingesting it into a competing product infringes the compilation,
  and it is one person's life's work. **Hard exclude.** "I only took the facts" is
  a defence we should not need to make.
- **Commercial operator sites** (Maxar, Planet, SpaceX) — all rights reserved;
  press-kit images are editorial-use licensed, which this database is not.

NSSDCA + GCAT + SATCAT + NASA imagery yields a fully-licensed v1 with no
share-alike exposure and no scraping of anyone's hand-built site.

---

## Prose tiers

The discipline: **authoritative databases supply facts; the model only connects
them.** The model never sources a number.

**Tier 1 — structured facts.** From the allowlisted sources. Every field carries
`source_id` + `source_url`. This is what the API returns as authoritative.

**Tier 2 — templated prose (~25k objects).** Deterministic, no model call:
*"SL-4 rocket body from the 2019-047 launch, in a 71.0° orbit at 340 × 355 km."*
Derived from SATCAT fields already held. Zero hallucination surface, zero cost.
This covers every debris object and rocket body — the objects that have no
mission and must never be described as having one.

**Tier 3 — generated prose (~3k objects).** Groq `openai/gpt-oss-20b`, prose only,
from verified Tier 1 facts. Constrained rewriting, not open-ended generation, so
the 20B is expected to suffice; the model is a config value and gets validated on
a sample before commitment.

**The validator is mandatory, not optional.** Modelled on `checkNarrative()`:
**reject any sentence containing a numeral absent from the input facts**,
including a correct derived one — from the output alone, a correct derivation is
indistinguishable from an invention. A rejected sentence falls back to Tier 2.
Smaller models drift numbers more readily, which makes this load-bearing rather
than defensive.

**Write the validator first and watch it go red on a real fabricated number
before the generator exists.**

---

## Ingest pipeline

Four stages, each independently restartable, each checkpointed by last-completed
NORAD.

1. **Match** — join NSSDCA and GCAT to the catalogue on **COSPAR ID
   (`OBJECT_ID`), never on name.** Names change; "ISS (NAUKA)" and "ISS DEB" both
   substring-match — the trap already documented in `object/[norad].js:11-13`.
   Unmatched objects fall to Tier 2.
2. **Facts** — write `profiles` + `profile_fields`. Source allowlist enforced here.
3. **Prose** — Tier 2 templating for everything; Tier 3 only where Tier 1 is
   substantive.
4. **Images** — fetch, compress to WebP, write R2 + `images`.

**Resumability is a requirement.** A run that dies at object 14,000 restarts at
14,000. Groq rate-limiting mid-pass is expected behaviour, not failure: a 429 is
backoff-and-continue. GitHub caps a single job at 6 hours, which is the real
reason to chunk — not cost (see Budget).

**After v1: only new launches are profiled.** A small daily delta hooked to the
existing SATCAT ingest — new NORAD IDs get Tier 2 immediately and queue for
Tier 3. **No new scheduled workflow**; it piggybacks the existing daily run.
The orbital timeline needs no new work at all — `events` already updates daily.

---

## API surface

- `GET /api/profile/<norad>` — profile alone, for the `/spacetrack/` panel.
- `GET /api/objects?country=US&year=1998&type=PAYLOAD&sort=…` — encyclopedia
  index; extends the `search.js` facet pattern.
- `GET /api/object/<norad>` — gains a `profile` key, `null` when absent.

### Detail-page rendering

A Pages Function serves `/objects/<norad>/` as a static shell with
server-injected `<title>`, meta description, and JSON-LD; the body client-renders
from the API. This is the only option that is crawlable without abandoning the
no-build-step rule — and JSON-LD across 28k objects is the realistic route to
out-ranking the incumbents.

`Cache-Control` on the shell so the edge absorbs repeat crawls rather than
invoking the Function per hit.

---

## Error handling

| Condition | Behaviour |
|---|---|
| `PROFILE_DB` unbound or row missing | `profile: null`; endpoint behaves as today. Never a 500. |
| No image for an object | Typed placeholder, visibly a placeholder. Never a broken `<img>`, never a generated pseudo-photograph. |
| Validator rejects Tier 3 prose | Silently downgrade to Tier 2, log. Never publish unvalidated prose. |
| Two sources disagree on a fact | Higher `sources.priority` wins; conflict logged. Deterministic, not last-write. |
| Groq 429 / outage | Backoff and continue; object stays Tier 2 and requeues. |

---

## Budget — measured 2026-09-02

### GitHub Actions: not a constraint

Minutes are billed **per account**. `orbit-relay-web` is owned by `ankitsriv89`
and is **PUBLIC** — Actions on public repos is unlimited and free on standard
runners.

Measured over 30 days on that account:

| Repo | Visibility | Runs | Minutes | Billed |
|---|---|---|---|---|
| `orbit-relay-web` | PUBLIC | 199 | 705 | No |
| `mrspn` | PRIVATE | 18 | 217 | Yes |

(`ankesrtw` is a separate account with a separate allowance; `ckarm`, ~8 min/mo.)

Only ~217 of 2,000 free minutes are consumed. The bulk import's estimated
3–6 hours is not a budget concern.

**Caveat to re-check if it ever changes:** this depends on `orbit-relay-web`
staying public. Made private, its 705 min/month becomes billable and, with
`mrspn`, would consume ~46% of the free tier.

### Cloudflare ($5 Workers Paid)

- **D1** — 25B row reads/mo. A 28k-row profile DB with indexed filters is noise
  against that. Storage ~110 MB against 5 GB. **This is the one part of the
  system that does not need read-cost optimisation** — a genuine inversion of the
  orbital work.
- **R2** — ~2k images × ~135 KB ≈ 270 MB against 10 GB. Egress free, which is why
  R2 is correct here. 10M Class B reads/mo covers ~300k pageviews at 2 fetches
  each, and edge caching means most never reach R2.
- **Functions** — 10M requests/mo. The `/objects/<norad>/` shell is the one path
  that invokes per hit; edge caching plus `robots.txt` crawl-delay keeps even
  500k pageviews at ~5% of allowance.

### Groq

Tier 3 at ~3k objects: ~400 input tokens (verified facts + short system prompt),
~150 output. At `gpt-oss-20b` pay-as-you-go rates, **~$0.10–0.30 for the entire
bulk pass**, pennies per month after.

Cost is not the reason to keep Tier 3 narrow. **Hallucination surface and review
burden are.**

---

## Testing

- Numeral validator: written first, watched red on a real fabricated-number case.
- Source allowlist: a test asserting a non-allowlisted `source_id` is rejected.
- COSPAR matching: a fixture covering the "ISS (NAUKA)" / "ISS DEB" name trap.
- `npm test` stays offline — ingest tests use fixtures, matching
  `workers/orbit-ingest/fixtures/`.
- `tests/e2e/` for the new route's behaviour; mobile viewports per
  `test_mobile_responsive.py`.

---

## Route-sync obligations

`/objects/` is a whole new route, so the same session that adds it must update:
`AGENTS.md` route table, `public/index.html` `.app-grid` + footer nav,
`public/wiki/index.html` `#apps`, and `_redirects` + `_headers`.

---

## Housekeeping noted during design

- `media-mirror/` and `media-manifest.txt` no longer exist — leftovers from the
  playground split. Stale references remain in `.gitignore:17-18`,
  `AGENTS.md:27`, `CLAUDE.md:160`. Trivial cleanup, unrelated to this work.
- **Two `orbit-ingest` failures on 2026-09-01**, uninvestigated. Out of scope
  here, but the daily profile delta will hang off that job — worth understanding
  before adding a dependent subsystem.

---

## Deferred

- **Tier 4 enrichment** — a narrowly-scoped, human-triggered web-search pass for
  the few hundred notable objects where Tier 1 is thin. Output stored in a
  separate column, styled visibly differently, never mixed into authoritative
  fields. Specified as a later phase so v1 proves the spine first.
- ESA eoPortal and SatNOGS ingestion, if share-alike segregation is ever worth
  the complexity.
- CZML export of a selected object (already noted as reasonable in `CLAUDE.md`).
