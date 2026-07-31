# 22 — Site Hub (3D Mars globe) + per-site saves + tiered reset

**Goal:** A first-scene **3D Mars globe** that shows the available landing sites at their
real coordinates; the player picks one and descends into it. Each site keeps its **own
local save** (independent progress + resume), with **per-site and whole-game reset**. This
front-runs Wave 2 — every future site becomes a new pin with no hub work.

**Decisions locked (2026-07-18):** (1) presentation = **3D rotatable Mars globe**, click a
pin → camera flies down into the existing landing-drop intro; (2) resume = **progress-level**
(archive/missions/photos/outposts/sol persist; re-land fresh each session); (3) return flow =
**auto-resume last site** (hub shown on first-ever boot + reachable from the menu, not a
forced gate every launch).

---

## ⚠ Dependency — this gates plan 21
Plan 21 adds `missions: ['tutorial','survey','photo']` to Gale — **identical mission ids to
Jezero**. Under today's **global** `mc-mission-<id>-done`, completing Jezero's tutorial would
also mark Gale's done. **The save-namespacing refactor (Part A below) must land before, or in
the same change as, plan 21 Part B (Gale sync).** Recommended global order: 22-A (saves) →
21-B (Gale features) → 22-B/C (hub + boot) → 21-A (Gale asset regen).

---

## Part A — Save-model refactor (the foundation; do first, invisible)

### Current state (verified)
All ~30 `mc-*` keys are **unnamespaced/global**. It only works today because Gale has no
missions. Enumerating the keys, the per-site vs global split is small and clean:

- **Per-site** → namespace `mc-<siteId>-*` (4 keys): `results` (science archive,
  analysis.js), `photos` (album, photos.js), `mission-<id>-done` (missions.js),
  `intro-seen` (landing, main.js).
- **Global** → stay global (correct as-is): every keybind remap (`mc-collect`, `mc-switch`,
  `mc-land`, `mc-tele`, `mc-menu`, `mc-hud`, `mc-dronectl`, `mc-night-vision`, `mc-photo`,
  `mc-van`, `mc-toggle-land`, `mc-cycle-gear`…), gear loadout (`mc-gear*`), and prefs
  (`mc-nv`, `mc-sfx`, `mc-overlay-mode`, `mc-touch-*`, **`mc-sol`** = daylight-lock toggle,
  NOT a clock — the mission sol is computed live from `landingUtc`), plus `mc-site` itself.

### Changes
1. **`saves.js` (new)** — one tiny module centralizing localStorage:
   - `Save(siteId)` → `.get/.set/.remove/.clear()` scoped to `mc-<siteId>-<k>`; `.clear()`
     removes every `mc-<siteId>-*` key (Reset Site).
   - `Prefs` → get/set for the global keys (passthrough, so keybinds/prefs are shared).
   - `resetGame()` → remove **all** `mc-*` keys (Reset Game).
2. **Route the per-site writers through `Save(site.id)`**: analysis.js (`results`),
   photos.js (`photos`), missions.js (`mission-*-done`), main.js (`intro-seen`), and the
   mission clock (`sol`). Confirm each key's class at build (the singular keybind keys stay
   on `Prefs`). outposts.js needs no change — it's **pure derivation** from `results` +
   `mission-*-done` (`outposts.js:bootstrap`), so it inherits per-site automatically.
3. **Legacy migration (one-time, guarded by `mc-migrated-v2`)**: on first load of the new
   build, move existing global progress keys (`mc-results`, `mc-mission-*-done`,
   `mc-photos`, `mc-sol`, `mc-intro-seen`) under `mc-<mc-site||jezero>-*`, then delete the
   legacy globals. Preserves current players' (Jezero) progress; runs once.

### Verify (A)
Per-site isolation: complete Jezero's tutorial → Gale's tutorial still shows incomplete;
Jezero archive/photos/sol don't appear in Gale and vice-versa. Migration: a pre-refactor
save surfaces intact under Jezero after upgrade.

---

## Part B — The globe hub (`hub.js` + one texture)

- **Scene:** Three.js Mars sphere with a real equirectangular color map (public-domain
  USGS Viking MDIM 2.1 colorized or MOLA color hillshade), ~2048² jpg at
  `assets/hub/mars-globe.jpg`. Slow auto-rotate + drag-to-rotate (pointer **and** touch),
  optional scroll/pinch zoom, subtle atmosphere rim + star backdrop (reuse environment
  tones). A textured sphere is **not** a "heavy mesh" — OOM-safe on this box.
- **Pins:** for each site in `SITES`, place a marker from its real `center.{lon,lat}`
  (lon/lat → unit-sphere xyz). Playable sites (assets present) = bright interactive pins
  with label + progress badge read from `Save(id)` (e.g. "Sol 12 · 8/13 · 2 missions" or
  "NEW"). Un-built sites (Hellas etc.) = dim **"LOCKED · COMING SOON"** pins, data-driven
  via a `playable` flag on the site (or "in SITES but no asset files").
- **Pin card:** hover/tap → name, mission, real coords, progress; actions **ENTER /
  CONTINUE** and **RESET SITE** (`Save(id).clear()`, two-step arm/confirm like
  `hud.js`'s reset). A global **RESET GAME** button (`resetGame()` → back to hub).
- **Fly-in handoff:** selecting a playable pin flies the camera down toward the pin, fades
  out, disposes the hub scene (free its geometry/texture — one WebGL context at a time),
  then calls `startGame(site)` → existing landing-drop intro.js provides the descent drama.
  First pass may use a quick zoom+fade if the full fly-in is too much.
- **Placement:** overlay/scene inside the existing `index.html`, toggled by `boot()`. **No
  new route, no CloudFront/infra change** (pretty-URL constraint honored).

---

## Part C — Boot flow + reset wiring

### `main.js boot()`
1. `?site=<valid>` present → `startGame(site)` (deep-link bypass, unchanged).
2. else `mc-site` exists → **auto-resume** `startGame(SITES[mc-site])`.
3. else (first-ever boot) → show the **globe hub**.

The in-game MENU's current `?site=` site-switch becomes **"OPEN MISSION MAP"** → returns
to the globe hub (map reachable anytime; after Reset Game → hub). Per-site `intro-seen`
means the landing plays on first entry to each site; the menu's existing replay control
still works.

### Reset tiers (three, from the split in Part A)
| Scope | Wipes | Keeps | Where |
|---|---|---|---|
| **Reset Run** (rename current "RESET MISSION" → "RESET RUN") | active site's live sim: positions, batteries, sample markers, fog | that site's archive/missions/photos | in-game menu (hud.js) |
| **Reset Site** (new) | all `mc-<site>-*` — fresh start, re-land, tutorial again | other sites + global prefs | hub pin card |
| **Reset Game** (new) | all `mc-*` incl. `mc-site` + prefs | nothing | hub global button |

Update the `hud.js` reset copy to name the three scopes clearly.

---

## Resume (progress-level) — why it needs no snapshot
Because saves are per-site namespaced, resume is automatic: entering a site loads its
`results`/`photos`/`sol`/`mission-*-done`; outposts re-derive; units spawn fresh with full
batteries; landing plays (or skips if seen). No live-physics serialization — this is exactly
why progress-level is low-risk. Writes already persist immediately (event-driven autosave);
the only new persistence is per-site `sol` so the clock continues.

---

## Part D — Verify & docs
- `verify` skill (CDP canary before goto — globe texture decode): hub renders, pins
  clickable, ENTER boots the correct site, badges reflect saves, Reset Site clears one save,
  Reset Game returns to hub, deep-link bypass + auto-resume both work, and **per-site save
  isolation** holds. Test on mobile viewport (drag/pinch, safe-area).
- Game plan (this, 22). Build log after push; as-built after landing; issues-and-resolutions
  for any bug. No infra/API change → no architecture/diagram update.

## Sequencing (within the wave, and vs plan 21)
1. **22-A** save-namespacing refactor + migration — unblocks correct per-site missions.
2. **21-B** Gale feature sync (now mission ids are isolated).
3. **22-B / 22-C** globe hub + boot flow + reset tiers (the visible part).
4. **22 fly-in polish**, then **21-A** Gale HiRISE asset regen whenever.
5. Verify + docs.

---

## 22-B/C build steps — APPROVED 2026-07-18 (22-A already shipped)

Decisions locked at approval: globe texture = **real public-domain NASA/USGS
equirectangular Mars color map** (not generated, not procedural). Each step is its
own commit + push; verify via the `verify` skill (CDP canary before goto).

**Grounding (current code):** page is a single `#game-root` + `#mc-canvas`
(index.html); Three.js via CDN importmap (0.185.1). Site switching today = a
"LANDING SITES" list of `?site=<id>` `<a>` links in the menu
(`hud.js` ~L266, `#mc-menu-sites`). `boot()` (main.js ~L114) already runs
`migrateLegacySaves()` then goes straight into `startGame`. `Save`/`Prefs`/
`resetGame` exist in saves.js (22-A). The hub gets its OWN `#hub-root`/`#hub-canvas`
+ short-lived renderer, disposed before `startGame` → one WebGL context at a time
(OOM-safe); the globe is a single textured sphere, not a heavy mesh.

1. **Mars globe texture asset.** Download a public-domain equirectangular Mars color
   map (USGS Astrogeology Viking-colorized global mosaic), downsize to 2048×1024
   JPEG, commit `assets/hub/mars-globe.jpg` (~1–2 MB) with source/attribution in a
   comment. Verify it decodes.
2. **`hub.js` globe scene (no pins).** `#hub-root`/`#hub-canvas` in index.html;
   own Three.js scene/renderer/camera — Mars sphere + texture, starfield backdrop,
   subtle atmosphere rim, slow auto-rotate + drag-to-rotate (pointer AND touch). Hub
   CSS in style.css. Exposes `showHub()`/`dispose()`. Verify render/rotate/dispose.
3. **Pins + cards + progress badges.** Pins at each site's real `center.{lon,lat}`
   → sphere xyz, aligned to the texture's 0°E seam (sanity-check Gale 137°E lands in
   the right hemisphere). Playable sites = bright interactive pins; unbuilt (Hellas,
   via `playable:false`/no-assets) = dim "LOCKED · COMING SOON". Raycast picking →
   pin card (name, mission, real coords, progress badge from `Save(id)` = samples
   analysed/total + missions done) with ENTER/CONTINUE + RESET SITE. Verify picking,
   badges reflect saves, locked pins non-enterable.
4. **Boot flow + fly-in handoff.** Rewrite `boot()`: `?site=` → `startGame` (bypass);
   else `mc-site` → auto-resume `startGame`; else → `showHub()`. Pin ENTER → camera
   fly-in → fade → dispose hub → `startGame` → landing intro. Menu LANDING SITES →
   an "OPEN MISSION MAP" button back to the hub. Verify all four boot paths + fly-in
   lands the right site. (This reverses "straight into sim" for FIRST-TIME visitors
   only; auto-resume keeps returning players fast; `?site=` still deep-links.)
5. **Reset tiers.** Rename hud "RESET MISSION" → **RESET RUN** (copy only; still a
   reload). Pin-card **RESET SITE** → `Save(id).clear()` (arm/confirm). Hub global
   **RESET GAME** → `resetGame()` (arm/confirm) → fresh hub. Verify RESET SITE wipes
   one site only; RESET GAME wipes all.
6. **Full verify + as-built.** Hub E2E (pins, all boot paths, both resets, per-site
   badge isolation, mobile drag/pinch + safe-area, CDP canary); as-built note here;
   build log after push.

After 22-B/C: plan 23 (Drive BYOC cloud save) → Wave 2 (new sites, each now just a
pin + assets).

---

## 22-B/C — AS-BUILT (2026-07-19)

Shipped in six commits (one per build step), verified via the `verify` skill.

- **Texture** (`assets/hub/mars-globe.jpg`, +`SOURCE.md`): public-domain USGS
  Viking MDIM 2.1 colorized mosaic via NASA Mars Trek WMTS — level-3 tiles
  (16×8 = 4096×2048) stitched row-major, downsampled 2:1 (Lanczos) to a clean
  2048×1024 sRGB JPEG (~0.6 MB). North up, prime meridian centred.
- **`hub.js`** (new): own short-lived Three.js scene/renderer, disposed before
  `startGame` → one WebGL context at a time. Textured Mars sphere, additive-
  fresnel atmosphere rim, warm starfield, slow auto-rotate + drag (Pointer
  Events, pinch-zoom, wheel dolly). Outer **tilt** / inner **spin** rig so pins
  ride the globe. Pins at each site's real `center.{lon,lat}` mapped to the
  texture seam (`lonLatToVec3`); Gale 137°E / Jezero 77°E verified in the east
  hemisphere. Playable = gold tappable pins + name/badge label from `Save(id)`;
  future sites (`LOCKED_SITES`: Hellas, Olympus, Meridiani — kept OUT of `SITES`
  so `startGame` can't route into them) = dim "COMING SOON". Raycast pick uses
  an **analytic horizon test** (`dir·cameraDir > R/D`, one `isFront()` for pick
  + label visibility), robust to the limb where billboards ignore depth.
- **Pin card** (`#hub-card`): name, mission, real coords, progress badge, with
  ENTER/CONTINUE (CONTINUE when the site has progress). Selecting eases the pin
  to front-centre. **Fly-in**: ENTER dives the camera + fades, disposes the hub,
  then `enterSite()` boots the sim; the landing-drop intro carries the descent.
- **Boot flow** (`main.js`): `?hub` → hub · `?site=` → that site · `mc-site` →
  auto-resume · first-ever → hub. `enterSite()` cleans the URL (refresh
  auto-resumes). In-game menu's site list → one gold **OPEN MISSION MAP** button
  (`→ ?hub`, full nav tears down the sim context).
- **Reset tiers**: **RESET RUN** (hud rename, reload only) · **RESET SITE**
  (card, `Save(id).clear()`, arm/confirm, badge→NEW in place) · **RESET GAME**
  (hub corner, `resetGame()`, arm/confirm, all pins NEW).

**E2E: 52/52** — globe render/decode/dispose (7), pins+cards+badges+pick+
occlusion (14), all four boot paths + fly-in (7), reset tiers + per-site
isolation (10), mobile touch-drag/pinch/safe-area (8), sim round-trip:
RESET RUN label + OPEN MISSION MAP → hub (6). No infra/API change → no
architecture/diagram update.

---
Lead Designer and Prompter: Ankit Srivastava
Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
