# Plan 41 — Live audit bug log (2026-08-17)

Findings from driving the **live** site (rotate, zoom, toggle every layer, open
every panel) rather than only loading it, plus the deploy-pipeline discovery
that came out of trying to ship the fixes.

Sections 1–5 are **fixed, pushed, and verified live**. Section 6 is **open** —
that is where the next session starts.

Tooling added this session (all committed):

| Path | What |
|---|---|
| `tests/e2e/test_live_visual.py` | Drives one route: rotate/zoom/click the globe, toggle layers, open panels/tabs, run compute buttons. Records **screenshots per step + a `.webm` video** into `tests/e2e/artifacts/<route>/`. |
| `tests/e2e/run_parallel.py` | Shards the above across processes. **11 routes in ~105 s wall vs ~360 s serial** on this 16-core box. `--jobs 4` (GPU-bound past that). |
| `tests/e2e/test_live_audit.py` | Cheaper static pass: nav/brand/logo integrity, ticker placeholders, horizontal scroll. |

Run against either target:

```bash
py -3 tests/e2e/run_parallel.py --jobs 4 https://orbitalrelay.space
py -3 tests/e2e/run_parallel.py --jobs 4 http://127.0.0.1:8931   # cd public && py -3 -m http.server 8931
```

`tests/e2e/artifacts/` is gitignored — regenerated per run.

---

## 1. Cesium stopped rendering — error dialog over the globe ✅ FIXED

**Commit** `d854262b` · `/orbit/`, `/starlink/`, `/constellations/`

A dialog reading *"An error occurred while rendering. Rendering has stopped.
RangeError: Failed to set the 'length' property on 'Array': Invalid array
length"* painted over the globe. Cesium halts the render loop on an uncaught
throw inside it.

`unpackPositions(xyz, count)` did `new Array(count)` on a value taken straight
off a worker `postMessage`. `new Array(n)` throws `RangeError` for `NaN`,
negative, fractional and out-of-range `n` — reproduced exactly in Node. Two
sources:

1. `propagate.worker.js` `path()` gave up on an unparseable TLE with
   `postMessage({type:'path', job, count: 0})` — **no `xyz`**, so the main
   thread read `undefined`.
2. `period = periodMin || (2π)/rec.no` is `Infinity` when a malformed/decayed
   element set leaves `rec.no` at 0 → every sample date `Invalid Date` → `NaN`
   into the vertex count.

Fixed at both ends; `count` is now sanitised and clamped to what the buffer can
supply. Guardrail `workers/orbit-ingest/test/path-unpack.test.mjs` (15 checks)
was written first and **watched go red at 5/14 against the old code**.

## 2. The camera went to NaN and the globe vanished ✅ FIXED (worked around)

**Commit** `d854262b` · same three routes · **upstream CesiumJS 1.113 bug**

Reproducible on production in four steps: load → drag to rotate → put the
cursor over the globe → scroll. `camera.position`/`direction`/`up` and
`positionCartographic.height` all go `NaN`. Nothing is thrown; the globe just
disappears.

Isolated by elimination — wheel *without* a preceding drag is fine, wheel over
*empty space* is fine, `camera.zoomIn()` is fine. Only "drag, then wheel whose
pick ray hits the globe" fails. **No controller knob avoids it**
(`enableCollisionDetection`, `depthTestAgainstTerrain`, the zoom-distance
clamps), so it cannot be configured away, and pinning a patched Cesium is out of
scope for a no-build-step frontend.

`guardCameraAgainstNaN()` restores the last finite camera in `preUpdate` —
before corruption reaches a rendered frame — then **re-applies the zoom toward
the globe centre**, so the gesture reads as "it zoomed and recentred" rather
than "it stuck". `flyToSats()` also no longer feeds non-finite positions to
`BoundingSphere.fromPoints`.

> Worth revisiting whether a newer CesiumJS fixes this upstream; the guard can
> then be deleted rather than carried forever.

## 3. `/orbit/` opened almost empty — "TRACKING 1 ACTIVE SATELLITES" ✅ FIXED

**Commit** `d854262b`

Every layer checkbox rendered unchecked and nothing checked one at boot, so the
*cinematic* route showed the ISS alone. The count was arithmetically correct
(`1 ISS + 0 visible stations + 0 layers`) and still read as broken.

`layers.js` gains `on:`; `bootDefaultLayers()` fetches those (GPS, IRIDIUM,
STATIONS) with `fly:false` so three layers resolving out of order cannot fight
`introFlyIn()` for the camera. **Boots at 119 now.**

## 4. Stars rendered as big blurry blobs, differently per machine ✅ FIXED

**Commit** `d854262b`

A skyBox face spans 90°, so a 512 px face was magnified **~3.0× at 900p and
~4.9× at 1440p** — which is why it looked different on different monitors. Star
radii were *pixel* constants, so a 2.7 px core shipped as an **8–13 px blob**
and the 22×22 glow rect as a **67–107 px square** (visible square edges in the
before-screenshots).

Radii are now a fraction of the face (same apparent size at any texture size)
and recalibrated so the brightest core lands near **one screen pixel**; default
face 512 → 2048, `starCount` 600 → 2400. 5 new checks in `starfield.test.mjs`,
**3 of which went red first** (radii scaled 0.25× per doubling; 4.87×
magnification at 1440p).

## 5. The globe was soft on every high-DPI display ✅ FIXED

**Commit** `d854262b`

`useBrowserRecommendedResolution = true` pins the canvas to **CSS** pixels, so a
1.5–2× display rendered the globe at 1× and let the compositor upscale it —
sharp Ion tiles fetched and thrown away. This is the "blurry on all machines"
report, and it is independent of §4.

Desktop now draws at `devicePixelRatio`, capped at 2. **The mobile path is
deliberately unchanged** (`0.85`, browser-recommended) — that comment's
reasoning about phone fill rate is sound and still applies. Verified:
`resolutionScale` 2 at dpr 2, 0.85 at 390/412 px.

## 6. 🔴 OPEN — Cloudflare Pages deploys were failing silently

**Commit** `d05c2eec` fixed the *build*. What remains is a **decision**, below.

`[[unsafe.bindings]]` (the rate-limit binding, added in `28c9b049`) is a
Workers-only escape hatch that **Pages rejects** — and because `wrangler.toml`
sets `pages_build_output_dir`, the Pages build parses and validates the file.

**Every deploy from `28c9b049` onward failed**, and nothing surfaced it:

- `ci` stayed green — `ci.yml` only runs `npm test`; **nothing in
  `.github/workflows/` deploys the site** (Pages' own git integration does).
- A failed Pages build keeps serving the **last good deploy**, so production
  looked fine and the local tree looked fine.
- CLAUDE.md's *"wrangler.toml is inert for Pages"* is what made it look safe —
  true of the project **name**, not of the file. Corrected in CLAUDE.md.

### What the next session must decide

**The public API is currently unprotected.** `_ratelimit.js` finds no
`env.API_RATE_LIMITER` and **fails open** — the documented, tested behaviour
("an unconfigured limiter fails OPEN, not closed"), and the deliberate choice
for a limiter that guards *cost* rather than *access*. But the 30 req/min that
`28c9b049` intended **has never actually been live**, because the deploy
carrying it never shipped.

To enable it: **Pages dashboard → Settings → Functions → Bindings**, name
`API_RATE_LIMITER`, type rate limit, **30 / 60 s** to match
`RATE_LIMIT.requestsPerMinute` in `_ratelimit.js`. Do **not** put it back in
`wrangler.toml` — `api-throttle.test.mjs` now fails if it reappears (watched go
red with the bad block restored).

The D1 cost problem `28c9b049` set out to solve is still worth re-measuring
once the deploy is genuinely live, since the edge-cache half of that commit also
only just reached production.

**After any push, confirm the deploy actually shipped:**

```bash
gh api repos/ankitsriv89/orbit-relay-web/commits/<sha>/check-runs \
  --jq '.check_runs[] | "\(.name): \(.conclusion)"'   # want "Cloudflare Pages: success"
```

## 7. 🟡 OPEN — unconfirmed: Earth missing on `/starlink/` + `/constellations/`

Screenshots from the production run show **only stars and HUD at 22,069 KM** on
these two routes, where Earth should fill the view — while `/orbit/` at the same
altitude renders Earth correctly. See
`tests/e2e/artifacts/starlink/01_loaded.png`.

**Not yet root-caused, and the evidence conflicts:**

- `/starlink/` and `/constellations/` build their Viewer with **no `baseLayer`**,
  unlike `/orbit/`, which passes one explicitly with an ArcGIS fallback and
  carries a comment about a silent Ion 403 leaving "a black ball that read as
  'globe not rendering'".
- **But** a direct probe reports `imageryLayers` `ready: true`, `show: true`,
  `alpha: 1`, `globeShow: true` on all four globe routes, with no 4xx responses —
  so the provider is *not* obviously failing.
- `tilesLoaded: false` on every route at probe time, including the ones that
  render Earth fine, so that flag alone proves nothing.

Most likely a camera-framing/timing artifact of the test (the suite's 6-step
zoom can push past the globe) rather than a product defect — the `01_loaded`
frame argues against that, which is exactly why it needs a deliberate look
rather than a guess. **Next step:** screenshot these two routes at boot with no
interaction at all, at several altitudes, and compare against `/orbit/`; if Earth
is genuinely absent, give them the same explicit `baseLayer` + ArcGIS fallback
`/orbit/` already has.

## 8. 🟡 OPEN — pre-existing, unrelated to this session

`tests/e2e/test_mobile_dom.py` expects **5** `key-hud` panels on `/spacetrack/`;
the markup has had **3** (`catalog-hud`, `filters-hud`, `results-hud`).
Confirmed against a clean tree with this session's changes stashed, so it is a
stale expectation, not a regression. Left alone deliberately — correcting it is
a separate call about which is wrong, the test or the page.

---

## Verified after the fixes

- `npm test` green, including the 2 new suites (15 + 5 checks).
- **11/11 routes clean** against local; against production the only failures are
  §7's two routes.
- No console errors, no page-level horizontal scroll at 390 / 412 / 820 / 1133 /
  1400.
- Mobile `resolutionScale` still 0.85; 119 satellites at every viewport.
- All fixes confirmed present in the deployed assets on `orbitalrelay.space`.

## Tickers — live and current ✅

Checked against production on 2026-08-17. All carry the required
`X-Data-Source` citation.

| Endpoint | `generated_at` | Age |
|---|---|---|
| `/api/decay-watch` | `2026-08-17T00:33Z` | ~14 h |
| `/api/boxscore` | `2026-08-16T17:49Z` | ~24 h (daily ingest) |
| `/api/brief` | `2026-08-16T17:50Z` | ~24 h (daily ingest) |

Landing-page ticker values (32,257 tracked / 10,282 debris) match the API. No
placeholder/`NaN`/`—` tickers on any route. `orbit-ingest` scheduled runs are
succeeding.
