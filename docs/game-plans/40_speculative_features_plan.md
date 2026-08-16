# Speculative Features Plan — Scoping, Not Yet a Build Plan

*Written 2026-08-17, companion to
[39_signal_and_search_polish_plan.md](39_signal_and_search_polish_plan.md). That plan
covers the gap-analysis items buildable on data and code this repo already has. This
document covers the remaining seven — every one of them needs either a new upstream data
source Space-Track/CelesTrak don't provide, new persistent storage this repo has never
needed before, or a genuinely new algorithm with no existing test corpus to validate
against.*

**This is not a ready task list like `39_TODO.md`.** Each section below ends in an open
decision, not a "Build" checklist — the point of this document is to force those
decisions into writing *before* a session starts implementing, rather than discovering
them halfway through. Do not start coding against this plan without first resolving that
item's open decision, ideally with the user.

---

## Why these seven are different in kind, not just harder

Plan 39's five tasks all follow the same shape: existing D1 column or existing pure
function → new UI or new derived view → `npm test` catches a regression. Every item here
breaks that shape in one of three ways:

| # | Feature | Breaks the shape because |
|---|---|---|
| 1 | Launch countdowns | No upstream source at all — Space-Track/CelesTrak only carry objects already in orbit, never a pre-launch manifest |
| 2 | Sensor swaths | No sensor-pointing data (FOV, off-nadir angle) exists anywhere upstream or in this repo |
| 3 | Camera FOV (satellite payload sense) | Same blocker as #2 — not a Space-Track/CelesTrak concept |
| 4 | Maneuver detection | No TLE-epoch history is stored (`objects` is overwritten per ingest) — needs new storage *and* a new algorithm |
| 5 | Orbital decay-rate modeling | Data exists (`BSTAR`, `MEAN_MOTION_DOT`) but the model itself is new maths, unvalidated against anything in this repo today |
| 6 | AI mission summaries (per-satellite) | Reuses a working pattern (`brief.js`) but at ~28k objects the cost/ops shape is a different problem than one daily card |
| 7 | Terrestrial weather overlay | Needs a second data provider with its own citation, and collides with an existing `weather` layer *group* label |

Each section below gives the grounding, the real blocker, and the specific question that
needs an answer before this becomes a `40_TODO.md`.

---

## 1. Launch countdowns

**Grounding:** no code anywhere in `workers/orbit-ingest/src/spacetrack.js` (or
anywhere else) fetches pre-launch schedule data. Space-Track and CelesTrak are both
strictly post-launch catalogs — an object doesn't exist in either until it's tracked in
orbit. There is no analog to extend.

**Open decision:** this needs a **second external provider** (e.g. Launch Library 2,
RocketLaunch.live, SpaceDevs) with its own rate limits, its own citation requirement, and
its own reliability profile independent of the Space-Track/CelesTrak pipeline this repo
is built around. That is a bigger commitment than "add a fetch call" — it's a second data
dependency the ingest worker, the `X-Data-Source` citation convention, and `/about/`'s
data-sources copy all need to account for.

**Question for the user:** is a second upstream provider in scope at all, or should this
feature be dropped from the target spec? If in scope: which provider, and what's the
acceptable behavior when it's unavailable (this repo's existing pattern — degrade with a
`stale`/`.st-hint` flag, never fail the page — would apply, but only once a provider is
chosen).

---

## 2 & 3. Sensor swaths / satellite payload camera FOV

**Grounding:** `footprintRadiusM`/`addFootprint`
([astro.js:65](../../public/orbit-engine/astro.js#L65),
[sat-engine.js:829](../../public/orbit-engine/sat-engine.js#L829)) already compute a
nadir horizon-circle footprint — geometrically correct for "how far can this satellite
see straight down," geometrically **wrong** for a directional imaging swath, which needs
a sensor field-of-view angle and (for many EO satellites) an off-nadir pointing angle
that changes per-image, not per-orbit. No TLE or GP element set encodes sensor pointing —
it is fundamentally payload-specific information Space-Track has no reason to carry.

**Note:** if "camera FOV" in the original spec item (#11 in the numbered spec, distinct
from the "Advanced Features" list's implied satellite-sensor sense) actually meant **the
site's own Cesium viewer camera frustum** — a debug/cinematic visualization of what the
user's virtual camera can see, not a satellite's payload — that reading has **no upstream
blocker at all**: `viewer.camera.frustum` is pure Cesium state, already in the scene
graph. That version belongs in plan 39, not here, if it's what was meant.

**Open decision:** two separable questions —
1. Is "camera FOV" the viewer's own camera (cheap, move to plan 39) or a satellite's
   onboard sensor (blocked on #2's data gap)?
2. For sensor swaths specifically: would a **small, hand-maintained dataset** for a
   handful of well-known EO satellites (Landsat, Sentinel, a dozen others with published
   swath widths) be acceptable, in the same spirit as this repo's existing
   `launch_sites` static reference table? That trades "no real data" for "real data for a
   curated few, silently absent for the rest" — which needs the same "wrong is worse than
   absent" discipline CLAUDE.md already applies to `operator` and site-name derivation.

---

## 4. Maneuver detection

**Grounding:** `objects` is a mirror of the *current* GP element set per NORAD ID —
each daily ingest overwrites the row (`updated_at` tracks freshness, not history). There
is no table storing successive TLEs per object over time, and `events.kind` only knows
`new_object`/`decay`/`reentry_predicted`/`satcat_change` — no `orbit_change`. Detecting a
maneuver means diffing orbital elements across epochs, which requires the epoch history
to exist in the first place.

**This needs new storage before it can need new logic.** A `tle_history` table
(`NORAD_CAT_ID`, `EPOCH`, the orbital elements, keyed and retained for some window) would
have to land first, as its own ingest change, independent of whether the detection
algorithm ever gets built.

**Open decision:** is the storage cost/retention window (how many epochs per object, for
how long, across ~28k objects) worth it for a feature with no existing validation
corpus — i.e., no known list of "these are real maneuvers that happened" to test a
detector's precision/recall against? Compare to how the conjunction screener earned trust
(injected-propagator unit tests against closed-form analytic orbits, per CLAUDE.md's
invariants) — a maneuver detector needs an equivalent grounding story, not just "diff two
epochs and flag a delta over some threshold," or it risks the exact failure mode
CLAUDE.md warns about for the conjunction gate: a tuned threshold that misses real events
silently and looks exactly like "nothing happened."

---

## 5. Orbital decay-rate predictions (BSTAR-based)

**Grounding:** distinct from the existing `decay` table, which holds Space-Track's own
60-day reentry *messages* (`ingest-decay.js`, `source: '60day_msg'`) — those are
Space-Track's authoritative predictions, already ingested, already surfaced. This item is
a **from-scratch estimate**, computed client- or ingest-side from `BSTAR` /
`MEAN_MOTION_DOT` / `MEAN_MOTION_DDOT` (already-ingested columns,
[`d1/orbit.sql:52-54`](../../d1/orbit.sql#L52-L54)) for objects Space-Track hasn't yet
issued a 60-day message for.

**The data exists; the model doesn't.** This is genuinely new orbital mechanics — an
altitude-decay-rate estimate from drag-related element derivatives — analogous in risk
profile to the conjunction screener's maths, which is explicitly called out in CLAUDE.md
as "the one place in this repo where the maths is genuinely proven" (via injected
closed-form propagator tests). A decay estimate shipped without equivalent rigor risks
presenting a guess as a prediction next to Space-Track's actual authoritative one — a
credibility problem for the whole page, not just this feature.

**Open decision:** is it acceptable to ship this **only** for objects with no existing
60-day message (clearly labeled "unofficial estimate," distinct styling from the
Space-Track-sourced prediction), so it never contradicts or duplicates an authoritative
figure? And: what's the actual decay model (simple exponential atmospheric density model
vs. something more rigorous) — this needs a specific formula sourced and cited before any
code, the same way `AURORA_OVAL_OFFSET_DEG` and the aurora oval maths were pinned by
tests against NOAA's published table before being trusted (plan 34 §3.4 C2).

---

## 6. AI-generated mission summaries (per-satellite)

**Grounding:** `workers/orbit-ingest/src/brief.js` is a proven pattern — facts pulled
from SQL, a narrative generated once daily, `checkNarrative()`'s numeral-guard rejecting
any sentence with a figure absent from the facts (CLAUDE.md: "including a correct one the
model derived... indistinguishable from invention"), an `ORBIT_AI_CARDS` env gate, and a
swappable provider. `dossier.js`'s `open()` is the natural render hook for a per-object
version.

**The blocker is scale, not pattern.** The daily Brief generates **one** card per day.
A per-satellite summary multiplies that by up to ~28k tracked objects. Two shapes, very
different cost/ops stories:
- **Generate on-demand, on dossier open, uncached** — no storage cost, but a
  user-visible generation latency on every dossier open, and it reintroduces exactly the
  risk `brief.js`'s header explicitly warns against for a different reason: **no D1
  fallback, deliberately**, because "rebuilding the card on a read would pair fresh facts
  with a sentence checked against older ones." A per-open generation is always fresh
  facts, so that specific risk doesn't apply the same way — but a live LLM call inside a
  UI interaction the user is actively waiting on is a different UX risk this repo hasn't
  taken anywhere else.
- **Precompute for a subset (e.g. only debris-family-notable or high-profile objects) in
  the daily/weekly batch** — bounded cost, but re-introduces a caching question:
  regenerate on every ingest (cost scales with subset size × daily cadence) or only when
  the underlying facts materially change?

**Open decision:** on-demand-uncached vs. precomputed-subset, and if precomputed, what
selects the subset (an explicit allowlist? "top N by RCS/notability"?). This is a product
decision as much as a technical one — it determines whether this ships for every object
or a curated few, which changes what the feature promises the user.

---

## 7. Terrestrial weather overlay

**Grounding:** `public/orbit/layers.js`'s `LAYERS` registry already has a `weather`
**group** — but it's CelesTrak's GP group of *weather satellites* (payload objects), not
a cloud/precipitation tile layer. A literal terrestrial-weather overlay (clouds, storms,
precipitation) would either need a second `weather`-adjacent label (confusing) or a
rename of the existing group (a user-facing change to an existing, working layer, for a
feature that doesn't exist yet — sequence that carefully if it happens).

**Also:** this needs a genuinely new upstream provider (e.g. OpenWeatherMap tile
layers, RainViewer) — Space-Track and CelesTrak carry zero terrestrial-weather data.
Distinct from the *space* weather layer (`space_weather` D1 table, NOAA SWPC, already
shipped per plan 34 §3.4) — that one is real orbital-environment data (Kp index, aurora
ovals) already fully wired; this would be an unrelated Earth-surface imagery layer with
its own attribution story.

**Open decision:** is a terrestrial weather tile layer actually part of the product
vision, or was it implied by "Weather overlays" in the spec's Advanced Features list
meaning something closer to what space weather (plan 34 §3.4) already covers? If a real
terrestrial layer is wanted: which provider (rate limits, attribution, tile format), and
does the existing `weather` layer-group label need renaming first to avoid the
namespace collision.

---

## Suggested sequencing, once decisions land

None of these seven should be scheduled into a `40_TODO.md` until its open decision above
is answered. Rough ordering by how self-contained the eventual answer is likely to be:

1. **Camera FOV, viewer-camera reading** — if that's the intended meaning, this has zero
   blockers and should move to plan 39, not stay here.
2. **AI mission summaries** — smallest true "new work" once the subset-vs-on-demand
   question is answered; reuses `brief.js`'s pattern almost entirely.
3. **Terrestrial weather** — bounded scope (a tile layer + attribution line) once a
   provider is picked; the layer-group naming collision is a one-line fix.
4. **Orbital decay-rate modeling, sensor swaths (curated-dataset version), launch
   countdowns** — each needs an external commitment (a cited model, a hand-maintained
   dataset, a second provider) before code starts.
5. **Maneuver detection** — the largest lift (new storage + new unvalidated algorithm);
   should be last regardless of decision order, and probably deserves its own dedicated
   scoping plan rather than a task list, the way the conjunction screener originally did.
