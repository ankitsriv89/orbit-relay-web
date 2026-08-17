# Changelog

All notable changes to the Orbital Relay web project. Format: entry per commit batch,
newest first. Full per-session detail in [docs/build-logs/](docs/build-logs/).

## 2026-08-17 — Plane-rings toggle on `/constellations/`, site-wide feedback widget

### Added
- **Plane-rings toggle on `/constellations/`.** The page draws one glowing
  orbital-plane ring per plane (`buildRings()`); at Starlink/OneWeb shell
  density that's dozens of overlapping ellipses forming a dense lattice
  sphere around the globe — reported as looking like a rendering bug, but
  it's the intended "show orbital plane structure" feature. Added a
  "PLANE RINGS" ON/OFF toggle to the DENSITY HUD panel (matches the existing
  `st-toggle-btn` pattern used by `revs-toggle` and the overlay toggles on
  `/spacetrack/`), defaulting to ON. Rings are hidden via `.show` on each
  managed entity rather than rebuilt, so toggling is instant.
- **Site-wide feedback widget** (`public/shared/feedback.js`): a floating
  "FEEDBACK" tab, bottom-right, on all 10 public routes — mounted the same
  way as `/js/beacon.js` (one `<script type="module">` tag per page, zero
  page-specific wiring, self-injects its own styles so it needs no
  `tokens.css` link). Lets a visitor report a bug, suggestion, or general
  feedback with an optional reply email, without leaving the page or using
  email.
  - `POST /api/feedback` (`functions/api/feedback.js`) — public, no auth,
    same low-PII pattern as `/api/hit`: captures `path` and a bucketed
    `ua_class` (mobile/tablet/desktop/bot), never the raw User-Agent. Shares
    `/api/hit`'s dedicated write rate-limit bucket in `_ratelimit.js` so a
    feedback spammer can't also exhaust the read budget for real API
    callers.
  - New `feedback` D1 table (`d1/orbit.sql`) — `kind`, `message`, optional
    `email`, `path`, `ua_class`, `reviewed`.
  - New **FEEDBACK** admin panel (`public/admin/panels/feedback.js` +
    `functions/api/admin/feedback.js`) — lists submissions newest-first with
    a per-item MARK REVIEWED/UNREVIEWED toggle; the sidebar dot badges the
    unreviewed count, same `badge()` contract as the runs panel.

### Verification
- `npm test` green: 82/82 syntax, all references resolve (67 files, up from
  65), full orbit-ingest suite passing.
- Rings toggle: Playwright confirmed all ring entities flip `.show` on
  click with no console errors and no horizontal overflow at 390px.
- Feedback widget: Playwright end-to-end — submitted from `/starlink/`
  (which redirects to `/constellations/?c=starlink`), confirmed the row
  landed in local D1 with the correct `kind`/`message`/`email`/`path`/
  `ua_class`, then confirmed the admin FEEDBACK panel lists it and the
  MARK REVIEWED toggle flips `reviewed` correctly.
- Local D1 needed `wrangler d1 execute orbit-catalog --local --file
  d1/orbit.sql` re-run to pick up the new table — idempotent
  (`CREATE TABLE IF NOT EXISTS`), safe against the existing schema. Anyone
  else running this locally needs the same before the feedback endpoint
  will persist (it fails quiet, same contract as `/api/hit`, so a missing
  table doesn't surface as an error to the visitor).

## 2026-08-17 — Plan 34 Phase 3.4 batch close: two real mobile bugs found by GPU-rendered visual inspection

**Docs-only commit (this session), plus a CSS fix in `public/spacetrack/spacetrack.css`.**

Plan 34 3.4's features (C1 SWPC ingest, C2 aurora ovals + SPACE WX HUD, C3
ground stations + live link) had already landed in prior sessions. This
session is the batch-close verification pass, run on the Windows dev box with
GPU-accelerated headless Chromium (D3D11 ANGLE) instead of the old
SwiftShader-only sandbox.

### Fixed
- **Mobile scroll was dead on `/spacetrack/brief/` and `/spacetrack/analytics/`.**
  An unscoped `body { overflow: hidden }` in `spacetrack.css`'s mobile media
  query — written for the globe pages, which have nothing to scroll — leaked
  onto these two plain scrolling-document pages because they link the same
  stylesheet for shared HUD/nav styling. Scoped the rule to the two globe
  pages by `data-page-id`.
- **The RESULTS panel and the screenshot button occupied the same corner**
  on `/spacetrack/` mobile (both `bottom: 130px, right: 8px`), truncating
  "// RESULTS" behind the camera icon. Moved the results panel above the
  button's height plus a gap.

### Verification
- `npm test` green: 74/74 syntax, all references resolve, 21 orbit-ingest
  suites, no FAIL lines.
- `test_mobile_responsive.py` 125/136, `test_mobile_dom.py` 27/29 — the same
  13 pre-existing failures logged in the 3.2 and 3.3 batteries, none from
  this session's changes.
- **Both fixes were invisible to the DOM/geometry suites** — found instead by
  a GPU-rendered headless screenshot probe (real Chromium D3D11 rendering,
  not SwiftShader) across every route at 390×844, at the user's request after
  they noticed the same symptoms in real use. Confirmed with a wheel-scroll
  probe (`scrollY` 0→0 before the fix, 0→26 / 0→243 after) and a
  `getBoundingClientRect()` probe on the HUD panels.

### Not built / follow-ups
- Plan 34 3.4 is now **fully closed** (C1–C4 done).
- Only plan 38 task 9 remains open across tracked plans per `CLAUDE.md`'s
  status snapshot.

## 2026-08-06 — Plan 34 Phase 3.3: cinematic pass (spec #20)

**Commits `b276191a` (C1 shadow math), `b0e545ab` (C2 toggle + eclipse), `04554f20` (C3 bloom), `f6c858ba` (C4 skyBox), C5 docs close**

### Added
- **Cinematic quality toggle** (`quality.cinematics` state key, persisted):
  'high' | 'low', first-boot default 'low' on mobile / 'high' on desktop.
  /orbit/ owns the HUD control (desktop + mobile drawer, kept in sync);
  /spacetrack/ follows the saved key; /starlink/ + /constellations/ keep the
  engine default. This is the repo's first quality/reduced-motion gate — it
  handles all new effects in one place.
- **Eclipse shading** (`public/orbit-engine/astro.js`): pure
  `eclipseShadowFactor(p, sun, {earthR})` — cylinder umbra/penumbra model
  with a graded smoothstep penumbra (`band = L·tan θ_sun`, ~195 km at GEO
  depth), plus `sunDirectionEcef(date)` (Meeus/NOAA, ~0.01°). Satellites in
  Earth's shadow darken in 'high' (alpha = fade × eclipse factor, one sun
  computation per drawn frame), unit-tested with closed-form geometry.
- **Bloom post-process** (`scene.postProcessStages.bloom`), enabled in 'high'
  — applied at engine construction so the no-toggle pages inherit it;
  guarded at every level (WebGL2 + lazy getter). Uniforms at Cesium defaults
  pending real-renderer tuning.
- **Procedural star skyBox** (`public/orbit-engine/starfield.js`): a
  deterministic 3D star field (seeded PRNG, ~78 KB of PNG data URLs, zero
  external assets) replacing Cesium's default starfield — which 1.113 would
  otherwise lazily fetch as six JPEGs from the Cesium CDN on every page's
  first render. Assigned at construction in both levels, so **no page ever
  fetches the CDN starfield**; 'low' shows a plain black background.

### Verification
- `npm test` green throughout: 73/73 syntax, 63 files resolve, 21 suites
  (~568 checks) at batch close — two new suites (eclipse 14, starfield 20).
- Three custom Playwright probes at 1400×900 + 390×844: C2 26/26, C3 28/28,
  C4 **42/42** — toggle/DOM state, engine flag, sun-plumbing (sat parked at
  the true sun's antipode: alpha 1.0 vs 0.000), bloom stage under
  SwiftShader WebGL2, procedural skyBox shown/hidden per level on all six
  pages, zero `tycho2t3` requests anywhere, zero console/page errors.
- **C5 batch-close battery**: `npm test` green; C4 probe re-run **42/42**
  (doubles as the regression probe); `test_mobile_responsive.py` 125/136 and
  `test_mobile_dom.py` 27/29 — the 13 failures are all **known pre-existing**
  (batch touched only `public/orbit-engine/`; `git diff 61a44192..HEAD` on
  orbit/spacetrack/e2e is empty): stale `/orbit/` `>=3` HUD threshold (2 by
  design), stale resolutionScale allowlist (`0.85` deliberate), mobile
  citation surface gap (by design, open task), stale `/spacetrack/` HUD
  count in the dom suite (5→3 since `25ab2721`).

### Not built / follow-ups
- **Not pushed**: 16 commits ahead of origin at close (user request; deploy is
  automatic on push — push when ready).
- Bloom/skyBox visual tuning with a real renderer (dev sandbox canvas is
  black — Cesium Ion 403); 'low' = black background is a product call, a
  sparse-stars-at-low mode would be a new decision.
- Stale mobile-suite expectations and the mobile citation surface gap are
  logged in `docs/issues-and-resolutions.md` for the next bug-fixing session.
- Plan 34 3.4 (space weather / ground stations) is a separate phase.

---

## 2026-08-05 — Plan 34 Phase 3.2: constellation / orbital-plane view (spec #7)

**Commits `6b0d271a` (C1 compute), `3fc91871` (C2 page), `3e6d5600` (C3 redirect), C4 docs close**

### Added
- **New page `/constellations/`** — group Starlink / OneWeb / GPS / Galileo / Iridium by
  orbital plane and render each plane as a great-circle glow ring, satellites as colored
  points on the shell they occupy. Pure client-side: TLEs via the existing `/api/tle`
  proxy, plane elements derived from `satrec` (`nodeo`/`inclo`/`no`).
- **Two-level plane grouping** (`groupConstellation`): inclination-band gap-split (1°)
  first, then RAAN gap-split (5°) per band — live Starlink needs both; a pure RAAN
  split merges the whole constellation into one plane.
- **Controls**: 5-button constellation selector bar (primary control, stays visible),
  stats HUD (LOADED/RENDERED/PLANES/AVG ALT/AVG PERIOD), planes HUD (click a row to
  fly to that plane's ring), density slider (max = full count from boot, no fetch-all
  button), sat-bar, time-warp 0/1/10/100/1000, inspector with GROUP/PLANE/NORAD rows.
- **`?c=` preset param** (default `starlink`); `window.__constellations` debug handle.
- **`public/constellations/compute.js`** — pure plane math (Kepler SMA/altitude,
  `planeElements`, circular-RAAN gap clustering anchored at the largest gap,
  `planeRingDeg`), unit-tested in Node (15 checks, closed-form answers).
- **`/starlink/` is now a preset**: all `/starlink` spellings 302 →
  `/constellations/?c=starlink`; the 13 existing nav links still work via the redirect.

### Changed
- `/starlink/` no longer served directly (302 to the preset); `public/starlink/` files
  are dead behind the redirect, kept pending a pure-deletion pass.

### Verification
- `npm test` green throughout: 72/72 syntax, 62 files resolve, 23/23 constellation
  checks (19 suites / 508 checks at batch close).
- Custom Playwright probe 57/57 at 1400×900 + 390×844 (boot, clearances, fly-to,
  inspector, warp, REV, mobile menu, touch targets, zero console errors).
- Redirect verified under `wrangler pages dev` (all three `/starlink` spellings 302).

### C4 batch close (verification battery, docs commit)
- Battery re-run at batch head: `npm test` green; **new constellation probe 38/38**
  (desktop 1400×900 + mobile 390×844: stats HUD ↔ plane rows, slider max = full
  count, clearances, warp/REV/clock/citation, oneweb switch, inspector live fields,
  mobile menu, touch targets ≥32px, orientation change, zero console errors);
  `/starlink/` redirects re-verified under `wrangler pages dev`.
- `test_mobile_responsive.py` 125/136 and `test_mobile_dom.py` 27/29 — the 13
  failures are all **known pre-existing** (batch touched nothing outside
  `public/constellations/` + `_redirects`; `git diff` on orbit/spacetrack/e2e vs
  the pre-batch commit is empty): stale `/orbit/` `>=3` HUD threshold (2 by
  design), stale resolutionScale allowlist (`0.85` deliberate), mobile citation
  surface gap (by design, open task), stale `/spacetrack/` HUD count in the dom
  suite (5→3 since `25ab2721` moved activity/boxscore to Brief — new finding,
  logged).

### Not built / follow-ups
- **Not pushed**: 7 commits ahead of origin at close (user request; deploy is
  automatic on push — push when ready).
- Delete dead `public/starlink/` files; plan 34 3.3 (cinematic) and 3.4 (space
  weather / ground stations) are separate phases.
- Stale mobile-suite expectations (`test_mobile_responsive.py` `/orbit/` HUD
  count + resolutionScale allowlist; `test_mobile_dom.py` `/spacetrack/` count)
  and the mobile citation surface gap are logged in
  `docs/issues-and-resolutions.md` for the next bug-fixing session.

---

## 2026-08-03 — Plan 38 batch 1: Brief & Analytics visualization fixes

**Commit `aea6fc1a`** — *feat(spacetrack): color-coded boxscore segments, analytics heatmap matrix, stale banners (plan 38)*

### Changed
- **Boxscore bars are colored again** (`public/spacetrack/brief/`): the boxscore API ships `SPADOC_CD` codes (`CIS`, `PRC`, `UK`, …) which the country palette does not know — every bar rendered default grey. New `BOX_CD` alias map + `colorForBoxCode()` in `public/theme/palette.js` translate at the boundary; pseudo-rows (`ALL`/`TBD`/`ORB`) are filtered/excluded from matching.
- **Stacked segments**: each bar now shows orbital count (country color) over decayed count (muted grey), with legend swatches and per-segment `title` counts.
- **Feed event kind chips** (new / decay / predict / change) with legend on the Brief signal feed; decay-watch shows how fresh the list is (`built … ago`).
- **Analytics heatmap matrix** (`public/spacetrack/analytics/`): country × decade table with `--heat`-ramped cells, `—` for zeros (a zero is not a value), per-row totals and a `TOT` grand total; container scrolls internally so the page never overflows at 390px.
- **Degraded-artifact honesty**: `stale: true` + `note` from the R2-backed endpoints now render a visible banner (`st-stale-note`); an empty matrix shows a "no data" hint instead of a blank table.
- **Site codes get names where known** (frontend stopgap): `AFETR→Cape Canaveral`, `AFWTR→Vandenberg`, `KSCAJ→Cape Kennedy`, `TTMTR→Baikonur`, `PKMTR→Plesetsk`; unknown codes stay raw with a `title`, so nothing lies.
- Analytics auto-refetches every 30 min; both pages keep the `window.__spacetrack` debug contract.

### Fixed
- Brief card showing a blank panel when the daily narrative artifact is absent — the API `note` is rendered instead.

### Not built (backend, plan 38 batch 2)
- `satcat.LAUNCH`-seeded site-name map (frontend `siteLabel` is the stopgap).
- Brief archive (no history today — nothing "newsworthy").
- Further analytics aggregations.

### Verification
- `npm test` green: syntax 67/67, resolve 57/57, orbit-ingest suites (incl. plan-34 gate test, 60/60).
- Headless Playwright 1400px + 390px: 24/26 — the 2 failures are the intentional mobile footer `display:none` (pre-existing design).

---

## Prior major milestones (summary)

- **Plan 34 Phase 3.1** (`25ab2721` and earlier, Jul 2026): activity/boxscore moved to Brief, Brief+Analytics cardified; engine span + past-orbit arcs + revs toggle (`ab974c23`, `1c8d4616`, `579df166`); st-dossier skin (`905d2f53`), LEO/MEO/GEO/HEO shell rings (`4d4055ac`), VFX overlay (`63fc6813`), layer registry (`b2b3b13d`), active/military backend groups (`4688fae6`); About & Wiki static pages (`e3d50c3e`).
- **SpaceTrack catalog page wave 2/3** (Jul 2026): `b9278623`-era build — country boxscore bars, debris-field rings, launch-site markers, age coloring, LOD, time-based presets, screenshot button (see `docs/build-logs/2026-07-31_build_log_01.md`).
- **Space-Track source live** (Jul 2026, `2d51d57`/`73e7681`): R2 bundles + D1 mirror via `orbit-ingest` Worker on GitHub Actions; shared `orbit-engine/` extraction (`e51378d`); real Pages Function API tests (`f2d845a`).
