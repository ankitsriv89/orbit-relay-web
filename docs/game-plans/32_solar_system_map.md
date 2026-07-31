# Plan 32 — Solar System Map: one landing page for every body on the roadmap

**Date:** 2026-07-26
**Status:** approved, building
**Touches:** new `public/solar-system/` (`index.html`, `style.css`,
`js/{bodies,scene,controls,picking,card,main}.js`, `vendor/three/`, `README.md`);
`public/index.html` (+1 card); `public/hub.css` (+`.card--solar`); new
`tests/e2e/test_plan32.py`.

---

## Why

The multi-planet roadmap (plan 31's rewrite of doc 08) now says clearly what's
playable, what's next, and what's parked — but the player can't see any of it.
Mars Sim is one flat card in a grid of unrelated experiments, and every other
body on the roadmap is invisible until it ships.

A solar-system map fixes that in one move: **the roadmap becomes the UI.** Mars
is the one lit, enterable node; everything else is a real body at its real
orbital position, carrying its real status. It sets the expectation that this is
a *series* of worlds, not a single game — and each future body arrives as a node
lighting up, not a new card appearing.

Framing constraint from the outset: colony sites are expected to move to their
own domain later, so this folder is **fully self-contained** — its own vendored
Three.js, no imports from `mars-colony/`. Pattern reuse only.

## Bodies — sourced from doc 08's tiers, not invented

Four status tiers, mapping 1:1 onto roadmap phases. This is the whole point of
the page: status is *derived from the roadmap*, so the two can't drift.

| Body | AU | Tier | Phase | Status |
|---|---|---|---|---|
| Mercury | 0.387 | 1 | C.3 | PLANNED |
| Venus | 0.723 | 3 | E.1 | PLANNED |
| *Earth* | 1.000 | — | — | *HOME — not a colony target* |
| Moon | (Earth orbit) | 1 | **B** | **IN DEVELOPMENT** |
| **Mars** | 1.524 | 1 | **done** | **PLAYABLE — 8 sites** |
| Vesta | 2.36 | 1 | C.1 | PLANNED |
| Ceres | 2.77 | 1 | C.2 | PLANNED |
| Jovian moons — Io, Europa, Ganymede, Callisto | 5.20 | 4 | F | PARKED |
| Saturnian moons — Enceladus, Rhea, Titan | 9.58 | 4 | F | PARKED |
| Pluto / Charon | 39.5 | 3 | E.2 | PLANNED |

**Only Mars is enterable.** Every other node opens an info card and goes nowhere.

Three deliberate calls, all flagged rather than silent:

- **Moon links nowhere**, despite `public/moon-colony/` existing on disk — its
  `SITES` is empty and it throws at boot by design. It shows **IN DEVELOPMENT**
  (distinct from PLANNED — it has a real scaffold) with no click-through. This
  honors doc 08's standing "no landing-page link until a real site lands" rule.
  Do not "fix" this into a link before Phase B.1–B.3 land.
- **Jupiter and Saturn are not rendered as bodies.** They're gas giants with no
  surface — never colony targets. Their moons appear instead, as two labeled
  cluster rings at the parents' real orbital distances. The rings are labeled
  ("JOVIAN MOONS", "SATURNIAN MOONS"), which conveys the grouping without
  implying the giants themselves are coming.
- **Earth is rendered, as a HOME marker only** — small, neutral, no status pill,
  not pickable as a colony. Rationale: the Moon needs a visible parent or it
  reads as a bug floating at 1 AU. Earth is the one body on this map that's real,
  relevant, and explicitly *not* a target. If this reads as clutter in review,
  cutting it means giving the Moon its own labeled orbital slot instead.

**Bennu and Ryugu are excluded** (Tier 2, Phase D). They're mission-target
asteroids rather than worlds, and their scale on an orbital map is invisible.
Noted here so their absence reads as a decision, not an oversight — revisit if
Phase D gets scheduled.

## Scale — compressed geometry, real numbers in the card

True-to-scale is unusable: Pluto sits 100× Mercury's orbit, and Enceladus is
250 km against Jupiter's 70,000. So:

- **Orbit radii** — hand-tuned spacing, **real ordering strictly preserved**.
  Documented in `bodies.js` as deliberately non-linear.
- **Body sizes** — compressed likewise; relative size *within* a cluster ring
  stays honest (Ganymede reads larger than Europa).
- **Orbital speed** — derived from **real orbital periods**, uniformly
  compressed. So Mercury visibly races and Pluto barely creeps: the relative
  motion is real even though the absolute rate isn't.
- **The card carries the true values** — real semi-major axis in AU, real mean
  radius in km, real orbital period. The compression is a display choice; the
  data stays accurate and visible, consistent with this project's real-NASA-data
  posture everywhere else.

## Scene

- **Sun** at origin — emissive sphere + point light + additive glow sprite.
  Informational only, not navigable.
- **Orbits** — thin ring outlines per body; the two moon-cluster rings get a
  small label sprite.
- **Bodies** — stylized spheres (flat/lambert shaded, procedural colors from real
  albedo character; no textures in v1, so no asset pipeline and no load gate).
  Each revolves along its ring continuously.
- **Starfield** — sparse point cloud on a far shell (technique ported from
  `mars-colony/js/hub.js`).
- **Camera** — drag-orbit + wheel/pinch dolly, unified Pointer Events with a
  movement-distance threshold separating tap from drag (same input idiom as the
  rest of the project; see engine spec §11).
- **Picking** — plain `raycaster.intersectObjects(bodyMeshes)`. Notably *simpler*
  than `hub.js`'s pin picking, which needs an analytic horizon test because its
  pins sit on one occluding sphere; here every body is a separate mesh in open
  space, so the raycaster's own depth sort is correct.
- **Hover** — highlight (scale-up / emissive lift), cursor change.
- **Select** — always opens the info card first; never navigates on first tap.
  Two-step by design, matching `hub.js` — an accidental tap must not launch a
  game.
- **Enter (Mars only)** — card's ENTER button eases the camera toward Mars, fades
  out, disposes the scene, then `location.href = '../mars-colony/'`. Locked nodes
  render no ENTER button at all — not a disabled one.

## Files

Self-contained per the domain-move constraint:

```
public/solar-system/
  index.html          canvas + #ss-card overlay + back-to-hub link + importmap
  style.css           space bg, card, status pills (4 states), labels
  vendor/three/       own copy: three.module.js + three.core.js (both required —
                      three.module.js is a thin re-export of three.core.js)
  js/bodies.js        the data table — the ONLY file a new body touches
  js/scene.js         sun, orbits, body meshes, cluster rings, starfield, revolve
  js/controls.js      drag-orbit + dolly (Pointer Events, tap-vs-drag threshold)
  js/picking.js       raycast + hover/select
  js/card.js          info card DOM: name, status pill, real AU/radius/period, blurb
  js/main.js          wiring, fly-in→dispose→navigate, window.__ss debug handle
  README.md           notes the self-containment + why Moon isn't linked
```

No GLTFLoader, no post-processing addons — v1 needs neither, so only the two core
Three files get vendored (~2.1 MB, matching how `mars-colony/` and `game-v2/`
each carry their own).

`window.__ss` (mirroring `window.__mc`) exposes `bodies`, `pick(id)` and
`selectedId` — added now rather than retrofitted, because E2E needs it to select
a body without pixel-hunting a moving target.

## Hub card

One new card in `public/index.html`, inserted after MARS SIM, **whose own link is
untouched** — Mars stays directly reachable; the map is an additional door, not a
gate:

```html
<a href="solar-system/" class="card card--solar">
    <span class="card__badge card__badge--new">NEW · MAP</span>
    ... svg: sun + two orbit ellipses ...
    <p class="card__tag">SOLAR SYSTEM MAP · THREE.JS</p>
    <h2 class="card__title">SOLAR SYSTEM</h2>
    <p class="card__desc">Every world on the colony roadmap at its real orbital
    position — land on Mars, the one that's playable today, and watch the rest
    light up as they ship.</p>
    <span class="card__cta">EXPLORE →</span>
</a>
```

Plus a `.card--solar` variant in `hub.css` (pale cyan-white accent — unused by
existing variants), following the `.card--v2` / `.card--antimatter` block pattern:
media/tag/cta color, hover border/shadow, `::before` gradient tint.

## E2E — `tests/e2e/test_plan32.py`

Python Playwright against `tests/e2e/serve.py`, per the `verify` skill's rules
(kill stray Chrome first, `?cb=` cache-bust, poll don't sleep, prefer
`page.evaluate` over `page.click` where actionability gates stall):

1. Page boots, zero console errors.
2. `window.__ss.bodies.length` matches the `bodies.js` table.
3. Mars → card opens, ENTER present → activating it lands on `../mars-colony/`.
4. Venus → card opens, status PLANNED, **no ENTER**, URL unchanged.
5. Moon → card opens, status IN DEVELOPMENT, no ENTER, and specifically **never
   reaches `../moon-colony/`** (the regression this page must not introduce).
6. A cluster-ring moon (Europa) → card opens, status PARKED, no ENTER.
7. Mobile 375×812 → canvas fills viewport, card legible and tappable.

## Verification

Serve `public/`, open `/solar-system/`: bodies render at correct relative
ordering, orbits animate at visibly different rates (Mercury fast, Pluto
near-static), drag-orbit and pinch work, Mars fly-in navigates, every locked node
is inert. Then `python3 tests/e2e/test_plan32.py` — targeted only, not the full
suite.

## Follow-on

When a body ships, the change is one `bodies.js` entry (status → `playable`,
add `link`) plus its E2E row. No scene work. That's the property this page is
built for.
