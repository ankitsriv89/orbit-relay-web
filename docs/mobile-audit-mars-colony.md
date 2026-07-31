# Mars Colony — Mobile Responsiveness Audit

Date: 2026-07-28. Scope: `public/mars-colony/` (style.css, index.html, js/hud.js,
js/touch.js, js/main.js, js/camera.js, js/missions.js, js/hub.js).

Method: static code audit + headless Playwright E2E
(`.claude/skills/verify/mobile_e2e.py`, touch-emulated contexts) across
10 viewport/orientation configurations. All coordinates below are real
measurements from the running game, not CSS reading.

## E2E confirmation matrix

| Viewport | Rotate prompt | Top bar | HUD overlaps | Notes |
|---|---|---|---|---|
| 375×667 portrait | shown ✓ | fits exactly | none | |
| 390×844 portrait | shown ✓ | fits exactly | none | iPhone 13 emulated = same |
| 412×915 portrait | shown ✓ | fits exactly | none | |
| 844×390 landscape | hidden ✓ | fits | none | GPS card OK |
| 915×412 landscape | hidden ✓ | fits | none | |
| 768×1024 iPad portrait | **shown (wrong)** | fits | none | see M2 |
| 1024×768 iPad landscape | hidden ✓ | fits | none | |
| **320×568 portrait** | shown ✓ | **overflows 2px** | **minimap × telemetry 54×142px** | C1, C2 |
| **568×320 landscape** | hidden ✓ | fits | **inventory × top-bar; dronectl clipped** | C3, C4 |
| 390×844 no-touch (hybrid) | hidden | **overflows 417>366** | — | M4 |

Passed checks: joystick zones visible/anchored correctly, right stick
auto-hides for ground units and appears for drones, dronectl collapsed
chip (58×32) does not overlap the right rail on ≥390px-wide screens,
vignette has `pointer-events: none`, canvas matches viewport, landscape
GPS card does not collide with the minimap.

---

## Critical issues (broken gameplay / unreadable HUD)

### C1. Minimap × telemetry overlap at ≤360px portrait width
Measured at 320×568: telemetry card `(12,70) 208×218`, minimap
`(166,70) 142×142` → **54×142px overlap**. The telemetry card's real
rendered width is 208px (`max-width:186px` + 20px padding + 2px border),
so it clears the minimap by exactly 1px at 375px and collides below that.
Fix options: shrink telemetry `max-width` (e.g. 150px) under 380px, scale
the minimap with `vmin` (see M6), or auto-collapse telemetry below a
width threshold (the collapse toggle already exists, `mc-tele`).

### C2. Top-bar SFX button clipped at 320px
Measured: children span 322px in a 320px viewport
(`switch@12+71, unit@95+58, menu@165+58, music@235+28, sfx@276+46`).
Only ~2px, but the border-radius is cut. Fix: reduce `.mars-hud__top`
`gap` 12px→8px and button padding one more step under 360px, or drop the
♪ button into the menu at that width (NV precedent).

### C3. Inventory lands on the top bar in short landscape (<700px wide)
Measured at 568×320: inventory at `(8,10) 74×44` — overlapping the top
bar's SWITCH UNIT button `(12,12)`. Cause: the landscape inventory rule
(`style.css:1521`) requires `min-width:700px`, so at 568px the *portrait*
coarse rule applies: `bottom: calc(min(45vw,260px) + 10px)` = 265px from
the bottom of a 320px-tall screen → y=10. The formula assumes portrait
heights. Fix: key the lift on `orientation: portrait`, or clamp
`bottom` to `calc(100vh - 60px)` minimum clearance from the top bar.

### C4. Drone-control chip clipped below viewport in short landscape
Measured at 568×320: dronectl chip at `(498,310) 58×32` → bottom 342 >
320. The right rail stack (minimap 70→212, compass 218→264, gear
272→302, dronectl 310→342) was designed for ≥390px-tall landscape.
Fix: make rail offsets proportional (`top: min(310px, calc(100vh - 44px))`
for dronectl; same guard for gear), or hide the chip behind the fold at
`max-height: 359px`.

### C5. Canvas lacks `touch-action: none` — browser gestures can fire mid-game
`#mc-canvas` never sets `touch-action`. `html,body` has
`touch-action: none` (style.css:10) which covers most cases, but the
canvas is the gesture target for orbit/pinch — pull-to-refresh and
edge-swipe navigation remain possible on some Android browsers because
the orbit handler only calls `setPointerCapture`, never `preventDefault`
on `touchstart`. One-line CSS fix on `#mc-canvas` (and `#hub-canvas`
already has it — align them).

---

## Moderate issues

### M1. Tutorial/mission text references keyboard keys on touch devices
`missions.js:47-50`: "PRESS E TO COLLECT", "PRESS TAB TO SWITCH",
"PRESS E TO SLING/DELIVER" — meaningless on a phone (verified in the
320px screenshot: steps 3-5 unreadable-by-design). Fix: at mission
render time, swap key names for touch verbs when
`isTouchDevice()` (e.g. "TAP COLLECT", "TAP SWITCH UNIT"). The CONTROLS
menu section is similarly keyboard-first.

### M2. Rotate prompt forces landscape on iPad portrait
Media query `(orientation: portrait) and (pointer: coarse) and
(max-width: 899px)` (style.css:146) matches 768px iPad portrait, where
the game has plenty of room (verified: no overlaps at 768×1024). Fix:
tighten to `max-width: 700px`, or drop the width condition and use
`max-aspect-ratio` instead.

### M3. Rotate prompt (z-40) overlays the tutorial overview (z-20)
First-boot portrait: the START MISSION button sits dimmed under the
rotate overlay and is untappable until the device rotates. Probably
intended (input block is the point), but the tutorial card should either
defer until first landscape frame or the prompt should be fully opaque —
the half-visible card reads as a rendering bug.

### M4. Top bar overflows on narrow *fine-pointer* windows (hybrid laptops)
At 390px wide with `pointer: fine` (touchscreen laptop / narrow desktop
window), desktop-size buttons span 417px — SFX is pushed off-screen.
The coarse-pointer compacting never applies because it keys on pointer
type, not width. Fix: apply the compact button rules at
`max-width: 599px` regardless of pointer.

### M5. No `visualViewport` resize handling (iOS Safari chrome)
`main.js:1030-1034` and `hub.js:553-558` resize on
`window.innerWidth/innerHeight`. iOS Safari's address-bar show/hide
changes the visual viewport without a reliable `resize` event — canvas
and HUD safe-area math go stale until the next orientation change.
Fix: also listen to `window.visualViewport?.addEventListener('resize')`.

### M6. Minimap is 44% of viewport width at 320px
Fixed 140×142px. Scale it: `width: clamp(96px, 30vmin, 140px)` (and
matching height) — also helps C1.

### M7. Menu panel is full-bleed on phones, not the intended 24px gutters
`.mars-menu__panel` uses `width: calc(100vw - 48px)` +
`padding: 24px 28px` with default `box-sizing: content-box` → rendered
width = 100vw + 10px, clamped to the screen edge (measured x=0, w=full
viewport at 320/375/390/412px). Fix: `box-sizing: border-box` on the
panel. Also add `padding-bottom: env(safe-area-inset-bottom)` so the
last menu item clears the iPhone home indicator.

### M8. `screen.orientation.lock('landscape')` never succeeds on iOS Safari
`main.js:1781` — the API is fullscreen-gated on iOS and the call is not
preceded by a fullscreen request, so it silently rejects 100% of the
time there. Either request fullscreen first (see E2 below) or accept the
CSS prompt as the only path and delete the dead code.

### M9. No momentum scrolling on iOS for overflow panels
`.mars-menu__panel`, `.mars-hud__music`, `.mars-hud__inventory` use
`overflow-y: auto` without `-webkit-overflow-scrolling: touch` —
one-finger scroll is janky on iOS Safari.

### M10. Sub-44px touch targets
Measured: dronectl fold chip 58×**32**, music ♪ button 28px wide,
telemetry collapse ~30px, dossier chip 34px. WCAG/platform guidance is
≥44px. These are all secondary affordances, but the dronectl chip is the
only way to expand flight controls on a phone — give it `min-height: 40px`.

---

## Minor issues

- **m1.** Joystick throw radius hardcoded at 44px (touch.js:47) — doesn't
  scale with the 144–260px zones; cramped on large phones.
- **m2.** `isTouchDevice()` is evaluated once at boot; hot-plugging input
  devices mid-session doesn't re-evaluate.
- **m3.** No `webglcontextrestored` listener — context loss is reported
  to telemetry but the page never recovers (needs reload).
- **m4.** Double-tap camera reset (camera.js:49, 300ms) races the
  browser's double-tap zoom where `touch-action` isn't `manipulation`
  on buttons (body's `none` mostly covers this).
- **m5.** Landscape inventory sits at `left: 228px` — 8px gap from the
  telemetry card's real 220px edge; any safe-area inset shift on the
  left closes it.
- **m6.** Telemetry card overlaps the *visual* area of the left joystick
  zone in landscape (touch passes through — `pointer-events: none` — but
  the resting pad renders under the card).
- **m7.** `#mc-alt-slider` uses `writing-mode: vertical-lr` for the
  vertical range input — inconsistent rendering on older Android WebViews.

---

## Gameplay enhancement suggestions (mobile-first)

1. **Fullscreen on first gesture (E2).** One `document.documentElement
   .requestFullscreen()` inside the first `pointerdown` handler hides
   the browser chrome and unlocks `orientation.lock` on iOS — the two
   biggest mobile UX wins for one API call. Add a menu toggle to exit.
2. **Wake Lock.** `navigator.wakeLock.request('screen')` on boot (re-
   request on visibilitychange) — a 40-min sol cycle dies if the screen
   sleeps mid-drive.
3. **Haptics.** `navigator.vibrate(10-30ms)` on collect, sling attach,
   delivery, rock lift, low-battery warning, and collision thumps (the
   van already has a bump event queue — perfect hook). Cheap, high
   game-feel value on phones.
4. **Adaptive quality step-down.** Detect sustained <20fps (the
   telemetry module already counts frames) and drop `pixelRatio` 2→1.5
   and/or `clipQuads` one notch, with a menu note. Battery + thermal
   matter more on phones than pixels.
5. **One-hand reach mode.** Optional mirrored layout: SWITCH UNIT and
   MENU move to the bottom-right thumb arc (over the look zone, which is
   hidden for ground units anyway). Currently every management action is
   top-of-screen — two-hand territory on ≥6.5" phones.
6. **Tilt-steering option for the rover.** DeviceOrientationEvent gamma
   → steer, with the stick still throttle. Real rover-driving games do
   this well; gate behind a menu toggle + one-time permission prompt
   (iOS 13+ requires `requestPermission`).
7. **Persist per-orientation HUD collapse prefs separately.** Today
   `mc-tele`/`mc-dronectl` collapse state is one flag — a player who
   collapses in landscape gets a collapsed card in portrait where there
   was room.
8. **Landscape-first onboarding.** First touch boot starts with the
   rotate prompt over the tutorial card (M3). Instead, defer the
   tutorial overview until the first landscape frame — one less
   dead-end screen for new players.
9. **Sticky COLLECT/action button.** The action prompt floats
   bottom-center (good), but Makadane's LIFT ROCK and DANCE stack at
   fixed px offsets from the bottom — convert to the same
   `env(safe-area-inset-bottom)` + stack-above-prompt pattern so they
   never drift under the gesture bar.
10. **`prefers-reduced-motion`.** Skip the landing-drop cinematic and
    hub globe auto-spin for users who ask for it at OS level.
11. **Offline-first check.** The game is already fully local (vendored
    three.js, local assets) — verify the PWA manifest actually enables
    install-to-homescreen offline play; that is the natural mobile form
    factor for this game and mostly already built.

---

## Suggested fix order

1. C3 + C4 (short-landscape rail/inventory math — one CSS media-block fix)
2. C1 (minimap/telemetry overlap — vmin minimap or narrower telemetry)
3. M1 (touch verb swap in mission text — small JS change, huge first-run win)
4. M4 (compact top bar by width, not pointer type) + C2 (gap/padding step)
5. M3 + E8 (defer tutorial card until first landscape frame)
6. M5 (visualViewport listener) + C5 (touch-action on canvas)
7. M2 (rotate prompt width cap 700px) + M7 (border-box menu panel)
8. E1 (fullscreen) + E2 (wake lock) + E3 (haptics) — the mobile feel trio

## Reproducing

```bash
cd standalone/public && python3 -m http.server 8931 &
cd standalone && python3 -u .claude/skills/verify/mobile_e2e.py
```

Touch-emulated contexts (`is_mobile=True, has_touch=True`,
`device_scale_factor=2`). Measurements above are from Jezero boot with
the tutorial card dismissed; dronectl readings taken after switching to
the recon drone. Screenshot evidence: 320px portrait run captured the
rotate-prompt-over-tutorial layering (M3) and keyboard-key mission text
(M1).
