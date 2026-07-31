# 16 — Wave 9.5 B-items (Ariana hologram, recon scan, humanoid tether, repair shop)

**Goal:** Four additive features flagged in the B-item list. All are UI-facing or mission-facing. Use GLB models (via Tripo) wherever possible — procedural only as fallback. The gating constraint from Wave 10 (layout stabilization) is done — land these on the current HUD.

---

## 1. Ariana Hologram (field-lab NPC)

### What
An AI-character hologram at the FIELD LAB that plays a scripted dialog on first approach, then offers a replay button in the MENU (SCIENCE section). Ariana already exists in the SIGNAL music lore (tracks `ARIANA Speaks (v1/v2)`) — she is the colony AI who renamed herself from ATHENA after the landing.

### Implementation

**New module: `hologram.js`**
- GLB model: generate a female humanoid figure in Tripo (upright stance, arms at rest, suitable for display). Model key: `ariana-hologram.glb`.
- Load via `attachStaticModel` (same pipeline as station/checkpost/HQ — add to `STATIC_MODELS` in `models.js`). Footprint ~1.2m (person-scale).
- Hologram shader applied in `applyBrandFinish` style: traverse the loaded model and override materials:
  - `transparent: true`, `opacity: 0.4`
  - `color: #2ec4d6` (brand cyan-teal)
  - `emissive: #2ec4d6`, `emissiveIntensity: 0.6`
  - `blending: THREE.AdditiveBlending`, `depthWrite: false`
  - Custom `onBeforeCompile` hook adds a scan-line UV mask + subtle float-drift vertex offset
- Procedural fallback: a flat billboard quad with the same material properties (no GLB = a card, still looks holographic).
- Spawn at `lab.stationPos` (the station dock), y-offset 0.8m above the dock floor.
- Idle animation: slow Y-axis rotation + subtle bob (±0.05m at 0.3Hz).

**Dialog system (lightweight, no state machine)**
- No scrolling text box — keep it light: a TOAST-style banner that appears beneath the HUD objective line, auto-advancing through 3–4 lines on a timer (~3s each), dismissable with E.
- A simpler alternative: a multi-line TOAST that cycles with a `[CLICK TO CONTINUE]` affordance and a `[SKIP]` button.
- Canned script, one set piece per site (Jezero gets the "welcome to Jezero" brief, Gale gets a Curiosity-era observation). Stored as a plain string array in `hologram.js`.

**Trigger**
- Proximity: when any unit (ground or airborne) comes within `15m` of `lab.stationPos`, and the hologram has not been seen this session (session flag, not localStorage), start the dialog.
- Proximity re-triggers after a cooldown (30s).
- Menu replay: new line in the `SCIENCE` section: `▶ ARIANA HOLOGRAM`.

**Tripo asset needed:** `ariana-hologram.glb` — female humanoid, upright pose, ~2.6m tall. No audio dependency (text only dialog; the existing Ariana-speaks music tracks are unrelated).

### Dependencies
- `lab.js` exports `stationPos` (already done — intro.js uses it)
- `hud.js` gains a `playHologramScript(lines, onDone)` method for the cyclic-toast pattern
- Menu gains a hologram-replay entry

---

## 2. Recon Scan Mission

### What
A new mission type that turns the recon drone's height advantage into a gameplay objective: survey a designated terrain patch by flying over it.

### Implementation

**New mission config (missions.js)**
Add a `survey` mission to `MISSIONS` in missions.js:

```js
survey: {
    id: 'survey',
    title: 'SURVEY — AERIAL RECONNAISSANCE',
    steps: [
        { type: 'action', id: 'swtich-recon', text: 'SWITCH TO THE RECON DRONE (TAB)' },
        { type: 'survey', id: 'scan-zone', text: 'SCAN THE DESIGNATED ZONE', target: 0.65 },
        { type: 'action', id: 'return', text: 'RETURN TO BASE' },
    ],
},
```

The `survey` step type already exists in `missions.js` — it takes an `advance(id, value)` call with a scalar progress value and completes when `value >= target`.

**Zone visual (fog.js or a new overlay)**
- A translucent teal circle on the terrain mesh marking the survey zone, visible only when the survey mission is active. Size: ~200m radius circle.
- **Optional GLB**: a survey-mark beacon at the zone center (`survey-beacon.glb` — a small tripod with a flashing emitter, <1m footprint). Procedural fallback: a glowing teal cylinder with a pulsing emissive material.
- Position: a fixed location relative to a named feature (e.g., "Séítah dune margin").
- Bright teal dashed ring on the fog minimap (new `extras.survey` layer).

**Progress measurement**
The recon drone already reveals fog (`fog.reveal()` called per-frame in main.js for `recon.position`). Progress = fraction of grid cells revealed within the target zone. `fog.js` already tracks a 2D grid of revealed cells. Add a method:

```js
fog.revealedFraction(cx, cz, radius)  // returns 0..1
```

**Call site**
In the render loop, when the survey mission is active and the active unit is recon:

```js
if (missions.currentAny()?.step.id === 'scan-zone') {
    const f = fog.revealedFraction(zoneX, zoneZ, zoneR);
    missions.advance('scan-zone', f);
}
```

**Gate on Jezero only** (add `'survey'` to `jezero.missions` in `sites.js`). The tutorial remains the autostart; the survey appears as a second mission in the MENU once the tutorial is complete.

### Dependencies
- `fog.js` — needs `revealedFraction(cx, cz, radius)` method
- `sites.js` — add `'survey'` to Jezero's `missions` array
- `main.js` — add the per-frame progress call (guarded by mission activity check)
- Fog minimap — add `extras.survey` layer (teal dashed ring)

---

## 3. Humanoid Tether

### What
A visual + mechanical tether between the humanoid and its mother ship (the rover or the nearest base). The tether communicates the practical reality of real EVA safety tethers without a full physics constraint.

### Implementation

**No new module** — small addition to `humanoid.js` + a visual in `effects.js`.

**Tether mechanics**
- The tether anchor is the nearest base (chargepad position) or the rover, whichever is closer and within `TETHER_LENGTH` (80m).
- While within range, the tether is cosmetic only: no pull force, no constraint.
- If the humanoid drifts beyond `TETHER_LENGTH`, a soft speed limit applies: max speed falls from `WALK_SPEED` to `WALK_SPEED * 0.3` as a function of overage. This reads as "the tether is taut, you're dragging it" without a physics simulation.
- No hard cutoff — the player can still move, just more slowly. The HUD shows a `⚠ TETHER TAUT` warning.
- If no anchor exists (no bases built, rover too far), no tether renders at all.

**Visual (effects.js)**
- A `THREE.Line` with `THREE.LineBasicMaterial` in cyan-teal with a dash pattern (`LineDashedMaterial`) connecting the humanoid to its anchor.
- Curve: a simple catenary approximation (two-segment quadratic bezier from humanoid shoulder to anchor, drooping down slightly in the middle).
- Rebuilt every frame (anchor and humanoid both move). A Line with `geometry.setFromPoints()` — Three.js handles the GPU buffer upload.

**UI**
- HUD adds a tether-status indicator next to the humanoid's name/charge when a tether is active: `⛓ TETHER` + distance/range.
- The `⚠ TETHER TAUT` warning appears in the banner slot when the speed limit kicks in.

**No new assets, no new module** — ~30 lines net across `humanoid.js`, `effects.js`, `hud.js`.

### Edge cases
- Teleport (`travelTo`) auto-detaches (set tether to null) — the humanoid arrives at the new base and re-anchors there.
- Switching units: tether visual persists (it is the humanoid's tether), but the warning only shows when humanoid is active.
- Rover drives away: anchor moves, tether stretches visually; if rover exits range entirely, tether disappears and anchor falls back to the nearest base.

---

## 4. Repair Shop (base-building upgrade)

### What
A VISIBLE structure — a "repair shop" bay at each base — that is the in-world explanation for the dock-based repair that already works. Right now, repairing at a chargepad is invisible magic: your hull goes up with no visual or narrative explanation. The repair shop makes it diegetic.

### Implementation

**New module: none** — add to `outposts.js` as a new structure kind.

**Structure definition**
- A small workshop bay added beside each chargepad (checkpost/HQ/lab).
- GLB model: generate via Tripo — an open-fronted workshop shelter with tools/equipment visible inside. Model key: `repair-bay.glb`. Footprint ~6m wide, ~4m deep.
- Procedural fallback: a half-cylinder arch made from `THREE.CylinderGeometry` halved + roof panel — similar pattern to outpost fallbacks. Color: warm amber `#d6862e` (distinct from checkpost cyan, HQ teal, chargepad gray) — reads as a workshop.
- Add to `STATIC_MODELS` in `models.js` alongside the other structures.

**Lifecycle**
- Built automatically alongside each chargepad — one bay per base.
- `construct()` method in outposts.js follows the same pattern as checkpost/HQ: flattest-of-8, procedural shell, `attachStaticModel` for the future GLB swap.
- Name plate: `REPAIR BAY` (reusing `makeLabel` from outposts.js).
- No new completion gate — any base that has a chargepad gets the bay.

**Gameplay impact**
- None (repair already works at all chargepads). The shop is PURE visual — it makes existing mechanics diegetic.
- Future hook: could host a repair-cost resource (e.g., consumes 10% battery to repair hull), but that is scope for a later wave — ship the visual first.

**Minimap**
- New `extras.repair` layer: small orange triangle at each bay position, above fog.

### Dependencies
- `outposts.js` — `construct()` takes an optional `kind` param (or we just extend the `onBuilt` callback)
- `chargepad.js` — the loop that fires `onBuilt` also calls a new `buildRepairBay()` on `outposts`
- `models.js` — add `'repair-bay'` to `STATIC_MODELS` (future GLB slot; no-op until asset exists)
- `fog.js` minimap — add `extras.repair` layer (orange triangle)

---

## Tripo GLB assets needed

| Model key | For | Footprint | Priority |
|---|---|---|---|
| `ariana-hologram.glb` | Ariana hologram character | ~1.2m (person) | High — core visual |
| `repair-bay.glb` | Repair shop shelter at each base | ~6m × 4m | Medium — procedural fallback acceptable |
| `survey-beacon.glb` | Recon scan mission zone marker | ~0.8m | Low — procedural fallback acceptable |

All three follow the existing `STATIC_MODELS` / `attachStaticModel` pipeline. Generate after code is merged, not before.

## Sequencing & sizing

All four are independent — no ordering constraints. They can be built and committed in any order.

| Item | New modules | Lines changed | GLB need | Risk |
|---|---|---|---|---|
| Recon scan | 0 | ~80 | Low (beacon optional) | Low |
| Humanoid tether | 0 | ~50 | None | Low |
| Ariana hologram | `hologram.js` | ~150 | `ariana-hologram.glb` | Medium |
| Repair shop | 0 | ~40 | `repair-bay.glb` | Low |

Implementation order: recon scan → tether → repair shop → hologram.
