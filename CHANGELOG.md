# Changelog

All notable changes to the Orbital Relay web project. Format: entry per commit batch,
newest first. Full per-session detail in [docs/build-logs/](docs/build-logs/).

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
