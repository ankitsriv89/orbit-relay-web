# Changelog

All notable changes to the Orbital Relay web project. Format: entry per commit batch,
newest first. Full per-session detail in [docs/build-logs/](docs/build-logs/).

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
