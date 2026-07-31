---
name: verify
description: Verify changes to the games in public/ (mars-colony etc.) by driving them in headless Chromium via Playwright. Use after changing game code to observe real runtime behavior.
---

# Verifying games in this repo (static Three.js apps in public/)

## Launch

```bash
cd public && python3 -m http.server 8931 --bind 127.0.0.1 &   # no build step
```

Playwright (Python) is installed in the default env. The pinned browser
download may lag the library version — point at the cached binary:

```python
browser = pw.chromium.launch(
    executable_path='/home/ankit/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',  # ls ~/.cache/ms-playwright/
    args=['--enable-unsafe-swiftshader'])
```

## Gotchas on this box (2 cores, SwiftShader = ~5fps WebGL)

- **`page.wait_for_function` starves** (rAF-polled) — poll conditions with
  repeated `page.evaluate` + `time.sleep` instead.
- **`page.click` times out** on its "stable element" actionability gate.
  Use the game's keyboard bindings instead (mars-colony: E collect/sling,
  Tab switch unit, L land, M menu, G gear).
- **Sim clock runs at ~10% real speed** (`dt` clamped to 0.1 at ~2fps
  bursts). Long timed features (e.g. 28s lab analysis): observe real-rate
  progress briefly, then fast-forward through the game's own update path,
  e.g. `page.evaluate("for (let i=0;i<700;i++) __mc.analysis.update(0.1)")`.
- Boot can take 30-90s cold (texture + GLB decode). Wait for the debug
  handle, not networkidle.
- **Element screenshots (`locator.screenshot`) also time out** on the
  stability gate. Use full-`page.screenshot`, or for canvases grab pixels
  in-page: `canvas.toDataURL()` / `ctx.getImageData()` via `page.evaluate`.

## mars-colony specifics

- Debug/E2E handle: `window.__mc` (main.js) — site, terrain, rover, recon,
  lift, humanoid, samples, lab, sling, analysis, units, env, colliders,
  intro, tutorial.
- Teleport units by setting `__mc.<unit>.mesh.position.x/z` (y re-grounds
  per frame). Actions still run the game's own distance/altitude checks.
- Sample flow: rover near marker → E → cache container appears → lift drone
  airborne ≤8m AGL within 7m of container → E slings → over lab pad ≤16m
  AGL → E delivers → analysis.js queue (28s each) → menu SCIENCE ARCHIVE +
  localStorage `mc-results`.
- Full worked example: see the Wave 1.5 script pattern (poll helper,
  keyboard-driven actions, soft prompt assertions, state dump on failure).

## CACHE-BUST when verifying an edit — 2026-07-14

`python3 -m http.server` serves `js/` with default caching, and Playwright's
fresh context does NOT reliably dodge it. A stale module silently invalidated
a whole tuning round: a constant was changed 4x, the numbers came back
*byte-identical*, and it briefly looked like cutting a damage coefficient had
*increased* damage. Symptom to watch for: **a real code change produces
literally the same measurement.** Always `page.goto(URL + '?cb=' + time)`.

## Tuning constants against terrain: measure, don't guess — 2026-07-14

Two Wave 9 constants were first set from intuition and were both far outside
the terrain's actual range (the rough-ground damage floor sat *above* the
maximum roughness the map produces, so the mechanic could never fire at all).
Measure the real distribution first with a throwaway probe, then set the
constant. Jezero reference numbers:
- micro-relief `|sampleGroundHeight - sampleHeight|`: p50 0.09 m, max 0.165 m
- roughness `|d(micro)/dt| x min(1, spd/6)`: mean 0.14 / peak ~0.5 at G2
  (6.3 m/s); ~2.7x that at G3 (16.8 m/s)
- per-frame ground drop: max 0.16 m at G2, 0.5 m at G3
- steepest drop anywhere: ~1.79 m over a 3 m span (~31 deg) — **the DEM has no
  true cliff**, so "drive off a cliff" tests must use a fast drop-off, not a
  ledge, and a rover correctly does NOT fly down a 31 deg slope
- pick terrain patches on a FIXED grid, never `Math.random()` — random patches
  make two tuning runs incomparable

## Unit-state gotchas (Wave 9)

- `drone.landed` / `drone.alt` and `rover.heading` are **getters** — assigning
  them is a silent no-op. Take off via `commandAlt()`; you cannot aim the rover,
  so place the obstacle along its OWN travel direction instead (forward throttle
  is NEGATIVE: dir = `-(sin h, cos h)`).
- `rover.forceRoll()` incapacitates the rover — any test after it measures a
  dead rover (speed 0, no damage, no airtime). Run rollover checks LAST.
- Teleporting a unit does not reset its vertical integrator (`bodyY`), so it is
  genuinely mid-fall on the next frames. **Settle with zero-input updates after
  any teleport** before measuring airborne/again.
- Tab does not reach the page headless — fire the game's own switch event:
  `document.dispatchEvent(new CustomEvent('mc-switch-unit'))`. The HUD unit
  label is UPPERCASE ('LIFT DRONE').

## CRITICAL: kill leftover headless Chrome after every run

Each Playwright `.launch()` on this box leaves a `chrome-linux64/chrome`
process behind if the script errors, times out, or is killed instead of
calling `browser.close()`. They accumulate silently across sessions —
10 stray instances measured (2026-07-11) drove load average to ~12 on
this 2-core box and starved EVERY subsequent headless run into an
apparent-hang with zero output, even for scripts with no logic bug.
**Before debugging a "stalled"/"never completes" E2E symptom, always
check first:**

```bash
ps aux | grep "chrome-linux64" | grep -v grep | wc -l    # should be ~0-2
uptime                                                    # load avg should be well under nproc (2)
```

`pkill` against these processes was refused by this environment's
sandbox even after explicit user approval — if the count is high, ask
the user to close them manually (task manager / their own shell) rather
than retrying the same script hoping it's a timing fluke.

**Zero stray processes does not guarantee a healthy run** (2026-07-12):
even with 0 leftover chrome and load down from ~12 to ~3, a retry still
hung — root-caused to a bare `page.evaluate("() => 1+1")` blocking
forever right after `goto()` returned, i.e. the CDP/Playwright
communication channel itself stalling, not game logic or even page
rendering. Load had climbed back to ~7 by the time this was isolated
(other work on the box, unrelated to this repo). If a trivial
no-op `evaluate()` doesn't return within a few seconds, the box is
still too contended for headless verification — don't keep debugging
the game code, re-check `uptime` and stop/retry later instead.

## Wave 3 polish (station GLB, landing intro, tutorial) — 2026-07-11

- **Station GLB fallback path**: with `assets/models/station.glb` absent
  (asset generated manually via Tripo, not via this box's API keys), the
  expected signal is a single console 404 for that URL — NOT a real
  failure. Assert `__mc.lab.group.children.length === 5` (pad, ring,
  stationGroup, mast, beacon) and that the procedural dome/airlock render
  (canvas screenshot near `__mc.lab.padPos`) as the fallback-first proof.
- **Landing intro** (`mc-intro-seen` localStorage flag, global/once-ever):
  - Fresh context (Playwright's default `browser.new_context()` already
    has empty storage — no manual `localStorage.clear()` + reload dance
    needed; that pattern double-boots the game and burns the intro's
    timer before assertions run).
  - Assert `__mc.intro` truthy immediately after the `__mc` handle
    appears, and `localStorage.getItem('mc-intro-seen') === '1'` is set
    immediately too (written on intro START, not finish).
  - Poll `__mc.intro` presence every ~1s; it should become falsy
    (main.js nulls it out after `dispose()`) once the cinematic completes.
    Since 2026-07-12 the drop runs on WALL-CLOCK time (performance.now, not
    accumulated sim dt) — completes in ~7.5-10s real time even at SwiftShader
    fps; if it takes >20s something is actually wrong. Any keydown or
    pointerdown also skips it (that's a feature, mind stray inputs in tests).
  - Test skip separately: call `__mc.intro.skip()` (or dispatch a
    `pointerdown` on the canvas) and assert `__mc.intro` clears within
    1-2 frames, well before the natural duration.
  - Reload the same context afterward and assert `__mc.intro` is falsy
    immediately (does not replay).
- **Tutorial** (`mc-tutorial-done` localStorage flag): skip the intro
  first (`__mc.intro?.skip()`) so it doesn't interfere, then drive the
  existing Wave 1.5 action sequence and assert `__mc.tutorial.current().id`
  advances `drive → collect → switch → sling → deliver → analyze →
  archive` at each step (teleport via `__mc.rover.mesh.position` /
  `__mc.lift.mesh.position`, keyboard E/Tab/M, `analysis.update(0.1)`
  fast-forward for the analyze step). Assert
  `localStorage.getItem('mc-tutorial-done') === '1'` once `archive`
  completes (opening the menu while on that step). After completion the
  tutorial OBJECT persists with `active === false` and `current() ===
  null` (it is NOT nulled — only the intro gets nulled after dispose).
  `__mc.intro` / `__mc.tutorial` are live getters (2026-07-12) — menu
  replays (▶ LANDING INTRO / ▶ TUTORIAL buttons, trigger headless via
  `document.querySelector('#mc-replay-intro').click()` in an evaluate)
  reassign them, and the getters always reflect the current instance.
- **Screenshots**: prefer the in-page `renderer.render + canvas.toDataURL`
  capture (verified reliable 2026-07-12) — `page.screenshot` intermittently
  times out on this box even at low load.

## Wave 4 gameplay depth (missions, hazards, vehicle feel, overlays) — 2026-07-12

- **Missions replaced tutorial.js** (`js/missions.js`): the old
  `__mc.tutorial` handle is GONE — use `__mc.missions` (plain ref, not a
  getter; it's never rebuilt). Tutorial ships as mission `'tutorial'`
  (autostart). Assertions: `missions.currentAny()?.step.id` walks the same
  drive→collect→switch→sling→deliver→analyze→archive chain;
  `missions.advance(id)` is a BROADCAST (no mission arg — no-op when
  nothing listens); completion flag is `mc-mission-tutorial-done` (the old
  `mc-tutorial-done` key is dead); `missions.isComplete/menuEntries/skip/
  start` for menu-level checks. Replay via
  `document.querySelector('.mars-menu__mission').click()`.
- **Soft sand** (`__mc.hazardZones`, zones from `site.hazards.softSand`):
  teleport the rover to a zone center → `__mc.rover.inHazard` =
  `{type:'soft-sand', intensity, falloff, effect}`. Deterministic speed
  checks: run manual `rover.update(0.05, {throttle:-1, steer:0})` bursts
  inside ONE evaluate (no rAF interleave) in-zone vs out — displacement
  ratio ≈ `1 - 0.6*effect`. Banner: `#mc-hazard` (`data-visible` +
  textContent). NOTE input convention: forward throttle is NEGATIVE.
- **Cold drain / solar**: patch `__mc.env.daylight = () => 0|1` to force
  night/day — but **save the original first**
  (`window.__orig = __mc.env.daylight`) and RESTORE BY ASSIGNMENT. `env`
  is a plain object literal: `delete` after overwriting leaves
  `env.daylight` undefined and the whole render loop dies on the next
  frame (three's animation chain never re-requests after a throw — the
  page then looks alive but sim state freezes; cost 2 debug rounds).
  Measure battery deltas across a FIXED count of rAF frames, never wall
  time — this box dips below 1fps and wall windows can hold zero frames;
  at <10fps dt clamps to 0.1/frame so per-frame deltas are exact
  (night/day drain ratio = exactly 1.5).
- **Dust storm** (`__mc.weather`): `forceStorm()` then fast-forward via
  `for (let i=0;i<150;i++) __mc.weather.update(0.1)` (ramp runs on sim
  dt — real-time ramp takes minutes at this fps). Assert
  `__mc.scene.fog.density` AND
  `__mc.terrain.mesh.material.uniforms.uFogDensity.value` rise >2×
  0.00016 (density is copied by VALUE into both — each has its own sync
  path; testing only one can hide a regression in the other). Full-cycle
  decay: ~1400 ticks of 0.1 → intensity 0, density restored exactly.
- **Vehicle feel**: `__mc.rover.slipRatio` (1 + 1.5*effect in sand) —
  verified via wheel rotation-per-meter: find the rig
  (`rover.mesh.children.find(c => c.name === 'wheel-rig')`), spinPivot =
  `rig.children[0].children[0]`; (Δrotation.x / Δdistance) in-sand vs
  clear = slipRatio. `__mc.rover.rolloverRisk` 0..1: find steep/flat
  spots by scanning `terrain.sampleGroundNormal` on a 60m grid (Jezero's
  steepest ~0.16 slopeMag ≈ 32°); settle ~40 manual updates (5/s
  smoothing), assert against the analytic ramp
  `clamp((slopeMag-0.05)/0.13)`. HUD `#mc-t-roll` shows % for the rover,
  '—' for drones/humanoid.
- **Science overlays** (`__mc.fog.setOverlayMode('photo'|'elevation'|
  'slope'|'path')`, persisted `mc-overlay-mode`): pixel-probe the LIVE
  minimap canvas (`document.querySelector('.mars-minimap-canvas')` +
  `getImageData`) — punch fog open first with ~25 `fog.reveal(x,z)`
  stamps or probes read near-black. Slope mode: steep spot red-dominant,
  flat green-dominant. PATH trail probe: park the rover AWAY from the
  probe point first (the white active-dot has a 7px radius and
  out-brightens the teal trail), and select the most-teal pixel
  (`max(g+b-2r)`) in a 7×7 patch, not the brightest.

## Wave 6 hazard consequences (wind, dust devils, rollover, bog) — 2026-07-13

- **Storm wind** (`__mc.weather.windSpeed/windDir/windX/windZ`): ALWAYS
  `forceStorm()` FIRST, then `for (let i=0;i<300;i++) __mc.weather.update(0.1)`
  (30 sim-s = through the 25s ramp into peak). Without forceStorm the idle
  wait is 240-600 sim-s and 300 ticks leave intensity at exactly 0. Wind is
  zero outside storms BY DESIGN (calm Jezero days are a few m/s, below the
  0.5 m/s HUD threshold).
- **Drone drift**: take recon airborne, zero-input manual updates
  `recon.update(0.1, {forward:0,strafe:0,turn:0,climb:0})` — displacement
  bearing matches `atan2(windX, windZ)` to ~1e-15 (drift is positional, no
  physics noise); magnitude ≈ windSpeed × 0.35 (WIND_PUSH) × sim-time.
  `windDrift` getter = felt m/s. Landed drones: exactly 0 drift.
- **Dust devils** (`__mc.dustDevils`): `force(x, z)` spawns immediately
  (bypasses the daylight-gated clock — works at night). Vortex wind fades
  in over 6s: run `for 80: dustDevils.update(0.1)` before sampling or
  `sampleWind` reads near-0. Sample at the CURRENT `d.x/d.z` (the devil
  walks 2-4 m/s). Core-rim wind ≈ 30 m/s; zero outside r×2.5. Scene node:
  `scene.children.find(c => c.name === 'dust-devils')` (one shared Points).
  Minimap: orange dashed ring (rgba ~224,178,120) at the devil's px, probe
  64 points on the circle, expect ≥6 hits.
- **Rollover/bog state machine** (`__mc.rover.condition` ok|rolled|bogged,
  `forceRoll()`/`forceBog()` debug hooks): while down, drive input is dead
  (position frozen, speed 0) and throttle becomes the rocking control.
  Rocking = alternate throttle sign in bursts (6×0.1s each) — reversal gap
  must be ≤1.6s; ~7-9 reversals right/free it. Assist: any other unit
  within `rover.assistRange` (9m) — the LIVE loop sets the flag (sleep
  ~2.5s real after teleporting the helper), then manual zero-input updates
  accrue 1/6-0.04 ≈ 0.127 meter/s → ~8 sim-s to full. NOTE: righting
  RESETS recoveryMeter to 0 — assert `condition === 'ok'`, not the meter.
- **Bog fill math is exact**: fill/s = (effect−0.5)/0.5 × |throttle| ×
  (gearMult/150) / 10. Séítah core (effect 0.7) at G3 full throttle =
  0.0107/tick → bogs at tick ~94. Circle-drive (throttle −1, steer 0.6,
  re-teleport if >0.6r from center) keeps it in-zone. Digging: >1.2s
  one-way throttle while bogged drains the meter (assert m1 < m0) and
  slipRatio jumps to 3.4.
- **Banners**: `#mc-hazard` textContent — ROLLOVER/BOGGED (with live %),
  'rover-down' variant when another unit is active; HUD wind: `#mc-t-wind`
  ("CALM" or "N.N m/s"), `#mc-compass-wind` unhides in wind.
- **Bug class this E2E caught**: clamp-then-decay made `recoveryMeter >= 1`
  unreachable (clamped 1.0 → decayed 0.996 in the same tick, forever).
  When a meter has BOTH a clamp and a per-tick decay, the threshold check
  must run before the decay. Full script: scratchpad wave6_e2e.py pattern
  (17 sections, ~4 min run).

## Wave 7 base-building (checkposts, HQ, bootstrap) — 2026-07-13

- **`__mc.outposts`**: `buildFor(sampleId)`, `buildHq()`, `bootstrap()`,
  `list()`, `builtPositions()`, `builtCount`. Structures = scene groups
  named `outpost-<sampleId>` / `outpost-hq`.
- **Trigger a checkpost without the full logistics loop**: enqueue a bare
  container `__mc.analysis.enqueue({id:'rochette', name:'Rochette',
  finding:'t'})` then `for (let i=0;i<300;i++) __mc.analysis.update(0.1)` —
  analysis onDone fires with the record and main.js builds. Only samples
  with an `outpost` field in sites.js build (maaz etc. are negative cases).
- **HQ**: `__mc.missions.skip('tutorial')` (tutorial is Jezero's only
  mission today) → onComplete → `allComplete()` → HQ. On a FRESH context the
  tutorial autostarts so skip works immediately; if `mc-mission-tutorial-done`
  is already set, `allComplete()` is true at boot and bootstrap builds the
  HQ instead — assert at boot, don't try to re-skip.
- **Build anim**: `group.scale.y` starts <1 and eases to exactly 1;
  fast-forward via `for (let i=0;i<50;i++) __mc.outposts.update(0.1)`
  (3.2 s sim). Bootstrap-built structures are full-height immediately —
  that's the "no replay animation at boot" assertion.
- **Persistence is DERIVED**: no new localStorage keys. Reload the same
  context and assert `builtCount` at boot — it re-derives from `mc-results`
  (site-filtered) + `mc-mission-*-done`. RESET MISSION therefore keeps
  structures.
- **Toast**: `#mc-toast` (`data-visible` + textContent, self-hides after
  6 s real). Menu: `#mc-outposts-list` li's — ⬢ built / ◇ locked.
- **Minimap**: outposts render ABOVE fog (no reveal-punching needed).
  HQ = solid teal 14 px square, checkposts = hollow 8 px teal outline —
  probe max(g+b−2r) in a small patch (thresholds ~80 solid / ~60 hollow).
- **Expected 404s**: `checkpost.glb` + `hq.glb` until the Tripo assets land
  (station.glb pattern) — procedural fallbacks are the visible art; filter
  these from console-error asserts. Full script: scratchpad wave7_e2e.py
  (8 sections, 34 checks, ~3 min).

## GLB load verification on this slow box — 2026-07-13

- **"GLB not loading" is almost always decode LATENCY, not a fault.** Real
  Tripo GLBs (checkpost 21.5k verts, hq 26.6k, sample-container) load fine
  but the fallback→GLB swap lands variably 6-15s+ after the structure is
  built on this SwiftShader box. A fixed `time.sleep(6)` before a screenshot
  fires while the fallback is still showing → looks like a stuck fallback.
- **Always POLL for the swap, never sleep.** The reliable signal: the inner
  model group holds a mesh with >1000 verts (fallbacks are 24-vert boxes /
  40-vert cones). `poll(page, "(()=>{ const g=__mc.scene.children.find(c=>
  c.name==='outpost-rochette'); if(!g)return false; let mv=0; g.children[0]
  .traverse(o=>{if(o.isMesh&&o.geometry.attributes.position)mv=Math.max(mv,
  o.geometry.attributes.position.count);}); return mv>1000; })()", 90)`.
- **Load a GLB directly to isolate parse from game flow**: `import` GLTFLoader
  + three inside one `page.evaluate(async()=>...)`, load the URL, inspect
  `Box3.setFromObject` size + mesh vert counts. (THREE is NOT a page global —
  it's a module import; `new THREE.Box3()` in a bare evaluate throws
  "THREE is not defined". Either import it in the evaluate or compute the
  bbox by hand from `geometry.attributes.position` × `matrixWorld`.)
- **Sample baked texture color** to catch a wrong-color export: load raw
  (no applyBrandFinish), draw `material.map.image` to a 64×64 canvas,
  average getImageData. hq.glb averaged RGB(167,142,86)=gold even though
  the reference image was white — the gold is baked into the GLB, not code.
- **attachStaticModel latent trap**: `reveal()` (un-hides fallback) runs
  BEFORE the `footprint>0` guard's early return, so a degenerate GLB shows
  the fallback forever with no error. Not usually hit (Tripo footprints are
  ~1.4m pre-scale) but worth knowing when a swap genuinely never lands.

## Wave 11 (placement dodge, plates, sand minimap, Signal rename) — 2026-07-17

- **Placement audit**: pairwise-overlap check over `__mc.chargepads.list` +
  `__mc.comms.list` + `__mc.outposts.builtList()` with radii pad 3.6 / mast
  1.2 / checkpost 3.4 / hq 11.5 — expect zero pairs. Masts are now static
  colliders: `colliders.forUnit('__probe').collides(mastX, mastZ, 0.3)` is
  true. Chargepads stay NON-blocking (units land on them) — placement-only
  avoidance via main.js `blockedAt`.
- **Name plates**: HQ sprite scale.y hard ceiling = LABEL_H 1.8 × LABEL_MAX 3
  = 5.4. Find it via `scene.children.find(c=>c.name==='outpost-hq')
  .children.find(c=>c.isSprite)`.
- **Sand minimap layer**: zones render ABOVE fog (no reveal-punch needed) —
  probe 7×7 at each `__mc.hazardZones.zones` center on the display canvas;
  tan wash over fog reads r>b+6 with r≥22 (measured 48-59).
- **Chargepad GLB hook**: pad outer group has exactly [inner swap group,
  ring]; assert `children.some(c=>c.isMesh && c.geometry.type==='RingGeometry')`
  survives any future chargepad.glb swap. Expected 404s now include
  `antenna.glb` + `chargepad.glb` (until Tripo assets land).
- **E2E camera gotcha**: after `intro.skip()` with no player input the camera
  stays in a high top-down pose even with ROVER active — captures come out
  aerial. Fine for layout checks; for a true chase-cam shot send real driving
  input first.
