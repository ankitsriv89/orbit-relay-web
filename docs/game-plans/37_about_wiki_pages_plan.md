# About + Wiki static pages

## Context

Plan 34's landing rebuild (Phase 1, done) gave `/` a real hero, live stats, and app cards
for all seven routes. What it did not add — because it wasn't scoped — is anywhere for a
visitor to read **about the project, its data sources, how it works, or its legal/privacy
terms**, and there is no in-product reference documenting what each app/route/filter/field
actually means. The footer currently links straight out to `space-track.org` and
`celestrak.org` and back to the six app views; there is no `/about/`, `/legal/`,
`/privacy/`, or `/wiki/` anywhere in `public/`.

This matters beyond polish: `operator_derived`, `debris_family`, `regime`, and the
conjunction screener's `⚠ UNOFFICIAL — NOT FOR COLLISION AVOIDANCE` framing are all
real caveats a visitor has no way to look up today except by reading source. CLAUDE.md's
citation requirement is satisfied API-side and in two page footers, but nothing explains
*why* it's there or what the Space-Track redistribution terms actually permit.

**Decisions already made** (asked and answered before this doc was written):
1. One combined `/about/` page — sections for About, Data Sources, How It Works, Privacy,
   Legal, anchor-linked — not five separate routes.
2. One combined `/wiki/` page — a single reference documenting each app/route, its
   filters, and the data terminology (glossary), not a multi-page docs tree.
3. This plan doc first, then implementation.

---

## What ships

Two new static routes, following the existing no-build-step, root-absolute-reference
pattern (`spacetrack/index.html` at depth 1 is the model: its own `.css`/`.js`, links back
to `/` via `<a href="/">`).

### `/about/` — `public/about/index.html` + `about.css`

Sections, in order, each `id`-anchored so the footer can deep-link
(`/about/#data-sources`):

1. **About** — what Orbital Relay is, the eight routes, one paragraph. Reuse language
   already drafted for the landing hero/app-cards rather than inventing new copy.
2. **Data sources** — Space-Track.org (USSPACECOM/18th SDS) and CelesTrak, what each
   provides (SATCAT/GP elsets vs. Celestrak GP), refresh cadence (ingest runs on the
   Actions schedule — link `/admin/` is not public, so state the cadence in prose, e.g.
   "TLE baselines refresh every 6 hours" matching `_headers`' `max-age=21600`). Full
   `CITATION` string from `functions/api/_orbit.js:17-19`, verbatim — do not paraphrase a
   licence condition.
3. **How it works** — plain-language: TLE/SGP4 propagation, what "derived" means for
   `operator`/`regime`/`debris_family` (link to the Wiki glossary entries), and the
   conjunction screener's `⚠ UNOFFICIAL — NOT FOR COLLISION AVOIDANCE` framing carried
   through verbatim, same as CLAUDE.md requires it survive a failed fetch elsewhere.
4. **Privacy** — what the beacon (`public/js/beacon.js` → `page_views` D1 table per plan
   36) actually collects. Read `functions/api/hit.js` (or wherever the beacon endpoint
   lands post admin-dashboard work) before writing this section — state only what is
   verified against the code, not assumed. No cookies/accounts exist anywhere in the
   public site (only `/admin/` has an HttpOnly session cookie, and that's operator-only) —
   say so plainly.
5. **Legal** — this is a hobby/demo project redistributing licensed government and
   third-party data, not a collision-avoidance authority; the conjunction screener
   disclaimer covers the sharpest liability edge, but this section is the general "no
   warranty, for informational purposes" statement. **Do not invent a jurisdiction,
   company name, or contact email that doesn't exist** — write this section in first
   person / project terms, and flag to the user in the implementation session if a real
   contact point or entity name is needed rather than guessing one.

### `/wiki/` — `public/wiki/index.html` + `wiki.css`

One page, two parts:

1. **App reference** — one subsection per route (`/orbit/`, `/spacetrack/`,
   `/spacetrack/signal/`, `/spacetrack/conjunctions/`, `/spacetrack/brief/`,
   `/spacetrack/analytics/`, `/starlink/`): what it shows, its filters (the 15
   checkboxes + regime shells from plan 34 §3.1), and what's unique about it (e.g.
   Conjunctions is derived screening not authoritative CDMs; Brief has no D1 fallback by
   design).
2. **Glossary** — the derived/terminology fields that have zero explanation anywhere
   today: `operator` (derived from `OBJECT_NAME`, not authoritative —
   `operator_derived: true` on every response), `regime` (LEO/MEO/HEO/GEO via
   `astro.js orbitRegime()`), `debris_family`, `apogee_km`/`perigee_km`, `RCS` (radar
   cross-section size class), COSPAR ID vs. NORAD ID, TLE/SGP4 in one sentence each,
   `revs` (multi-revolution trajectory display from plan 35), time-rate semantics
   (1×/10×/100×/1000×, sim-seconds-per-real-second). Keep each entry to 1-3 sentences —
   this is a glossary, not a tutorial.

Both app-reference and glossary content should be written by reading the actual current
UI/API (`AGENTS.md`, the `Orbital_Relay_Feature_Specification.md`, and the live filter
lists in `orbit/layers.js` / each page's HTML) rather than from memory of what plan 34
described — filters and routes have changed since that spec was written (e.g. plan 34
3.1 S11's layer registry, S9's regime shells).

### Footer + nav wiring

- `public/index.html`'s `site-footer__grid` gets a fourth column ("About") linking
  `/about/`, `/about/#data-sources`, `/about/#privacy`, `/about/#legal`, and `/wiki/`.
  Follow the existing `site-footer__col` markup pattern exactly (`<nav>` +
  `aria-labelledby` + `<h3 id>` + `<ul>`).
- Each of the 7 app pages' nav (`spacetrack-nav` / orbit's own nav) does **not** need
  About/Wiki links added — CLAUDE.md's "don't add a fourth copy of nav chrome" concern is
  about HUD/nav *code*, but adding two `<li>` entries to the existing shared nav markup
  (or footer, if the app pages have one) is in scope if it's a small, consistent addition.
  Confirm during implementation whether app pages have any footer at all before deciding
  where the link lives — don't invent chrome that isn't there.
- `/about` and `/wiki` extensionless → trailing-slash 301s added to `public/_redirects`,
  matching every existing route's pattern.
- `/about/*` and `/wiki/*` cache-control added to `_headers`, matching `/orbit/*`'s
  `max-age=86400` (static content, no personalization).

### Style

Both pages reuse `public/css/tokens.css` and the landing page's mono/terminal aesthetic
(`--font-mono`, existing color tokens) rather than inventing a new visual language —
these are prose-heavy pages, so lean toward a readable measure (max-width prose column,
matching typography density to what `landing.css` already establishes for the app-card
descriptions) rather than replicating the dense HUD chrome of the globe pages.

---

## Verification

1. `npm test` green (syntax + resolve checks will catch any bad root-absolute reference
   immediately — this is exactly the class of bug the resolve checker exists for).
2. Load `/about/` and `/wiki/` under `npm run dev`, confirm console clean, confirm every
   anchor link (`#data-sources` etc.) scrolls to the right section.
3. Mobile check at 390×844 minimum (CLAUDE.md's mobile section applies to every UI
   change, including prose pages — safe-area insets on any fixed chrome, no horizontal
   scroll, touch targets ≥44px on nav links).
4. Confirm the `CITATION` string on `/about/` is character-identical to
   `functions/api/_orbit.js:17-19` (copy-paste, don't retype).

## Open decision for the implementation session

**Legal/contact identity.** The Legal section needs *something* to ground it — even a
minimal "this is an independent project, not affiliated with USSPACECOM/Space-Track.org
or CelesTrak" disclaimer needs the user to confirm project ownership framing (personal
project vs. named entity) and whether any contact method should be published. Ask rather
than fabricate when that session starts.
