# Plan 31 — Roadmap truth-up + a portable engine spec that outlives this repo

**Date:** 2026-07-26
**Status:** built (docs only)
**Touches:** `docs/game-plans/08_multi_planet_colony_roadmap.md` (rewritten in
place); new `docs/mars-sim-engine-spec.md`.

---

## Why

Two problems, one root cause — the multi-planet roadmap stopped tracking reality.

1. **Doc 08 is a year-of-work stale.** Written 2026-07-11, it describes Mars
   Colony as a *"rover/drone/on-foot sample-collection loop."* Since then plans
   09–30 shipped: seven switchable units plus a companion robot, a shared N-leg
   walker rig, hazards/weather, derived base-building, mission chains, a 3D globe
   site-hub with per-site saves + BYOC cloud sync, telemetry, a from-scratch
   procedural music/dance system, and — as of plan 30 — six more Mars sites,
   taking Mars from 2 playable to 8. Anyone reading doc 08 to plan the Moon would
   badly under-scope the work.
2. **The engine only exists as code.** "Mars Sim is the base for every planetary
   object — only the data, physics and gameplay change per body" is true, but it
   lives nowhere except `public/mars-colony/js/`. There's no artifact that lets
   someone rebuild any of it on another machine, or hand a subsystem to a coding
   agent cold, without this repo checked out.

## Part A — Doc 08 rewritten in place

Kept: the Tier 1–4 data tiering and the Phase A–F sequencing. Both still hold —
the research they rest on (NASA data quality per body, competitive gap analysis)
hasn't changed.

Corrected:

- **New "What the engine actually is today" section** — the real unit roster
  (rover, recon drone, lift drone, humanoid, van, Gratbot quad, Makadane octopod,
  + ONGAK companion) and the real subsystem list, each pointing at the spec doc
  for detail.
- **The fork-point gap, recorded not decided.** "Moon forks Mars's engine"
  (Phase A) was decided when the fork was ~a quarter of today's codebase.
  `public/moon-colony/` still has only the Phase A subset — no missions, hazards,
  base-building, hub/saves, walkers, music, telemetry. Phase B now needs an
  explicit **re-fork from current Mars vs. backport the missing systems** call
  before it resumes. Flagged in two places (engine section + Phase B); left
  undecided on purpose — it's a real scope decision, not a doc edit.
- **Site table trued up** — Mars: **8 playable** (Jezero, Gale, Gusev, NE Syrtis,
  Elysium Planitia, Meridiani Planum, Olympus Mons, Hellas Planitia) and
  `LOCKED_SITES = []`, both as of plan 30. Moon: `SITES = {}`, confirmed
  unchanged, still boots to a deliberate "SITES is empty" error. *(The first pass
  of this doc was written against a pre-plan-30 snapshot claiming 2 playable + 3
  locked; caught and corrected by verifying `sites.js` directly rather than
  trusting the summary — worth repeating for any future truth-up.)*
- **Forward links to plan 32** — Phase B's "no hub card until playable" rule and
  Phase F's parked Tier-4 moons both now note how the Solar System Map represents
  them (locked node / two labeled moon-cluster rings), so the map can't drift
  from the roadmap silently.

## Part B — `docs/mars-sim-engine-spec.md` (new)

A spec, explicitly **not** a code dump. Eleven subsystems, each with the same
four-part shape:

| Part | What it answers |
|---|---|
| **Purpose** | why the subsystem exists at all |
| **Shape** | the core data structure / algorithm, in prose — clipmap rings, two-bone analytic IK, derived-not-stored base state |
| **Varies per body** | the actual swap surface: gravity constant, atmosphere density, DEM source, lon/lat — vs. what's body-agnostic |
| **Reproduction prompt** | a self-contained block you can hand an agent with no repo access |

Sections: (1) boot/site config · (2) terrain + environment · (3) physics ·
(4) hazards & weather · (5) ground & aerial vehicles · (6) **legged locomotion
(`walker-rig.js`)** · (7) samples/missions/derived base-building · (8)
site-hub globe + saves + cloud sync · (9) telemetry · (10) companion/music/dance ·
(11) HUD/UX conventions.

Three deliberate choices in how it's written:

- **The reproduction prompts are the point.** Each is phrased as an instruction
  to a builder who has never seen this code — parameterized, no file names, no
  function names. Section 6's is the longest because the walker rig is the most
  reusable and least obvious subsystem.
- **Past bugs are encoded as constraints.** Section 6 carries the three
  hard-won walker fixes as *"avoid this"* rules: the 180° hip-flip from an
  ambiguous IK bend direction, the world-vs-local quaternion mixup when composing
  terrain tilt onto a pose override, and the terrain-tilt smoothing accumulator
  that must recompute-and-lerp rather than integrate onto itself. These cost real
  debugging rounds; a rebuild that doesn't know them will pay for them again.
- **Body-agnostic layers are named as such.** Sections 6–11 are flagged as
  reusable near-as-is, so a new body's real work is visibly concentrated in
  1–5 — which is exactly the "only data and physics change" claim, made concrete.

Closes with a five-step "how to use this for a new body" checklist, ending on the
rule automated tests can't cover: playtest the gravity/traction feel before
shipping.

## Verification

Docs-only change, so verification is consistency, not runtime:

- Engine roster and subsystem list in doc 08 match the actual `public/mars-colony/js/`
  tree (44 modules, catalogued this session).
- Moon's stated state matches `public/moon-colony/js/sites.js` (`SITES = {}`) and
  its README's "NOT LIVE — scaffold only."
- Mars site table matches `public/mars-colony/js/sites.js` — 8 entries in `SITES`,
  `LOCKED_SITES = []`. **Verified by reading `sites.js`, not by trusting a
  summary** (the first draft had this wrong; see Part A).
- `GRAVITY_MARS = 3.72` confirmed in `physics.js`, matching the spec's §3 claim.
- Cross-links resolve: doc 08 ↔ engine spec ↔ plan 32.

## Follow-on

Plan 32 (Solar System Map) consumes the corrected doc 08 as its body/status
source — Mars playable, everything else honestly locked.
