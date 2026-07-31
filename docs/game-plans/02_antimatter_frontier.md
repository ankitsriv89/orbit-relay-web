# Antimatter Frontier — Implementation Plan (v2, design-led)

## Context

`docs/game-plans/antimatter-gamified.md` is a design doc for a browser game — a physics-accurate **antimatter game**: scale production from picograms toward enough fuel for interstellar travel; win by delivering a probe (then a crewed ship) to Alpha Centauri (4.37 ly) using a real relativistic photon-rocket calculator. Reference image (`antimatter-game.jpg`): a CERN-like accelerator hall (glowing cyan rings, magenta Penning-trap canisters, consoles) + a starship firing an annihilation plume at a star, framed by holographic readouts.

**Two things were wrong with the doc and are corrected here:**
1. **Stack:** it proposes React 19 + TS + Vite + R3F + Zustand. This playground is **static, no-build, vanilla ES modules over importmap** (`public/rocket-lab/`, `public/game-v2/`). We build vanilla.
2. **Core loop:** as written it's "buy accelerator → number goes up → buy bigger accelerator" — an idle game in a sim costume with no tension. **This plan re-designs the loop** (decisions below are authoritative).

**Design direction (authoritative — supersedes the doc's loop/tech-tree):**
- **The game is the produce/store/decay trilemma.** Antimatter annihilates on contact; traps leak; containment costs enormous power. You can make a lot but struggle to *hold* it. Every moment is "produce more" vs "keep what I have" vs "afford containment." Decay is aggressive; this tension *is* the game, not a 20-node tree.
- **Physics is the antagonist.** The relativistic calculator quotes a horrifying required-antimatter number from minute one (a giant always-visible target bar). The arc: *the universe quoted you an insane price — claw your way to affording it.*
- **3 propulsion archetypes, not a generic tech tree.** Mutually-influencing strategies, each with a different optimal play: **Catalyzed** (cheap, heavy, slow), **Beamed-core** (balanced), **Pure photon** (brutal mass ratio, fastest). Replayability = "which path solves the mission," not node count.
- **Breach-as-drama = the "death" beat.** Overflow/brownout → partial annihilation: screen-shaking gamma flash (great bloom moment), lost stock + reputation. High stakes make number-go-up matter. This is the "your rocket blew up" equivalent.
- **Win is a journey, not a button.** After launch, time fast-forwards and you *watch* the probe cross 4.37 ly with ship-time vs Earth-time clocks visibly diverging — the divergence is the payoff and teaches relativity.
- **Prestige axis:** each completed mission banks permanent "blueprint" bonuses + resets stock — gives the idle loop legs.
- **Real-numbers honesty layer:** tooltips cite actual physics (CERN ≈ nanograms/year; 1 g ≈ Hiroshima energy). Fits SIGNAL's grounded-sim vibe.
- **Full playable MVP** in v1. **Accelerator hall = primary 3D scene**; starship = small **mission-monitor inset** reflecting hall progress (not co-equal split). **Distinctive holographic HUD.** **Mobile-first / responsive** (first-class, designed phone-up).
- **Procedural audio** (like game-v2): accelerator hum rising with throttle, deep annihilation boom on launch/breach.

Outcome: self-contained game at `public/antimatter-frontier/`, hub-linked, deployed to Cloudflare Pages.

## Architecture — single pure reducer (authoritative)

Resist scattering mutation across modules. **One pure reducer is the source of truth:**

```
step(state, action) -> state        // action ∈ {type:'TICK', dtDays} | {type:'BUY', id} | {type:'RESEARCH', id}
                                     //         | {type:'SET_ARCHETYPE', id} | {type:'LAUNCH', plan} | {type:'PRESTIGE'}
```

Everything — tick, buy, research, launch, breach, prestige — is an action through `step`. **No Redux library**, just the shape. Why this matters:
- **Deterministic + replayable** from `seed + action log` (or a snapshot) → trivial save/load, time-travel debug.
- **Testable balance:** simulate N days of strategy X headless, assert win-time/feasibility — before any UI or art exists.
- **3D is a pure view** that *subscribes* to state and is 100% disposable/regenerable. WebGL death loses pixels, nothing else.

**Fixed-timestep sim, decoupled from render.** Economy advances in fixed sub-steps (e.g. 1 logical day = N fixed steps) accumulated independently of rAF, so a 120 Hz phone and a 30 Hz potato produce **identical outcomes**. Render only *samples* state. **Offline progress** falls out for free: on load, fast-forward `now − lastSeen` through the same reducer (clamped/with a cap).

**Data-driven content.** Facilities, archetypes, missions, balance curves are plain data objects in `content.js` — rebalance without touching logic; an AI-assisted balance pass can iterate numbers in isolation.

## Conventions to mirror (verified in repo)
- **importmap (CDN, pinned):** copy `public/rocket-lab/index.html:26-33` — `three@0.160.1` via jsDelivr (`three` + `three/addons/`). Don't vendor three.
- **Pure module style:** `public/rocket-lab/js/physics.js` — "PURE: no Three.js, no DOM" header + documented formulas. Mirror for the reducer/physics/content.
- **Headless-safe scene:** `public/rocket-lab/js/scene.js` returns `{ok:false}` with no WebGL. Mirror.
- **State + debug hook in main.js:** `public/rocket-lab/js/main.js` + `window.__rocketLab`. Mirror with `window.__antimatter` (exposes `step`, `state`, `dispatch`).
- **Post-FX:** `public/game-v2/src/main.js` — `QUALITY_PRESETS`, `?quality=`, ACES tonemap, `RenderPass → UnrealBloomPass → OutputPass`, `dt=min(getDelta(),0.1)`, resize re-sizes renderer AND composer. Mirror.
- **Save:** `public/rocket-lab/js/storage.js` — versioned key, fail-soft, autosave. Mirror.
- **Audio:** `public/game-v2/src/audio.js` — procedural WebAudio pattern. Mirror for the hum/boom.
- **Hub card:** `public/index.html:119-136`. **_redirects/_headers:** `public/_redirects`, `public/_headers`.

## Files to create — `public/antimatter-frontier/`

```
index.html        HUD shell + importmap (three@0.160.1) + holographic overlays
style.css         holographic theme; mobile-first responsive
js/
  content.js      PURE DATA. Facilities, 3 archetypes, missions, balance curves, starting state.
  physics.js      PURE. Relativistic photon-rocket math (§Physics).
  reducer.js      PURE. step(state, action) — the entire game logic (tick/buy/research/launch/breach/prestige).
  selectors.js    PURE. Derived read-models for the view (deriveStats, missionFeasibility, breachRisk).
  storage.js      PURE (localStorage). Versioned save/load/autosave + lastSeen for offline progress.
  main.js         RENDER/DOM. Entry. Holds state, fixed-step accumulator + render loop, dispatch, headless-safe.
  scene.js        RENDER. Renderer/scene/camera/controls/composer. {ok:false} if no WebGL.
  hall3d.js       RENDER. Accelerator hall (rings, trap canisters, consoles); emissive driven by state.
  monitor3d.js    RENDER. Small starship mission-monitor inset (render target → HUD panel).
  fx.js           RENDER. Plume, ring pulses, BREACH gamma-flash + screen shake (Points/InstancedMesh).
  audio.js        RENDER-side. Procedural hum (∝ throttle) + annihilation boom (launch/breach).
  hud.js          DOM. Resource bar, target bar, panels, planner readouts, sparkline graphs. No three.
  ui.js           DOM. Overlays (.is-open/aria-hidden), tabs, mobile drawers, toasts, breach overlay.
  visualize.js    RENDER. Launch/journey animation + diverging ship/Earth clocks; drives monitor3d.
```
**Pure (no three/DOM):** content, physics, reducer, selectors, storage. **Render/DOM:** main, scene, hall3d, monitor3d, fx, audio, hud, ui, visualize.

## Physics — `physics.js` (PURE)

Photon rocket: exhaust = annihilation photons at c → rocket equation collapses to the Doppler factor. Antimatter = half the annihilated propellant (1:1 matter:antimatter).

```
C=299792458; C2=C*C; LY_M=9.4607304725808e15; SEC_PER_YEAR=365.25*86400;

gamma(beta)                     = 1/sqrt(1-beta^2)
photonMassRatioSingle(beta)     = gamma*(1+beta) = sqrt((1+beta)/(1-beta))   // accel only (flyby probe)
photonMassRatioAccelDecel(beta) = (1+beta)/(1-beta)                          // accel+decel (rendezvous)

calculateAntimatterRequired(payloadKg, beta, distanceLy, {rendezvous, archetype}):
  massRatio    = (rendezvous ? accelDecel : single)  // then modified by archetype efficiency (see below)
  fuelKg       = payloadKg*(massRatio-1)
  antimatterKg = fuelKg/2 / archetype.amFraction      // archetype: how much of fuel must be antimatter
  energyJ      = fuelKg*C2
  earthYears   = (distanceLy*LY_M)/(beta*C)/SEC_PER_YEAR
  shipYears    = earthYears/gamma(beta)
  → {beta,gamma,massRatio,antimatterKg,fuelKg,energyJ,earthYears,shipYears,feasible}
```
**Archetypes modify this** (in `content.js`): Catalyzed = low `amFraction` (most thrust from fusion, less AM) but heavy dry mass + lower max β; Beamed-core = mid; Pure photon = `amFraction=1` (all AM, smallest payload mass, highest β) but brutal stock requirement. Same formula, three balance profiles → three strategies.

Sanity: β=0.2 flyby → massRatio ≈ 1.2247. Pure-photon rendezvous at high β → required kg explodes (the price-shock).

## Reducer & economy — `reducer.js` (PURE)

`step(state, {type:'TICK', dtDays})` runs the trilemma each fixed step:
- **Energy throttle:** `throttle = min(1, powerMW / (productionDemandMW + coolingDemandMW))`. Containment cooling competes with production for power — the central squeeze.
- **Production:** `producedKg = baseProductionKgPerDay * throttle * archetypeMult * dDays`.
- **Decay (aggressive):** `stockKg *= exp(-decayPerDay*dDays)`; `decayPerDay` falls only with better traps (expensive, power-hungry). Then add production.
- **Storage + BREACH:** if `stockKg > storageCapKg` OR `throttle` browns out cooling below a threshold → **breach**: lose a fraction of stock, drop reputation, emit a `breach` event the view turns into the gamma-flash/boom. Risk surfaced by `selectors.breachRisk` so the HUD warns *before* it happens.
- **Money:** `+= (grants + reputation*repIncome − salaries − upkeep − energyCost) * dDays`.
- **Reputation:** rises at production milestones, falls on breach.

Other actions: `BUY`/`RESEARCH` (deduct, append id, recompute via `selectors.deriveStats`), `SET_ARCHETYPE` (switch strategy — affects physics + production), `LAUNCH` (validate stock ≥ required, spend it, start journey), `PRESTIGE` (bank blueprint bonuses from completed missions, reset stock/facilities, keep permanent multipliers). All pure; content from `content.js`, never hardcoded.

## 3D scene — `scene.js` + `hall3d.js` + `monitor3d.js` + `fx.js`

Light does the work — favour **instanced + emissive-only geometry feeding bloom** over detailed meshes (cheaper, closer to the reference's glow look).
- Deep-space black, faint star shell (Points).
- **Accelerator rings:** `TorusGeometry`, emissive cyan (`0x0aa0ff`); count scales with facilities; emissive pulse ∝ throttle; hum audio tracks the same value.
- **Penning-trap canisters:** emissive-magenta (`0xff2a6d`) cylinders + additive containment-field shell; glow ∝ stock fill %; **flickers red as `breachRisk` rises**; InstancedMesh.
- **Consoles/props:** low-poly emissive boxes (decorative).
- **Mission monitor (`monitor3d.js`):** small framed screen (WebGLRenderTarget → HUD panel) showing starship + star + plume; persistently displays the **current best-affordable mission + trip-time** (the always-on carrot), and plays the launch/journey.
- **FX (`fx.js`):** plume `THREE.Points` (white→cyan→magenta, additive) density ∝ thrust; **breach = full-screen gamma flash + camera shake + bloom spike + boom**.
- **Post-FX:** `EffectComposer → RenderPass → UnrealBloomPass → OutputPass`, ACES, as game-v2.

Deferred (later): relativistic aberration/Doppler shaders, animated scientists, detailed CERN geometry, GLTF.

## HUD/UI — holographic, mobile-first (`index.html` + `style.css` + `hud.js` + `ui.js`)

`af-` prefix. Holographic: angled/clipped bezels (`clip-path`), thin glowing borders, scanline/grid backdrop, cyan=matter / magenta=antimatter / gold accents, real-time **canvas sparklines** (stock, production, money).

```
header.af-header     ⌂ SIGNAL / ANTIMATTER FRONTIER [ALPHA]   [? HELP] [EXIT →]
#af-viewport         accelerator-hall canvas (full-bleed)
.af-resourcebar      MONEY · ENERGY(avail/demand) · ANTIMATTER STOCK · SCIENTISTS · REPUTATION
                     + time controls (⏸ ×1 ×10 ×100) + sparklines
.af-targetbar        ALWAYS-VISIBLE giant goal bar: stock vs ANTIMATTER REQUIRED for current mission
aside#af-build       PRODUCTION — accelerators/power/cooling/traps; live g·day, decay, storage fill, BREACH RISK meter
aside#af-mission     MISSION MONITOR (monitor3d) + ARCHETYPE picker (3 cards) + RESEARCH list
#af-planner          payload · β slider · destination · rendezvous toggle →
                     γ · massRatio · ANTIMATTER REQUIRED · SHIP yr · EARTH yr · energy · LAUNCH (stock-gated)
overlay #af-launch   journey animation + diverging ship/Earth clocks
overlay #af-breach   gamma-flash dialog: what was lost (drama beat)
overlay #af-help     how-to + equations + real-numbers honesty notes
overlay #af-win      arrival verdict + PRESTIGE (bank blueprints, new game+)
```

### Mobile-first / responsive (designed phone-up, then expand to desktop)
Most builds do desktop-first and bolt on mobile; we invert it (the hardest constraint). Mirror rocket-lab's drawer pattern (`public/rocket-lab/index.html:62-67` — toggle chips + scrim).
- **Viewport:** `<meta viewport ... viewport-fit=cover>`; layout in `dvh` + `env(safe-area-inset-*)` so canvas/planner clear browser chrome + notches.
- **Phone (default, ≤900px / portrait):** asides are **off-canvas drawers** via chips (`≡ BUILD`, `MISSION ≡`); resource bar = compact 2-row grid; planner = collapsible bottom sheet; target bar stays pinned. One drawer at a time + scrim. Tap targets ≥44px; β slider + steppers thumb-usable.
- **Desktop (expansion):** drawers dock as persistent asides.
- **Touch:** OrbitControls gestures only inside `#af-viewport`; panels scroll normally.
- **Perf:** `?quality=auto` → mobile gets `low`/`medium` (cap `pixelRatio`, fewer particles, bloom maybe off); monitor render target downsized on mobile.
- **Orientation:** both supported; re-layout + renderer/composer resize on `orientationchange`/`resize`.

## Render loop & quality — `main.js` (mirrors game-v2)
- `QUALITY_PRESETS = { low{bloom:false,particleScale:.5,prCap:1}, medium{bloom:true,.8,1.5,strength:.6}, high{bloom:true,1,2,strength:.9} }`. `?quality=…|auto`, `?nofx` bypass.
- Renderer ACES tonemap, sRGB, exposure ≈1.1; Bloom strength from preset, radius 0.5, threshold 0.85.
- Loop: `dt=min(getDelta(),0.1)` → accumulate into fixed sim sub-steps → `dispatch(TICK, dDays)` per sub-step → `hall3d/monitor3d/fx/audio.update(sampledState)` → `hud.update` (throttled ~100ms) → `composer.render()`. Resize re-sizes renderer AND composer.

## Save — `storage.js` (localStorage)
Key `antimatter.save.v1`, versioned, fail-soft, `lastSeen` for offline catch-up. Facilities/research/archetype/blueprints are source of truth; derived recomputed by `selectors` on load.
```
{ version:1, updatedAt, lastSeen, state:{ gameDays, money, stockKg, scientists, reputation,
  archetype, facilities:[ids], research:{completed:[ids]}, blueprints:{...permanent bonuses},
  planner:{payloadKg,beta,rendezvous,destLy}, missions:{launched,arrived,completedCount} } }
```
On load: fast-forward `now − lastSeen` (capped) through `step(TICK)` for offline progress.

## Hub card + redirects + headers + deploy
- **`public/index.html`** — add after rocket-island (`:157-173`): `card--antimatter`, badge `NEW · SIM`, accelerator-ring SVG, tag `ANTIMATTER GAME · THREE.JS`, title `ANTIMATTER FRONTIER`, desc, `BUILD →`. Add `card--antimatter` cyan/magenta accent to `hub.css`.
- **`public/_redirects`** — `/antimatter-frontier    /antimatter-frontier/    301`.
- **`public/_headers`** — `Cache-Control: public, max-age=86400` for `/antimatter-frontier/js/*` and `/antimatter-frontier/style.css`.
- **Deploy:** `wrangler pages deploy public --project-name signal-playground` (with `ankesrtw` GitHub account active per README).

## Build sequence (prove the loop is fun BEFORE art)
1. **Pure core in a test harness — no UI.** `content.js` + `physics.js` + `reducer.js` + `selectors.js`. Headless: assert relativistic math, and that *some* strategy wins in a sane day-count; tune the trilemma (decay vs containment vs production) so it's tense. This is where balance is decided.
2. **Ugliest playable HTML.** Raw numbers + buttons wired to `dispatch`, `window.__antimatter`, `storage` + offline progress. Confirm the **loop is fun as text** (trilemma squeeze, breach scares, target bar chips down). If boring here, 3D won't save it — iterate before proceeding.
3. **Mobile-first responsive holographic shell.** Real `hud.js`/`ui.js`/`style.css` designed phone-up: target bar, resource bar, drawers, planner, archetype picker, breach + win overlays, sparklines.
4. **3D as glow.** `scene.js` (headless-safe) + `hall3d.js` instanced emissive rings/canisters reacting to state + breach risk.
5. **Post-FX + quality + audio.** Composer/bloom/ACES, `?quality=`/`?nofx`, procedural hum/boom.
6. **Drama + payoff.** `fx.js` plume + breach gamma-flash/shake; `monitor3d.js` carrot screen; `visualize.js` journey with diverging clocks; prestige flow.
7. **Polish + integration.** Honesty tooltips, help, hub card, `_redirects`, `_headers`; deploy; build-log/README per repo conventions.

Playable end-to-end (headless) after step 2; fun-validated before any 3D.

## Verification
- **Local static server:** `python3 -m http.server 8000 --directory public` → `http://localhost:8000/antimatter-frontier/`.
- **Headless determinism/balance:** via `window.__antimatter`, replay an action log → identical end state; simulate strategies → assert win-time + breach behaviour; assert `calculateAntimatterRequired(100,0.2,4.37).massRatio ≈ 1.2247`.
- **Trilemma feel:** stopping production → stock visibly decays; over-producing past cap → breach fires; cooling brownout → breach risk warns first.
- **Flags:** `?quality=low` (no bloom), `?nofx`; resize re-sizes renderer + composer.
- **Mobile:** 375×812 + landscape (devtools) — drawers one-at-a-time + scrim, safe-area clearance, touch rotate/zoom on canvas, β slider thumb-usable, no horizontal scroll, `?quality=auto` picks mobile preset.
- **Save/offline:** mutate → reload → autosave restores; close for a while → offline progress applies (capped); private-mode/quota fails silently.
- **Deploy check:** `/antimatter-frontier` 301→ trailing slash; hub card links.

## Reference-image prompts (generate before/during build for visual checks)
Generate these as visual targets to check the build against (16:9 unless noted; dark, holographic, cyan=matter / magenta=antimatter / gold accents):

1. **Accelerator hall (primary scene):** "Dark futuristic antimatter production hall, large glowing electric-cyan circular particle-accelerator rings, rows of magenta-glowing Penning-trap containment canisters with faint additive force-field shells, low-poly emissive control consoles, deep-space-black background, volumetric glow, heavy bloom, CERN-meets-cyberpunk, grounded sci-fi realism."
2. **Holographic HUD frame:** "Holographic dark game UI overlay, angled clipped-bezel panels with thin glowing cyan borders, gold accent labels, a large goal/target progress bar, small real-time sparkline graphs, Kerbal-like instrumentation, scanline grid backdrop — no photoreal content, just the UI chrome."
3. **Mission-monitor inset:** "Small framed sci-fi monitor screen showing a sleek interstellar probe firing a brilliant white-cyan-to-magenta annihilation plume toward a bright star, holographic readouts 'ANTIMATTER REQUIRED', 'SHIP TIME', 'EARTH TIME', dark bezel."
4. **Breach drama beat:** "Catastrophic antimatter containment breach, blinding white-magenta gamma flash erupting from a Penning-trap canister in a dark accelerator hall, intense bloom, debris and shockwave, dramatic — the 'failure' moment."
5. **Journey payoff:** "Interstellar probe coasting through deep space toward the Alpha Centauri star, faint relativistic star-streaking, two diverging holographic clocks labelled SHIP TIME and EARTH TIME, lonely and vast."
6. **Mobile portrait layout (9:16):** "Phone-portrait holographic game HUD: pinned top resource bar + goal bar, full-bleed glowing accelerator-hall canvas, bottom collapsible mission-planner sheet, off-canvas drawer chips, thumb-friendly controls — dark cyan/magenta theme."

## Notes
- No backend (all client-side), consistent with the playground.
- New game = new folder; existing files touched only: `public/index.html` (+1 card), `public/_redirects`, `public/_headers`, `public/hub.css` (accent).
