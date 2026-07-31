# Wave 3 — Polish Jezero: base-station GLB, landing-drop intro, tutorial

Approved 2026-07-11. Resequenced ahead of Wave 2 (site expansion): perfect
the single proven site (Jezero) — base-station GLB, an in-engine
landing-drop intro (not a video), and a guided tutorial — so Wave 2 later
copies a polished pattern instead of propagating rough edges across many
sites. Builds on top of the bug-fix wave (`1f9f522`: collision registry,
mission boundary, reset, humanoid scale, 12/10 collectibles).

All three pieces are additive polish on a stable, deployed baseline —
nothing here touches core movement, collision, or science-loop logic
except where explicitly noted (lab.js obstacle values are read, not
recalculated).

See `docs/game-plans/05_mars_colony_phase_next.md` for the surrounding
wave roadmap (Wave 2 site expansion, Wave 4 gameplay depth, Wave 5 scale
enabler).

## Build order (and why)

1. **Base-station GLB** — visual anchor everything else keys off (the
   intro flies toward it; the tutorial's "deliver to lab" objective points
   at it). Do this on stable geometry first.
2. **Landing-drop intro** — depends on the station existing; riskiest/most
   novel piece (new camera behavior), so de-risk it before layering the
   tutorial's state machine on top.
3. **Tutorial-as-first-mission** — depends on the intro finishing cleanly
   (first banner appears right after handoff) but touches the most call
   sites in main.js, so it lands last, on a stable base.

Each piece is independently playable/deployable in this order.

## 1. Base-station GLB

**Asset:** cargo-container-style hab module (ribbed metal panels, airlock
hatch, small antenna stub) — sourced via Tripo image-to-3D
(`threejs-3d-generator` skill), concept art first via
`threejs-image-generator`, matching the existing rover/drone/recon/humanoid
pipeline. **Do not** attempt local mesh editing/splitting (no Blender;
trimesh split previously OOM'd this box).

**Integration:** replace ONLY the dome+airlock primitives in
`js/lab.js` (lines ~56-62). Keep pad, orange ring, comms mast, and beacon
column procedural — they're tuned gameplay furniture (landing target,
findable-over-ridgeline beacon with its additive shader), not worth GLB
budget, and re-deriving proportions from an unknown Tripo export is
unnecessary risk. Collision footprint values in `lab.js`'s `obstacles[]`
(currently `{r:3.2,h:3.1}` dome + `{r:1.5,h:1.7}` airlock) stay hardcoded
as-is — do not recompute from the GLB's bounding box, to avoid silently
changing collision behavior tuned against the old geometry.

**Code shape:** `js/models.js`'s `attachUnitModel` assumes a
yaw-to-heading unit convention that doesn't fit a stationary structure.
Add a sibling function instead of forcing the station through that API:

```js
// models.js
const STATIC_MODELS = {
  station: { url: 'assets/models/station.glb', yaw: 0, footprint: 6 },
};
export function attachStaticModel(group, name, onReady) { ... }
```

Same `GLTFLoader` instance and `applyBrandFinish` (teal tint, consistent
"SIGNAL hardware" look — needs `scene.environment` PMREM map, already
present). Normalization differs from units: measure the full bounding box
(no single-axis `size`), scale to a target footprint, center x/z, base at
y=0 — same grounding convention as units, just no yaw-to-heading logic.

**Post-playtest revisions (2026-07-12):** footprint 6m → **15m** (hangar
scale — the dock should read as housing all units, not rover-sized);
material forced `DoubleSide` (the container GLB has window/door openings
and single-sided walls — interior showed terrain through the shell);
station offset moved to `PAD_RADIUS + 9` with collision circle r=7.6
h=8.5 (obstacles deliberately updated with the scale change); mast moved
beside the dock (z+6.5); placeholder switched from dome+airlock to a
container-scale box; fallback primitives hidden for 2.5s while GLBs load
(kills the boot "gray blocks" flash, offline guarantee kept); menu gained
**▶ LANDING INTRO / ▶ TUTORIAL replay buttons** — both sequences
re-runnable anytime without touching the first-visit flags or resetting.

`lab.js` changes: remove the dome/airlock `Mesh` creation, replace with a
`THREE.Group` placeholder at the same offset (`-(PAD_RADIUS+4.5), 0, 0`)
so collision code has a stable node immediately, then call
`attachStaticModel(stationGroup, 'station', onReady)`. Fallback-first, same
idiom as units: placeholder renders immediately, GLB swaps in async, any
load failure keeps the placeholder forever.

## 2. In-engine landing-drop intro

**Behavior:** reuse the **lift drone's mesh** as the descending body (no
new asset) — starts ~400-600m AGL above `site.spawn` (intro-only altitude,
ignores the drone's normal 150m ceiling), scripted descent with ease-in/
ease-out (hand-tuned cubic or damped spring, no physics engine — matches
project style) ending EXACTLY at the drone's normal resting spawn offset,
so no special-casing is needed in `drone.js` — the intro is a pure
camera-and-visual overlay that finishes where the game already begins.
Duration ~6-9s.

**New module `js/intro.js`** (~60-90 lines), matching the project's
single-purpose-module convention (lab.js/analysis.js/colliders.js
precedent):

```js
export function createLandingIntro(terrain, site) {
  return {
    active: true,
    update(dt) -> { pos: Vector3, heading: number, done: boolean },
    skip(),
  };
}
```

**Hook into boot()/startGame():** gated by a new **global** (once-ever,
not per-site) localStorage flag `mc-intro-seen`, matching the `mc-site`/
`mc-results` persistence convention. Set the flag the moment the intro
*starts* (not finishes), so a refresh mid-intro or a skip doesn't
re-trigger it. Preserve "no landing screen, straight into sim" as the
default steady state for all repeat visits and future site switches.

**Camera handoff:** reuse the existing `camRig` verbatim — during the
intro, feed `camRig.update(introPos, introHeading, 'fly', snapOnFirstFrame)`
each frame instead of the normal active-unit target; the rig already
accepts any target + a `snap` bool, so no second camera code path is
needed. On `intro.done`, the very next frame's existing
`camRig.update(active.unit.position, active.unit.heading, active.kind)`
call takes over automatically. Because the intro tracks the lift drone
(not the rover, which is the default active unit), there will be a
one-time camera cut from drone to rover on handoff — accepted as fine
(reveals the full site once you're in control), not treated as a bug.

**Skippable:** tap/click anywhere, or a small "SKIP INTRO" affordance
(reuse the boundary-banner CSS idiom) sets `intro.done` immediately and
falls through to normal camera behavior.

**Files touched:** new `js/intro.js`; edit `js/main.js` (boot/startGame
wiring, render-loop camera branch); edit `js/hud.js` (SKIP affordance).

## 3. Tutorial as first mission

**Design:** one hardcoded linear step chain — not a generic missions
system (explicitly scoped down per prior user decision), structured so a
future generalized missions layer (Wave 4/gameplay-depth) can lift the
pattern later.

**Steps** (gated on EXISTING call sites/state — no duplicated logic):
1. Drive to the beacon — gate on the same condition that already makes
   the COLLECT prompt appear (piggyback on `hud.setPrompt`'s existing
   non-null check, no new distance constant).
2. Press E to collect — gate on `tryCollect()`'s existing call site.
3. Switch to the lift drone (TAB) — gate on `switchUnit()`'s existing call
   site, matching the lift drone's index.
4. Sling the cache (E) — gate on `sling.attach()`'s existing call site.
5. Deliver to the FIELD LAB (E over pad) — gate on `lab.deliver()`'s
   existing call site.
6. Watch the edge node process it — gate on the existing `analysis`
   `onDone` callback (main.js ~line 165-171; fan out to both the existing
   HUD update and the tutorial).
7. Open the SCIENCE ARCHIVE — gate on `hud.isMenuOpen()` becoming true
   after step 6; completes the tutorial (no explicit "close menu" step).

**New module `js/tutorial.js`** (~80-120 lines):

```js
export function createTutorial(hud, { onComplete } = {}) {
  const STEPS = [ /* id + banner text, the 7 above */ ];
  function current() { ... }      // active step or null
  function advance(matchId) { ... } // no-op unless matchId is the current step
  function skip() { ... }
  return { current, advance, skip, get active() { ... } };
}
```

No polling/condition machinery inside `tutorial.js` itself — main.js
(which already owns every relevant call site) calls `tutorial.advance(id)`
directly from those 5 existing action points, plus one per-frame proximity
check (step 1, reusing `targetInfo`/`samples.nearestInfo` already computed
each frame for the HUD) and one per-frame menu-open check (step 7). Keeps
`tutorial.js` a dumb, linear, single-purpose tracker.

**Gating/persistence:** same convention as the intro — new flag
`mc-tutorial-done`. `startGame()` only constructs `tutorial` if the flag
isn't set; every call site is guarded with `tutorial?.advance(...)`
(near-zero overhead when null). `onComplete` sets the flag. A "SKIP
TUTORIAL" HUD affordance calls `tutorial.skip()` and also writes the
completion flag (skipping counts as done). Tutorial starts AFTER the
landing intro finishes, not concurrently.

**HUD additions:** new `setObjective(text)` method on `hud.js`, following
`setBoundary`'s exact idiom (cached "shown" state, single dataset toggle,
no new framework) — new `#mc-objective` element near `#mc-boundary`, same
banner treatment, distinct placement so it doesn't visually collide with
the boundary warning. Called each frame:
`hud.setObjective(tutorial?.active ? tutorial.current()?.text : null)`.
SKIP button adjacent, wired to `tutorial?.skip()`. No modal — matches the
"HUD banners, not modals" style already established.

**Files touched:** new `js/tutorial.js`; edit `js/main.js` (construct
tutorial, thread `advance()` into the 5 action call sites + 2 per-frame
checks); edit `js/hud.js` (`setObjective` + `#mc-objective` + SKIP button).

## Cross-cutting notes

- Expose `intro` and `tutorial` on the existing `window.__mc` debug handle
  (main.js ~line 248), matching how every other subsystem is already
  exposed there.
- **RESET MISSION** (`onReset: () => window.location.reload()`) must NOT
  clear `mc-intro-seen` or `mc-tutorial-done` — same spirit as `mc-results`
  surviving resets. A returning player resetting their mission shouldn't be
  forced through the intro/tutorial again.
- Base-station obstacle footprints continue to feed the same
  `colliders.addStatic()` loop already in main.js (line 159) — no change
  to that call site.

## Files created
- `public/mars-colony/js/intro.js`
- `public/mars-colony/js/tutorial.js`
- `public/mars-colony/assets/models/station.glb` (asset, via Tripo pipeline)

## Files edited
- `public/mars-colony/js/models.js` — new `attachStaticModel` + `STATIC_MODELS`
- `public/mars-colony/js/lab.js` — swap dome/airlock primitives for the GLB group
- `public/mars-colony/js/main.js` — intro wiring, tutorial construction + advance() call sites, debug handle exposure
- `public/mars-colony/js/hud.js` — `setObjective` + SKIP affordances (intro + tutorial)
- `docs/game-plans/05_mars_colony_phase_next.md` — renamed Wave 3→4, Wave 4→5, pointer added
- `.claude/skills/verify/SKILL.md` — Wave 3 verify recipe appended

## Verification plan

Solo dev, weak GPU box — verify incrementally, not just at the end:

1. **Manual playtest** via the `run` skill after each of the 3 pieces
   lands independently: station GLB loads/looks right/brand tint applied;
   intro plays once, camera tracks smoothly, skip works, handoff is clean;
   tutorial banners advance correctly through a full manual playthrough.
2. **Targeted E2E** via the `verify` skill (Playwright headless,
   `channel='chrome'`, `window.__mc` handle), extending the Wave 1.5
   script pattern:
   - Base station: assert the station mesh is present under `__mc.lab.group`
     (or a marker set in `onReady`); canvas pixel probe near the pad.
   - Intro: fresh-profile load (clear localStorage), poll for
     `intro.done` reaching true within expected duration; assert
     `localStorage['mc-intro-seen'] === '1'`; reload and assert it does
     NOT replay; test the skip path separately.
   - Tutorial: fresh-profile load, teleport rover to a sample via
     `__mc.rover.mesh.position`, drive E2E through collect → switch(Tab) →
     sling(E) → deliver(E) → `analysis.update(0.1)` fast-forward → open
     menu(M); assert `tutorial.current().id` advances through the full
     chain and `localStorage['mc-tutorial-done'] === '1'` at the end.
   - Headless gotchas already documented in the verify skill apply
     (`--enable-unsafe-swiftshader`, poll via `page.evaluate` + sleep
     loops, full-page screenshots only).
3. Persist any new verify recipe additions to `.claude/skills/verify/SKILL.md`
   under a "Wave 3 polish" subsection, matching how Wave 1.5's recipe was
   persisted.

## Decisions confirmed with user (2026-07-11)
- Base-station aesthetic: **cargo container** (ribbed metal, airlock, antenna stub).
- GLB scope: **dome+airlock only** — pad/ring/mast/beacon stay procedural.
- Landing intro flag: **global**, once ever (not per-site).
- Doc renumbering: **yes** — 05's Wave 3→4, Wave 4→5; this plan is doc 09.
