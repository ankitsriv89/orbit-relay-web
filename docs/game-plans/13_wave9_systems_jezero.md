# Wave 9 — New gameplay & systems (Mars Colony)

Built 2026-07-13/14 from the playtest follow-up plan (17 items, 3 waves:
bugs → systems → layout). Wave 8 (bugs) shipped first; Wave 10 (HUD
reshuffle) is next and deliberately last, so it can lay out around the
elements this wave adds.

Source items: #5 (charging), #7 (rover damage), #17 (gravity), #6 (base
markers/travel), #11 (GPS/comms), #9 (Mars clock), #12 (night vision),
#10 (next-step guidance).

---

## As built

| # | Item | Commit | Shipped |
|---|---|---|---|
| 9.1 | Solar chargepads at every base | `fc1e4c7` | Park **on** a pad to charge fast and **without the daylight gate** — the station runs its own battery bank. That gate is the entire point of docking rather than just landing. |
| 9.2 | Rover hull damage, distinct from the battery | `e71d6ac` | Charge is spent and refilled; HULL only ever goes **down** in the field and the one way back up is parking at a base. Boulder strike / washboard wear / rollover. |
| 9.9 | Mars gravity (3.72 m/s², 0.38 g) | `c7e776c` | The sim's first real vertical physics. Drone free-fall on power loss, humanoid SPACE jump (apex 1.53 m, hang 1.79 s), rover cliff-fall + bump airtime. |
| 9.3 | Base name plates + travel-to menu | `516ce52` | Billboard plates over each structure, camera-range-scaled; BASES menu with live ranges; TRAVEL lands you **on the base's chargepad** — you arrive docked, charging, repairing. |
| 9.4 | GPS wayfinding + relay antennas | `fd4f5b5` | `comms.js`: compass-rim ticks (absolute bearing) + GPS RELAY card (steer angles); a relay mast at every base as the in-world justification. |
| 9.6 | Mars clock | `4e5edab` | `mars-clock.js`: sol number + local time-of-sol, read off the sun the sim already moves. Noon **is** the sun's apex by construction. |
| 9.7 | Night vision | `c73237b` | Image intensifier as a CSS filter on the canvas, with daylight-driven automatic gain control. |
| 9.8 | Next-step guidance | `f67ae9d` | Every completed mission step now names itself and previews the next, in its own banner slot. |

Not built this wave (options-only by design, per the plan's 9.5): #2 Ariana
hologram, #3 recon scan/sensor mission track, #4 humanoid tether, #8 repair
shop/mechanic. A concrete pick happens in a follow-up conversation.

---

## Decisions worth remembering

**Ambient solar was never broken (Wave 8 diagnosis, 9.1 fix).** `daylight()`
is *exactly* 0 for ~37 % of the sol, and a landed unit has load = 0 (no
drain) **and** solar = 0 (no recharge). A drone that flattened its battery
after dusk was stranded at 0 % with no recovery path until sunrise. The bug
report said "charging is stopped"; the actual defect was a missing recovery
path, not a broken rate.

**TRAVEL arrives on the chargepad, not at the structure.** Landing on the pad
means travel, charging and repair all pay off at once, and the three Wave 9
systems reinforce each other instead of sitting side by side.

**`teleport()` had to be added to all three units.** After 9.9 a bare
position write is no longer sufficient: the rover's gravity integrator holds
an *absolute* body height, so it would arrive mid-fall from the old terrain.

**Two bearing conventions, on purpose (9.4).** The compass dial is north-up,
so its ticks carry *absolute* bearings; the GPS card's arrows are steer
angles *off the nose*, like the existing TGT arrow. Each matches the frame of
reference of the readout it sits in.

**The Mars clock is a display, not a second time system (9.6).** The sim's sol
is compressed (40 real minutes). Simulating the true 24 h 39 m sol would
desync from the sun you can see and leave two clocks disagreeing. Instead the
card reads the one phase `environment.js` already advances — so it can never
contradict the sky — and anchors the sol *number* to the real mission (sol
1918 for Perseverance today, +1 per in-game sol played).

**`contrast()` silently defeated night vision (9.7).** The first filter chain
included `contrast(1.15)`, which maps `v → (v − 0.5)·c + 0.5` — a lifted night
pixel (0.067) lands back at 0.002, blacker than it started. Every DOM
assertion passed while the screen stayed black. Only a pixel measurement
caught it. **Lesson: for a visual feature, assert on pixels, not on computed
style.**

**Night vision needs automatic gain control.** A gain that makes a 12/255
night navigable (10×) blows a daylight frame to white. `--nv-gain` is driven
from `env.daylight()` — which is what a real intensifier tube does anyway.

---

## Verification

Each item was driven in headless Chromium (the `verify` skill) before its
commit. Totals: 9.3 → 24/24, 9.4 → 32/32, 9.6 → 27/27, 9.7 → 28/28,
9.8 → 38/38.

Checks that earned their keep (measured, not asserted-by-eye):

- **9.3** — TRAVEL moved the rover 641 m to **0.00 m** from the pad centre,
  docked, with charge *and* hull both climbing and no residual fall state; a
  drone at 13.5 m AGL arrived at 14.8 m.
- **9.4** — bearings against ground truth: a target due east reads **090**,
  due north **000**, due west **270**; `rel = abs − nose` to 0.6°.
- **9.6** — swept the phase through a full sol against the real sun vector:
  apex reads **12:xx**, nadir **00:xx**, every full-sun hour in 06–18 and
  every dark hour in 20–04; one full cycle bumps the sol by exactly 1.
- **9.7** — a real night frame through the live filter chain:
  **R12 G6 B4 → R32 G78 B22**; daylight clips 1.9 % of pixels.
- **9.8** — each step's preview is *verbatim* what the objective banner then
  settles on; guidance and build toast coexist without overlap.

---

## Follow-ups for Wave 10 (HUD reshuffle)

1. **GPS RELAY card has no mobile home.** Desktop-only today — the phone rails
   are full (minimap → compass → gear → drone board) and the dial ticks carry
   it there. Wave 10's reshuffle should find it a slot.
2. **NV button is desktop-only in the top bar.** Measured at 390 px the bar
   already runs to 335 px of the 366 px available; a fifth button pushed SFX
   off screen. Phones use the menu toggle. Same reshuffle should give it a
   proper home.
3. **Compass stays right-docked.** Plan 9.4 called for moving it left, but
   that would land it on the mobile telemetry card today. It should travel
   with the minimap in 10.3, not before.
4. **Name plates on the FIELD LAB.** Only earned structures carry plates; the
   lab is a base too (it heads the BASES list) but has no plate.
5. **9.5's B-items remain unpicked** — Ariana, recon scan track, humanoid
   tether, repair shop.
