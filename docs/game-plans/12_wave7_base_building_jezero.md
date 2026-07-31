# Wave 7 — Base-building on Jezero (built 2026-07-13)

Approved scope (user decisions, 2026-07-13): checkposts at the **5 real named
samples + Three Forks Depot** (6 total); art = **new Tripo GLBs** (user
generates manually via Tripo web UI — procedural fallback ships first);
unlock = **analysis result alone** per checkpost, plus a **capstone: the
Marsapiens Headquarters** rises once every mission the site offers is
complete.

## Design

Per the Wave 7 idea pass in `05_mars_colony_phase_next.md`: no new subsystem.
Everything is driven by state other modules already persist — there is
deliberately **no new save format**:

- **Checkposts** — a sample carrying `outpost: { name }` in sites.js earns a
  small structure near its marker once its analysis record exists in the
  science archive (`mc-results`, analysis.js). Jezero: rochette, seitah,
  wildcat-ridge, skinner-ridge, cheyava-falls, three-forks.
- **Headquarters** — sites.js `hq: { name }` builds by the FIELD LAB once
  `missions.allComplete()` (missions.js's own `mc-mission-*-done` flags).
- **Persistence is derivation**: `outposts.bootstrap(archive, allComplete)`
  at boot re-builds everything already earned. Archive + mission flags
  survive RESET MISSION, so structures do too — one source of truth, nothing
  to drift.

## As built

- **`js/outposts.js` (new, lab.js-shaped)** — `createOutposts(scene, site,
  terrain, rocks, colliders, labPos)`. Placement = lab.js's
  flattest-of-8-candidates ring idiom: checkposts on a 14 m ring around
  their sample (clear of the collect spot), HQ on a 25 m ring around the lab
  pad with a statics-aware test (`colliders.forUnit('__outpost-build')`
  facade — unregistered names get alt 0, so it sees the station dock + mast).
  Build-in = `group.scale.y` ease-out rise over 3.2 s (grounded-at-y=0 models
  make y-scale read as extrusion). Beacons: faint brand-cyan 24 m columns on
  checkposts, amber-gold 80 m on the HQ (capstone reads apart from every
  teal utility beacon). Colliders: checkpost r 3.4/h 4.5, HQ r 11.5/h 13.
- **models.js** — `STATIC_MODELS.checkpost` (footprint 6) and
  `STATIC_MODELS.hq` (footprint 22), both `doubleSide` + brand finish, GLBs
  at `assets/models/checkpost.glb` / `assets/models/hq.glb` (**pending Tripo
  generation** — fallback-first shells cover offline/missing, station.glb
  pattern).
- **missions.js** — new `allComplete()` (available.length > 0 && every done).
- **main.js** — analysis `onDone(rec)` → `outposts.buildFor(rec.id)`;
  missions `onComplete` → `allComplete()` → `buildHq()`; both toast
  (`⬢ <NAME> ESTABLISHED`) + `sound.built()`. Bootstrap after mission
  autostarts. Loop: `outposts.update(dt)`. Debug: `__mc.outposts`.
- **hud.js** — `toast(text)` (self-hiding 6 s, third slot in the top banner
  stack) + BASE STRUCTURES menu section (`setOutposts`, built ⬢ / locked ◇
  with unlock hints).
- **fog.js** — `extras.outposts` minimap layer above fog: hollow teal
  squares (checkposts), bigger solid teal square (HQ).
- **sound.js** — `built()` ascending major arpeggio.
- **Gale untouched** — no `outpost`/`hq` fields → outposts.js no-ops
  (list() empty keeps the menu's "not charted" hint). This is the Wave 2
  copy-ready pattern.

## Verified (E2E 34/34, 2026-07-13)

Fresh-boot locked state; menu section; checkpost on flagged analysis (scene
node, toast, collider, 14 m ring placement, anim start→finish, fallback
visible, menu row); non-flagged sample builds nothing; HQ on tutorial skip
(ring 25 m, clear of station); minimap teal probes; reload bootstrap
(full-height, no anim, menu state); Gale no-op; no unexpected console
errors. Script: scratchpad `wave7_e2e.py`.

## Follow-ups

- User generates `checkpost.glb` + `hq.glb` via Tripo web UI (cargo/hab
  aesthetic matching station.glb; checkpost small cabin-scale, HQ hab-cluster
  scale). Drop into `public/mars-colony/assets/models/` — no code change
  needed.
- Wave order after this: **Wave 5 (terrain LOD) → Wave 2 (site expansion,
  LAST content wave) → Wave 9 (multiplayer, gated on scoping/cost)**.
