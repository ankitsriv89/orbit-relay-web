# Plan 27 — Ongak music companion, Gratbot rename, Makadane rock handling, van pebble bumps

**Date:** 2026-07-24
**Status:** approved, building
**Touches:** `public/mars-colony/js/` — new `music.js`, `ongak-bot.js`; changed
`rocks.js`, `colliders.js`, `walker-rig.js`, `makadane.js`, `van.js`, `sound.js`,
`camera.js`, `main.js`, `hud.js`, `style.css`; renamed `ongak.js` → `gratbot.js`.

---

## Why

Three asks, one thread — the fleet's specialist units currently stop at the same
wall every other unit stops at, and the quadruped's name (Ongak = 音楽, *music*)
belongs to a machine that doesn't exist yet.

1. **Music.** AI/synth soundtrack the player selects and plays while the sim runs,
   pausable any time.
2. **Makadane earns its eight legs.** It should climb over the hills, pebbles and
   blocks that stop everything else, and pick up / remove blocks.
3. **The van should ride pebbles**, not stop at them — bumps and effects at
   wheel-scale obstacles instead of an invisible wall.

## Naming decision

| Was | Now | Why |
|---|---|---|
| Ongak (quadruped) | **Gratbot** | *Grat* = German for a mountain ridge/arête. The unit is the steep-slope specialist; the name says so. |
| — | **Ongak** (new) | 音楽 = music. The name goes to the machine that makes music. |
| Makadane | Makadane | unchanged |

Second rename for the quadruped (Strider → Ongak in plan 26 → Gratbot here), so
build logs carry three names for one machine. Noted deliberately; the rename ships
as its own commit for a clean revert. Plan-24 telemetry logs unit names, so
analytics history splits at this commit.

## Rejected: Ongak as an eighth switchable unit

The switch cycle is already 7 units. A unit you select but can't usefully drive —
one that only changes tracks — makes the cycle longer and the unit hollow. Ongak is
therefore a **deployable companion outside `units[]`**, with two verbs (FOLLOW /
PARK) and no battery slot of its own.

---

## Wave A1 — `music.js`, the synth engine

Asset-free procedural synthwave, same philosophy as `sound.js` (nothing to
download, nothing that can 404, works offline in the APK).

**Scheduling.** A lookahead scheduler — 25 ms `setInterval` tick, 200 ms schedule
horizon, notes queued on the WebAudio clock. Explicitly *not* driven from the rAF
loop: music must not drift on a frame hitch or stop when the tab throttles.

**Bus.** Shares `sound.js`'s `AudioContext` (one context, one autoplay unlock) but
on its **own gain node straight to `destination`**, bypassing `sound.js`'s `master`.
The SFX toggle must not mute music and the music volume must not touch SFX.

**Layers per track:** sub-bass (saw → lowpass, gain-pumped on the kick),
arpeggiator (pulse → resonant filter with a slow LFO sweep), pad (detuned saw pair,
long attack/release), drums (pitch-swept sine kick, noise-burst snare, filtered hat).

**Presets** — key, BPM, progression and layer mix per track:

| Track | Feel |
|---|---|
| Dust Vigil | slow ambient pads, no drums — the default |
| Red Drift | 92 BPM synthwave, gated pad |
| Olympus Line | 108 BPM driving arp, octave bass |
| Signal Lost | dark Phrygian, half-time, tension |
| Return Vector | Dorian, hopeful |

**Drop-in slots.** The player reads `assets/music/manifest.json`; each entry's `src`
is either `synth:<preset>`, a filename, or an absolute URL. File tracks stream via
`<audio>` → `MediaElementSource` → the same bus (no full-buffer decode). Manifest
missing or 404 → falls back to built-in presets, so the offline APK cannot break.

**The real soundtrack (found during build).** This repo already ships the SIGNAL
music app at `public/music/` with the user's own Suno-generated, lore-matched
catalog on R2 — ORIGIN, *ATHENA's Lullaby*, *ARIANA Speaks* (ARIANA is already an
in-game hologram), *CREON Never Sleeps*, *Red Dust Rising*. R2 serves it with
`Access-Control-Allow-Origin: *`, so those tracks route through the game's own bus
and get the analyser + spatial panner exactly like the synth ones. The player
therefore loads **catalog first, synth presets second** (18 + 5 = 23 tracks). The
synth presets are no longer the headline act — they are the offline floor, and the
per-track error handler falls back to them if a stream fails.

```json
[
  { "id": "dust-vigil", "title": "Dust Vigil",  "src": "synth:vigil" },
  { "id": "olympus",    "title": "Olympus Line", "src": "olympus.mp3" }
]
```

**Controls.** Track list, ▶/⏸, prev/next and volume in a HUD panel; a compact
now-playing chip with a pause button in the M menu so music is controllable from
any unit. Keys: `B` play/pause, `[` `]` prev/next. Playback persists across unit
switches. State in `Prefs`: `mc-music-track`, `mc-music-vol`, `mc-music-on`.

## Wave A2 — `ongak-bot.js`, the companion

Procedural build (no GLB), warm livery to echo the fleet, folding horn array,
emissive ring, underside sub.

- **FOLLOW** — trails the active unit at ~4 m, terrain-hugging, simple seek
  steering with a stop band so it doesn't jitter at rest.
- **PARK** — holds position, keeps playing.
- **Spatial audio** — the music bus routes through a `PannerNode` pinned to the
  bot's world position. Park it at base, drive out, the music fades behind you;
  recall it and it swells back. This is the reason the bot exists rather than a
  checkbox.
- **Beat-reactive** — an `AnalyserNode` drives horn-ring `emissiveIntensity`, and
  the sub kicks an `effects.spawnDust` puff on the downbeat.
- Registered in `colliders` as an obstacle; blob shadow via `effects.addShadow`.
  Not in `units[]`, so `main.js` calls its `update(dt, activeUnitPos)` explicitly
  (ground units other than the van don't self-simulate when inactive).

## Wave C — van pebble ride-over

`rocks.js` currently hard-blocks every ground unit at rock radius ≥ 0.45.
Introduce a **per-unit `climbR`** threshold through
`colliders.forUnit(name, { climbR })`:

- `collides()` ignores rocks below the unit's `climbR`.
- Those same rocks are folded into that unit's `deckHeight()` as a rock top with a
  ramped rim (the existing deck-ramp idiom).

Van gets `climbR ≈ 0.62` (~1.2 m rocks against 0.9 m wheels). Each of the 6 wheel
hubs samples the rock top under its own world position; the six offsets drive
chassis pitch + roll and a critically-damped vertical spring, so a strike jolts the
van and settles over ~0.5 s instead of teleporting it upward. On impact:
`spawnDust` at that wheel, a new filtered-noise thump in `sound.js` scaled by speed
× pebble size, 10–20 % speed scrub, a nudge to the existing `rolloverRisk`, and a
short camera shake (**new** — `camera.js` has none today). Above `climbR` the van
still stops, as now.

`climbR` being one number per unit means the rover can opt in later with one line.

## Wave B — Makadane climb-over + rock handling

**B1 traversal.** Makadane gets `climbR ≈ 1.3` — it steps over everything but
genuine boulders. `walker-rig.js` already calls
`groundAt() = terrain + deckHeight` **per foot**, so feet plant on top of rocks for
free with no rig rewrite. Two additions:

- Body vertical follow is rate-limited and **accumulating** (the Wave 12 smoothing
  landmine — a per-frame lerp toward a moving target never converges), so cresting
  a rock doesn't pop the chassis.
- `swingLift` scales with the height the next footfall must clear, so a clamber
  reads as a clamber.

**B2 pick up / carry / drop / recycle.** Rock identity is `cx:cz:index` from the
deterministic `cellRocks()`. A per-site cleared-set (`Save(siteId)`, so it survives
reload and syncs to Drive) is filtered **inside `cellRocks()`** — one source of
truth, so render and collision stay in lockstep automatically.

- `X` grabs the nearest rock within 2.5 m under a carry-size cap. It clamps under
  the deck, the rim glow goes amber, speed ×0.75.
- The two legs nearest the load leave the gait for a static grip pose. 8 legs → 6
  cycling still guarantees ≥3 planted, so the alternating-tetrapod promise holds.
- `X` again drops it. Dropped rocks join a persisted `placed-rocks` list merged back
  into that cell — real obstacles again.
- Carrying within the lab dock radius, the prompt becomes RECYCLE and the rock is
  consumed permanently.

**Payoff:** cleared boulders stay cleared, so Makadane opens driving corridors the
rover and van could not take. The unit's purpose, made mechanical.

---

## Sequencing

A1 → A2 (+ rename) → C → B. Music is self-contained; C validates the `climbR`
plumbing on the simpler unit before B builds on it. Local commit per wave as a
resume checkpoint. E2E added per wave in `tests/e2e/test_browser.py`. Push and
Cloudflare deploy at the end.

## Risks / open flags

- `B`, `X`, `[`, `]` are unbound today, but the mobile touch layout needs room for
  two new action buttons (music panel, Makadane grab).
- The `AnalyserNode` read is the first per-frame audio work in the game. Negligible
  cost, but it is new.
- Rock top height derives from the instance transform in `rocks.js`
  (`sampleHeight + sy*0.35`, scale `sy` → top ≈ `sampleHeight + sy*1.35`). If that
  placement math changes, `climbR` and `deckHeight` must follow.
