# Mobile Responsiveness & Performance Audit — Orbit / Space-Track

Audit date: 2026-07-28
Scope: public/orbit/, public/spacetrack/, public/orbit-engine/

> **Status: ALL RESOLVED 2026-07-28.** Every item below (H1–H3, M1–M6, L1–L7) is
> fixed and covered by `mobile_gate()` in `tests/e2e/test_orbit.py`, which runs
> in its own 390×844 / DPR-3 context because none of this is observable from the
> desktop gates — which is exactly why it rotted unnoticed until this audit.
>
> **One finding was wrong on its premise and is corrected in place: see H1.**
> Cesium does *not* render at `devicePixelRatio` by default. Measured on an
> emulated DPR-3 phone, a 375×812 CSS canvas has a **375×812** drawing buffer —
> an effective ratio of **1.0, not 3.0** — because `useBrowserRecommendedResolution`
> already defaults to `true`. There was no 9× pixel bill to remove. The fix that
> shipped is therefore a *guard* (pin the flag so a future default change or a
> well-meant "crisper globe" edit cannot silently triple fragment cost) plus the
> saving that genuinely was available: drawing *below* CSS resolution on phones.
>
> Two fixes also needed a second pass, both worth recording:
> - The first attempt at M1/M6 put its overrides in the main mobile media block,
>   but `.refresh-btn`, `.source-btn` and `.source-row__label` are declared
>   *after* that block in `orbit.css` — so at equal specificity the base rules
>   won and `.refresh-btn` stayed 26px. Their mobile sizing now lives in a
>   trailing block, after the rules it overrides.
> - H2 uses `calc(base + inset)`, **not** the `max(px, env(…))` the audit
>   suggested. These panels are stacked chips at deliberately distinct offsets;
>   `max()` collapses the gap between two of them as soon as an inset exceeds the
>   smaller offset, putting one panel's toggle back underneath another's body —
>   the precise failure the stack exists to prevent. Adding shifts the whole
>   stack inward and preserves the spacing, and is a no-op at zero.

## What Exists (good foundation)

| Feature | Status | Details |
|---|---|---|
| Viewport meta | ✅ | `width=device-width, initial-scale=1.0, viewport-fit=cover` |
| Single-panel-open discipline | ✅ | One HUD panel at a time on mobile; `body.hud-panel-open` hides collapsed chips |
| Full-width bottom panels | ✅ | Signal, Results, Conjunctions expand edge-to-edge |
| Internal scroll capping | ✅ | `max-height: calc(100vh - offset)` + `overflow-y: auto` on all panel bodies |
| Font/padding reduction | ✅ | 600px and 480px breakpoints reduce sizes |
| Overscroll containment | ✅ | `overscroll-behavior: contain` prevents pull-to-refresh |
| ARIA toggle states | ✅ | `aria-expanded`, `aria-controls` on all HUD toggles |
| Cesium double-click off | ✅ | `LEFT_DOUBLE_CLICK` disabled |

---

## HIGH severity

### H1 — No Cesium resolution scaling — ✅ FIXED, **premise corrected**
- **Files:** `orbit-engine/sat-engine.js` (`tuneViewerForDevice`), called by both pages
- **The stated problem was not real.** Measured at `devicePixelRatio: 3`, a 375×812
  CSS canvas had a 375×812 drawing buffer — ratio **1.0**. Cesium's
  `useBrowserRecommendedResolution` defaults to `true`, which explicitly ignores
  `devicePixelRatio`; there was never a 9× pixel cost. Note this also means the
  audit's suggested fix (`resolutionScale = 1/dpr`) would have made things
  *worse*: it would have dropped the buffer to a third of CSS resolution on top
  of a ratio that was already 1.0.
- **What shipped instead, in two parts:**
  1. **A guard.** `useBrowserRecommendedResolution` is now pinned `true` rather
     than left to a default. Flipping it (or a future default change) triples
     fragment cost on every phone silently — that is the risk worth closing.
  2. **The real saving.** `resolutionScale: 0.85` below 600px, i.e. drawing
     *below* CSS resolution. ~28% less fragment work, imperceptible at arm's
     length on a ~5" screen. Re-applied on breakpoint change, so a rotation
     re-tunes it.
- **Sibling precedent** (`rocket-lab`, `moon-colony`, `game-v2`) is Three.js
  `setPixelRatio`, which has no `useBrowserRecommendedResolution` equivalent —
  the analogy does not carry, which is how the wrong premise got in.

### H2 — No safe-area-inset-* — ✅ FIXED
- **Files:** `orbit.css`, `spacetrack.css`
- **Problem:** Every HUD panel, topbar, footer uses hardcoded pixel values (e.g. `top: 24px`, `bottom: 8px`, `right: 16px`). On notched phones, content sits behind the dynamic island / camera cutout / home indicator.
- **Impact:** Content is obscured on every modern phone.
- **Fixed with `calc(base + inset)`, not `max()`** — see the note at the top of
  this file. Four `--sa-*` custom properties on `:root`; 16 rules in `orbit.css`
  and 29 in `spacetrack.css` now compute their offsets from them. The topbar is
  the exception: it keeps `top/left/right: 0` and insets its *padding* instead,
  so its gradient still runs under the status bar rather than leaving a bright
  strip of globe above it.
- **Sibling precedent:** `mars-colony/style.css` uses `env(safe-area-inset-*)` in 53 places (e.g. `top: max(12px, env(safe-area-inset-top))`).

### H3 — No requestRenderMode / targetFrameRate — ✅ FIXED
- **Files:** Cesium viewer config in both pages
- **Problem:** Cesium renders every frame continuously even when nothing animates. On mobile this wastes GPU and drains battery.
- **Fixed** in `tuneViewerForDevice()`: `requestRenderMode: true` plus
  `maximumRenderTimeChange: 30` as a clock backstop so the day/night terminator
  keeps up on a page with no satellites. `SatEngine.requestRender()` is called
  from all six paths that change the scene — worker positions applied, the
  synchronous fallback, the pulse animation, add/remove satellite, and an orbit
  ring arriving asynchronously from a path job. A still camera now draws at the
  ~4 fps of the propagation tick instead of 60.
- **This is the one fix that can fail silently and badly**: miss a
  `requestRender()` and the globe simply freezes. The E2E counts `postRender`
  events over 4s on both pages and fails at zero.

---

## MEDIUM severity

### M1 — Touch targets below 44×44px — ✅ FIXED
- **Files:** `spacetrack.css:118,180,241`, `orbit.css:567,710,681`
- **Elements:**
  - `.st-btn`: padding 6px 8px → ~22×29px
  - `.st-result`: padding 4px 2px → ~20×25px
  - `.st-feed__item`: padding 4px 2px → ~18×25px
  - `.sat-detail-close`: 20×20px
  - `.refresh-btn`: 26×26px
  - `.source-btn`: padding 4px 8px
- **Minimum:** 44×44px (Apple HIG), 48×48px (Material Design)
- **Fixed.** Buttons, result rows, feed rows, inputs, selects, layer checkboxes
  and the HUD toggles all reach 44px at the mobile breakpoint. `.refresh-btn`,
  `.source-btn` and `.source-row__label` needed a *trailing* media block because
  their base rules are declared after the main one — see the note at the top.

### M2 — Touch-action not set on Cesium container — ✅ FIXED
- **File:** `index.html:29`
- **Problem:** No `touch-action: none` on `#cesium-container`. Browser defaults (pull-to-refresh, double-tap zoom, swipe-back) can interfere with Cesium's gesture handling.
- **Fixed:** `touch-action: none` on `#cesium-container`, so Cesium's own
  pointer handlers own the gesture instead of competing with pull-to-refresh,
  double-tap zoom and edge swipe-back.
- **Sibling precedent:** `mars-colony/style.css:10`, `moon-colony/style.css:10` both set `touch-action: none`.

### M3 — Sticky hover on touch — ✅ FIXED
- **File:** `spacetrack.css:127,186`
- **Problem:** `:hover` styles on `.st-btn`, `.st-result` apply unconditionally. On touch, first tap shows hover state, second tap triggers click.
- **Fixed:** all five `:hover` rules in `orbit.css` and three in `spacetrack.css`
  are behind `@media (hover: hover)`. `.st-result` also gained an `:active`
  state, so touch still gets press feedback — the point was never to remove the
  feedback, only to stop it sticking.

### M4 — No tap highlight suppression — ✅ FIXED
- **File:** `spacetrack.css`, `orbit.css`
- **Problem:** iOS Safari shows default grey flash/highlight on tap.
- **Fixed:** set on both page bodies.
- **Sibling precedent:** `rocket-lab/style.css:35`, `music/css/base.css:47`

### M5 — No resize/orientation listener — ✅ FIXED
- **Files:** `spacetrack.js:73`, `orbital-relay.js:56`
- **Problem:** `matchMedia('(max-width: 600px)').matches` is evaluated once at click time. Rotating the phone mid-session produces stale layout until the next panel toggle.
- **Fixed:** one long-lived `MOBILE_MQ` per page with a `change` listener.
  Crossing the breakpoint re-applies the single-panel rule and re-tunes the
  render resolution. The listener matters more than it looks: rotating to
  landscape with a panel open used to leave `body.hud-panel-open` set on a wide
  layout, and that class HIDES the other collapsed chips — so their toggles
  vanished with nothing left to bring them back.

### M6 — Font sizes too small for mobile — ✅ FIXED
- **File:** `spacetrack.css:62,69,116,145,205`
- **Problem:** Labels at 0.5rem (8px), meta at 0.53rem (8.5px), hints at 0.56rem (9px). iOS auto-zooms into fields with sub-16px text, causing unwanted zoom on filter focus.
- **Fix:** Set a minimum font size of 11–12px for readable text within the mobile `@media` block. Consider bumping form input font size above 16px to prevent iOS auto-zoom on focus.

---

## LOW severity

### L1 — No user-select: none on HUD panels — ✅ FIXED
- **File:** `spacetrack.css`
- **Problem:** Long-press on HUD text triggers text selection on a data dashboard.
- **Fix:** Add `user-select: none` to panel bodies.

### L2 — Slider thumb too small (12px) — ✅ FIXED
- **File:** `orbit.css:437`
- **Problem:** Starlink density slider `::-webkit-slider-thumb` is 12×12px.
- **Fix:** Bump to 28×28px minimum for touch.

### L3 — No mobile keyboard hints — ✅ FIXED
- **File:** `index.html:107`
- **Problem:** Search input lacks `enterkeyhint="search"` and `autocorrect="off"`. NORAD ID searches may get autocorrected.
- **Fix:** Add `autocorrect="off"` and `enterkeyhint="search"` to the search input.

### L4 — backdrop-filter perf cost — ✅ FIXED
- **File:** `orbit.css:41`
- **Problem:** `backdrop-filter: blur(16px)` on every HUD panel. 16px blur is expensive on mobile GPUs.
- **Fix:** Consider reducing blur radius to 8px on mobile, or gating the blur entirely on low-end devices.

### L5 — Focus ring removed on buttons — ✅ FIXED
- **File:** `spacetrack.css:128,139`
- **Problem:** `:focus-visible` only changes background color with no visible outline.
- **Fix:** Add a `box-shadow` or `outline` for keyboard/switch-access focus indication.

### L6 — Source order not mobile-first — ✅ FIXED
- **File:** `index.html` DOM order
- **Problem:** HUD controls appear before branding in source order. A screen-reader user tabs through 5 HUD toggles before reaching the RELAY link.
- **Fix:** Move `.orbital-topbar` and branding above HUD panels in the DOM (their `position: fixed` visual layout is unchanged).

### L7 — No orientation media queries — ✅ FIXED
- **Files:** `orbit.css`, `spacetrack.css`
- **Problem:** No landscape/portrait adaptation. Landscape phones (812–932px wide) don't trigger the 600px mobile breakpoint, so use desktop layout. Workable but not tuned.

---

## Patterns Already in Sibling Projects (not leveraged by orbit/spacetrack)

| Pattern | Where | Orbit/Space-Track |
|---|---|---|
| `env(safe-area-inset-*)` | `mars-colony/style.css` (53×), `moon-colony/style.css` (10×) | ✅ via 4 `--sa-*` vars, 45 rules across both sheets |
| `touch-action: none` | `mars-colony/style.css:10`, `moon-colony/style.css:10` | ✅ on `#cesium-container` |
| `renderer.setPixelRatio(Math.min(dpr, 2))` | `rocket-lab/js/scene.js:27`, `moon-colony/js/main.js:106` | ✅ Cesium equivalent — but see H1: the analogy misleads, Cesium already caps at CSS resolution |
| `-webkit-tap-highlight-color: transparent` | `rocket-lab/style.css:35`, `music/css/base.css:47,215,368` | ✅ on both page bodies |
| `resize` listener | `rocket-lab/js/scene.js:103`, `game-v2/src/main.js:143`, `moon-colony/js/main.js:308` | ✅ a `MediaQueryList` `change` listener, which is the narrower signal this layout actually depends on |
| `@media (orientation: ...)` | `mars-colony/style.css:123,146,461,1521` | ✅ landscape block keyed on `max-height`, the axis that binds |
| `inputmode` / `enterkeyhint` | `mars-colony/gamepad.html` | ✅ `enterkeyhint="search"` + `autocorrect/autocapitalize=off` on the catalog search |

---

## Resolution

All 16 findings fixed 2026-07-28. Files touched:

| File | What changed |
|---|---|
| `public/orbit-engine/sat-engine.js` | `tuneViewerForDevice()` (H1, H3) + `requestRender()` wired into all six scene-changing paths |
| `public/orbit/orbit.css` | `--sa-*` vars, `--hud-blur`, touch targets, hover guards, focus rings, 28px slider thumb, landscape block, trailing mobile block for late-declared components |
| `public/spacetrack/spacetrack.css` | Same treatment for the catalog panels; result rows reflow to two lines on narrow screens instead of ellipsing |
| `public/orbit/orbital-relay.js`, `public/spacetrack/spacetrack.js` | `MOBILE_MQ` + `change` listener, `collapsePanel()` extracted, `tuneViewerForDevice()` call |
| `public/orbit/index.html`, `public/spacetrack/index.html` | Topbar moved to the top of the DOM (L6); search input keyboard hints (L3) |
| `tests/e2e/test_orbit.py` | `mobile_gate()` — 30 assertions in a 390×844 / DPR-3 context, all passing |

**What is worth remembering, beyond the fixes:**

1. **An audit finding is a hypothesis, not a fact.** H1's premise was wrong, and
   its suggested fix would have made the page worse. Measuring the actual
   drawing-buffer size took one browser call and changed the work entirely.
2. **`max()` is the wrong safe-area idiom for a stacked layout.** It silently
   collapses the spacing that keeps one panel's toggle clear of another's body.
3. **CSS cascade order beats specificity reasoning.** Overrides written into the
   "obvious" mobile block lost to base rules declared later in the same file, and
   the only reason it was caught is that the browser check measured the element
   rather than trusting the rule.
4. **`requestRenderMode` fails silently and totally.** Nothing in a normal test
   run notices a frozen globe. Counting `postRender` events is the assertion that
   makes the optimisation safe to keep.
