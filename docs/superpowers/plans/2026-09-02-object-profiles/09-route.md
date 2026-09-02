# Task 9: The `/objects/` route and route sync

**Depends on:** Task 8 (all three endpoints).

**Deliverable:** a browsable encyclopedia at `/objects/` with crawlable per-object detail
pages, mobile-verified, with every one of the six route-sync obligations discharged **in
this same session**.

**Files:**
- Create: `public/objects/{index.html,objects.js,object.js,objects.css}`,
  `functions/objects/[norad]/index.js`
- Create: `tests/e2e/test_objects.py`
- Modify: `public/index.html`, `public/wiki/index.html`, `public/_redirects`,
  `public/_headers`, `public/sitemap.xml`, `AGENTS.md`

**Interfaces:**
- Consumes: `/api/objects` and `/api/profile/<norad>` (Task 8).
- Produces: the route itself. Task 10 links into `/objects/<norad>/`.

---

## Route sync is part of this task, not a follow-up

`/` and `/wiki/` assert "this is the full list of what exists", so per `CLAUDE.md` the
session that adds a whole route updates, in the same session:

1. the route table in `AGENTS.md`
2. `public/index.html`'s `.app-grid`
3. `public/index.html`'s footer nav
4. `public/wiki/index.html`'s `#apps`
5. `public/_redirects` — the extensionless → directory form, matching the existing entries
6. `public/_headers` — a cache rule for the path

Add `public/sitemap.xml` too: JSON-LD across 28k objects is the realistic route to
out-ranking the incumbents, and a sitemap the crawler can find is half of that.

**`_headers` note:** `/objects/*` is hand-edited HTML and un-hashed ES modules, so it
follows the `no-cache, must-revalidate` pattern the other app routes use — *not*
`immutable`, and not the `stale-while-revalidate` reserved for CSS. The rationale is
already written out at the top of `_headers`; match it. The detail-page **shell** is the
one path that invokes a Function per hit, so its `Cache-Control` is what keeps repeat
crawls at the edge — set it deliberately and comment why.

## The crawlable shell

`functions/objects/[norad]/index.js` serves a static shell with server-injected `<title>`,
meta description and JSON-LD; the body client-renders from the API. Per the spec this is
the only option that is crawlable **without abandoning the no-build-step rule**.

Two hazards:

- **No `insertAdjacentHTML` with API-derived content** — a repo-wide prohibition. The
  injected values are object names from an upstream catalogue; escape them for the context
  they land in. JSON-LD goes in a `<script type="application/ld+json">` and needs its own
  escaping rules, not HTML escaping.
- A missing NORAD must render a real 404, not a shell with an empty title.

## Frontend constraints

- **Module specifiers are filesystem arithmetic against the importing file's directory.**
  `public/objects/` is depth 1, so anything shared is root-absolute (`/shared/…`,
  `/css/tokens.css`); intra-package imports are relative. `npm run check:resolve` enforces
  this — run it before you believe the page works.
- **A syntax error in an ES module executes zero statements of that module.** The page can
  render and be entirely dead. `npm run check:syntax` catches this; loading the route with
  a clean console is the confirmation.
- `public/css/tokens.css` holds the shared colour/font tokens — use them rather than
  redeclaring. This route has no globe, so it does not inherit the `orbit.css` link-order
  constraint that binds the spacetrack pages.
- Reuse the shared chrome in `public/css/chrome.css` for nav/hamburger/drawer.

## Mobile is a requirement

Verify at 390×844, 412×915, 820×1180, 1133×744, 1400×900 — the table in
`tests/e2e/test_mobile_responsive.py`. Specifically:

- `<meta name="viewport" content="…, viewport-fit=cover">` on both new pages.
- **No horizontal page scroll at any viewport.** The index is a filter table over 28k rows,
  which is exactly the content that causes it — wide content scrolls in its own
  `overflow-x: auto` container.
- Touch targets ≥ 44px, filter chips included.
- Any new animation respects `prefers-reduced-motion` — the repo has no handling yet, so
  whatever you add is where it starts.

## Steps

- [ ] **Step 1: Write `tests/e2e/test_objects.py` first**, following the conventions in
      `.claude/rules/testing-e2e.md` and the existing suites. Cache-bust every page load
      with `?cb=<timestamp>` — a stale cached module has produced a byte-identical
      measurement after a real code change before. Pin:

  - `/objects/` renders rows and the console is clean.
  - A filter narrows the result count.
  - `/objects/25544/` has a non-empty `<title>` naming the object, a meta description, and
    a JSON-LD block that parses.
  - No horizontal scroll at all five viewports.
  - A `profile: null` object still renders a usable page — the encyclopedia covers 28k
    objects and most have no Tier 1 facts.
  - An object with no image shows the typed placeholder, not a broken `<img>`.

- [ ] **Step 2: Run it.** Expect failure — the route does not exist.

- [ ] **Step 3: Build the index page** — `index.html`, `objects.js`, `objects.css`.
      Filters and ordering by country, launch year, type, operator, status.

- [ ] **Step 4: Build the detail page** — the shell Function plus `object.js`.

- [ ] **Step 5: Verify locally.**

```bash
npm test                      # syntax + resolve must be green before anything else
npm run dev
```

Load `/objects/` and `/objects/25544/`. **Console clean.** Then check 390px in devtools
before running the suite.

- [ ] **Step 6: Run the e2e suite.** Expect PASS at all five viewports.

- [ ] **Step 7: Discharge all six route-sync points plus the sitemap.** Do it while you are
      already touring the routes under `npm run dev`. Re-run `npm test` afterwards —
      `check:resolve` validates the new nav links actually resolve.

- [ ] **Step 8: Commit, push, confirm the deploy.**

```bash
git commit -m "feat(objects): /objects/ encyclopedia with crawlable per-object shells"
git push
gh api repos/ankitsriv89/orbit-relay-web/commits/$(git rev-parse HEAD)/check-runs \
  --jq '.check_runs[] | "\(.name): \(.conclusion)"'
```

Want `Cloudflare Pages: success`. `ci` green says nothing about the Pages build.

**Done when:** both pages load with a clean console, the e2e suite passes at all five
viewports, all six sync points plus the sitemap are updated, and the Pages deploy is
confirmed shipped.
