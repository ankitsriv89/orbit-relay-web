# Space-Track Catalog — UI/UX Redesign Report

Date: 2026-07-30  
Deployment: https://da5c9fad.signal-playground-0uj.pages.dev/spacetrack/  

> **HISTORICAL — this design has since been superseded (2026-08-02).** The
> `#menu-toggle` / `#menu-dropdown` topbar dropdown described below no longer
> exists: the tabs became separate routes (`/spacetrack/signal/`,
> `/conjunctions/`, `/brief/`, `/analytics/`) behind the persistent
> `.spacetrack-nav` + `#hamburger-btn` chrome in `public/css/chrome.css`.
> `tests/e2e/test_spacetrack_ui.py` was deleted with it — 8 of its 14 sections
> drove the removed dropdown, and its live concerns are covered by
> `tests/e2e/test_mobile_dom.py` plus the per-route suites. Kept for the
> rationale in "Problems Identified", not as a description of the current UI.

## Problems Identified

The Space-Track catalog page had **five separate floating HUD panels on the right side** (Filters, Signal Feed, Conjunctions, Daily Brief, Analytics), all stacked with hand-measured `bottom: calc()` offsets. This design had fundamental problems:

1. **Overlapping panels** — The 5-panel stack was fragile: each bottom offset was hand-measured (~64px, ~134px, ~204px, ~274px, ~344px) and any CSS change (padding, font-size, touch-target bump) knocked them off, causing chips to overlap and hide each other's toggles. The audit found `#results-hud` sitting exactly on top of `#signal-hud`, making one entirely unreachable on mobile.

2. **Globe obstruction** — On desktop, the 5 panels occupied the entire right half of the screen when expanded, leaving the globe visible only behind the panels.

3. **Slot-mate collapse complexity** — The `data-hud-slot="bottom-right"` system had elaborate slot-mate collapsing logic in JS to prevent overlaps, which itself had bugs.

4. **Mobile UX was a band-aid** — The mobile breakpoint hid collapsed chips when one panel was open (`body.hud-panel-open`), but resize events could strand the page in an incorrect state.

## Changes Made

### 1. Unified dropdown menu (replaces 5 right-side panels)

- **Before**: 5 separate `position: fixed` panels at various bottom offsets on the right side
- **After**: One dropdown panel at `top-right` with a tabbed interface

The dropdown contains 5 tabs:
| Tab | Content |
|-----|---------|
| FILTERS | Search field, object type/country/regime/era/operator selects, RENDER/RESET buttons |
| SIGNAL | Recent events, decay watch, boxscore (loads from API) |
| CONJUNCTIONS | SGP4 close-approach screening with window/threshold controls |
| BRIEF | Daily brief with facts and optional AI narrative |
| ANALYTICS | Launch history bars, debris families, country×decade matrix |

### 2. Tab-based navigation

- Each tab button activates its corresponding section
- Only one section visible at a time
- Active tab highlighted with cyan underline
- Sections scroll independently within the fixed-height dropdown
- Escape key or ✕ button closes the dropdown

### 3. Hamburger menu on mobile (≤600px)

- The dropdown becomes a **full-screen overlay** on mobile
- Tab buttons enlarge for touch targets (≥44px)
- All sections scroll vertically within the overlay
- Close via ✕ button or Escape
- Left-side panels (catalog, results) remain as collapsible HUD chips

### 4. Left-side panels preserved

- `#catalog-hud` (top-left) and `#results-hud` (bottom-left) unchanged
- Toggle behavior and collapse logic preserved
- Catalog summary shows live orbit counts from the API
- Results list renders queried satellites with click-to-dossier

### 5. Bug fix: JS `status` redeclaration

Fixed a `SyntaxError: Identifier 'status' has already been declared` in `spacetrack.js` — the module had both `function status()` and `const status = ...` at the top level, which is illegal in ES module strict mode. The `const` shorthand was removed and the function now handles single-argument calls correctly.

## Files Changed

| File | Changes |
|------|---------|
| `public/spacetrack/index.html` | Added menu toggle button in topbar; replaced 5 right-side HUDs with one `<div id="menu-dropdown">` containing tab navigation and section containers |
| `public/spacetrack/spacetrack.css` | Removed all right-side panel positioning rules (~150 lines); added dropdown menu, tab, hamburger overlay, and responsive mobile styles |
| `public/spacetrack/spacetrack.js` | Replaced `wireHudToggle` for right-side panels with dropdown toggle + tab switching + Escape-to-close logic; fixed `status` function redeclaration; updated `renderBrief` to target `#brief-section` |
| `tests/e2e/test_spacetrack_ui.py` | New test suite (57 assertions) covering dropdown open/close, tab switching, brief visibility, left-side panels, mobile hamburger, touch targets, and text legibility |

## Test Results

Playwright testing could not complete on this environment (SwiftShader/WebGL contention). Manual verification confirmed:
- Page loads and `__spacetrack` engine boots successfully
- Menu toggle button exists in topbar
- Dropdown opens and all 5 tabs switch correctly
- Close button and Escape key dismiss the dropdown
- Left-side panels (catalog, results) toggle correctly
- All API-dependent features degrade gracefully with 404 warnings (expected on static server)

Deployed to production: `signal-playground-0uj.pages.dev/spacetrack/`
