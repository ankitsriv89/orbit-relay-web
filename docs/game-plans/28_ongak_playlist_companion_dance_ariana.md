# Plan 28 — Mars Sim's own playlist, the ONGAK companion rework, Gratbot's dance, and the Ariana briefing

**Date:** 2026-07-25
**Status:** built + E2E-verified (local)
**Touches:** `public/mars-colony/js/` — `music.js`, `ongak.js`, `walker-rig.js`,
`main.js`, `hud.js`, `missions.js`; `public/mars-colony/style.css`;
`public/mars-colony/assets/music/{manifest.json,README.md}`; new
`tests/e2e/test_plan28.py`.

---

## Why

Four asks, one thread — the soundtrack and its companion outgrew plan 27's
shape:

1. **The game should own its music.** Drop the marsapiens / SIGNAL R2 album
   (that queue belongs to the standalone music app) and keep a Mars Sim
   playlist. Keep the synthwave, add more procedural instrumentals.
2. **ONGAK shouldn't trail whatever you drive.** It ships **docked with
   GRATBOT**, and that coupling is what unlocks the dance. You **CALL** it to a
   unit when you want it; **DEPLOY** it to hold and play; it can **parcel**
   small samples to bases.
3. **GRATBOT can dance.** Docked with ONGAK and playing, it performs beat-synced
   moves you drive with keys — a dancing robot.
4. **The first mission is to report to ARIANA for a briefing.**

## 1 — Music: Mars Sim's own playlist (`music.js`)

- **Catalog removed.** `loadCatalog()` and the `CATALOG_URL` R2 fetch are gone;
  the player reads only `assets/music/manifest.json`. Everything shipped is
  rendered live in the browser — zero bytes, offline-safe in the APK.
- **Six new presets** (11 total), each carrying a mood the first five couldn't:

  | Preset | Track | Character |
  |---|---|---|
  | `perihelion` | Perihelion | 88 BPM Dorian, swung breakbeat + lead melody |
  | `ferric` | Ferric | 112 BPM harmonic minor, 16th arp, industrial |
  | `aphelion` | Aphelion | 60 BPM Lydian, no drums, long lead — the only bright one |
  | `regolith` | Regolith Run | 100 BPM pentatonic, tom-led tribal kit |
  | `nightshift` | Night Shift | 74 BPM half-time, heavily swung |
  | `terminator` | Terminator Line | 124 BPM Phrygian dominant, fastest |

- **Three new engine layers** so the new tracks don't all share one timbre:
  a **lead** (slow triangle melody an octave over the arp — the thing that
  makes a track feel *written*), **swing** (pushes offbeat 16ths late), and
  **drumStyle** (`four` default / `break` syncopated / `tribal` tom-led). Four
  new scales: harmonic minor, Phrygian dominant, Lydian, minor pentatonic.
- **Derived beat clock.** `music.beats()` returns elapsed beats as a float,
  computed from the audio clock (not counted per frame) so the dance stays
  locked through frame hitches; re-anchored whenever the scheduler catches up
  after a stall.

## 2 — ONGAK: a bound companion + courier (`ongak.js`, `main.js`, `hud.js`)

The HOST identity lives in `main.js` (it owns the unit list); `ongak.js` only
seeks the point it's handed and holds when deployed.

- **Docked with Gratbot at boot** — `ongakHost = gratbot`, re-seated 2.5 m off
  it once grounded.
- **CALL (C)** — re-hosts to the active unit and un-deploys; teleports in if
  it's >80 m back so it *arrives*, then trails.
- **DEPLOY (O)** — holds position, keeps playing (the panner still fades the
  soundtrack behind you as you drive off). RESUME re-follows the host.
- **PARCEL (J)** — a one-slot cargo cradle. Load the nearest field cache within
  6 m; a laden ONGAK that reaches the field-lab pad **auto-delivers** into the
  analysis queue (the van bulk-deliver idiom, one at a time). A slow courier
  for the sample loop.

## 3 — Gratbot dance (`walker-rig.js`, `main.js`, `hud.js`)

- **Five moves** — BOB, TWO-LEG, SPIN, WAVE, HOP-TWIST — driven by
  `music.beats()`. Most plant every foot at its idle home on the ground and
  move the **body**; the analytic IK bends the legs to keep the feet down,
  which is exactly a robot dancing in place. WAVE lifts front paws alternately.
  **TWO-LEG** rears up on the hind legs like a horse (~38° nose-up): the body
  is **seated on its hind feet** — under the full pose `q`, the body-local
  hind-foot line `L` is put back on the ground via `position = P_world − q·L`.
  Pivoting about the feet (rather than the body centre) is what keeps it out of
  the ground, and since hip↔own-foot distance is a rotation invariant the hind
  legs stay solvable at any rear angle and their plant never slides. The angle
  stays moderate because the terrain-hug tilt **stacks** on it and rearing
  swings the rear-bottom chassis corner down *and* backward — into ground
  rising behind the pivot. The front legs paw from the raised chest.
- **Frames matter here.** The dance composes onto `mesh.quaternion` with a
  post-multiply, so its axes are **body-local** (`_bodyX/Y/Z`) — passing the
  world-space `_fwd`/`_right` inverted the pitch at heading π and turned it
  into a roll at ±π/2. And the dance offset must be composed onto `_baseQ`
  (the smoothing state), never onto `mesh.quaternion` itself, or it re-enters
  its own `slerp` and the angle runs away with framerate. Any body
  displacement is recorded in `_danceOfs` and undone next frame, because
  `mesh.position` is the step integrator's state.
- **Gated** on Gratbot being the active unit, ONGAK docked (host = Gratbot,
  within 7 m), no cargo, and music playing. The frame loop re-checks every
  frame, so driving off / deploying / pausing / calling ONGAK away all end the
  dance cleanly. **K** toggles; **1–5** pick a move.
- Driving overrides the dance (it walks normally); it resumes on release.

## 4 — Report to Ariana (`missions.js`, `main.js`)

The autostart tutorial's first step is now **REPORT TO ARIANA AT THE FIELD LAB
FOR BRIEFING** (title: *FIRST MISSION — REPORT TO ARIANA*). It completes the
instant her hologram dialog triggers on approach (a rising-edge latch on
`hologram.seen`); the briefing then plays as the objective feed, and step 2
(drive to the nearest beacon) follows.

## Keys / HUD

| Key | Action |
|---|---|
| B · [ · ] | play/pause · prev · next track |
| C · O · J | CALL · DEPLOY/RESUME · PARCEL (ONGAK) |
| K · 1–5 | dance toggle · pick move |

Music panel bot-row: a state line (`▶ HOST` / `■ DEPLOYED`, cargo appended) plus
CALL / DEPLOY / PARCEL. A floating **DANCE** button appears only when the dance
is actually available.

## Risks / notes

- `C`, `J`, `K`, `1–5` were unbound; no collisions with existing keys.
- Headless Chrome throttles `setInterval` once the tab is treated as hidden, so
  the E2E timing assertions are short/up-front; the dance is proven
  deterministically off explicit `beats`.
- Renaming the tutorial title splits nothing — the persistence flag
  (`mission-tutorial-done`) is unchanged, so completed runs stay completed.
