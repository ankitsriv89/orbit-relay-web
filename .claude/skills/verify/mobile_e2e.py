"""Mobile responsiveness E2E for mars-colony.

Drives the game in various viewports and checks for layout bugs,
overlapping HUD elements, touch-zone visibility, and responsive CSS.

Usage:
    cd standalone
    source ~/.nvm/nvm.sh
    python3 .claude/skills/verify/mobile_e2e.py
"""

import time, sys, os, json, math
from pathlib import Path

BASE = 'http://localhost:8931'
POLL_INTERVAL = 1.5
MAX_POLLS = 90

ISSUES = []

def note(category, severity, msg, detail=""):
    ISSUES.append({"category": category, "severity": severity, "msg": msg, "detail": detail})

def px(page, selector):
    return page.evaluate("""(s) => {
        const el = document.querySelector(s);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return null;
        return { w: r.width, h: r.height, x: r.left, y: r.top, r: r.right, b: r.bottom };
    }""", selector)

def all_els(page, selector):
    return page.evaluate("""(s) => {
        return [...document.querySelectorAll(s)].map(el => {
            const r = el.getBoundingClientRect();
            return { tag: el.tagName, cls: el.className, w: r.width, h: r.height, x: r.left, y: r.top, r: r.right, b: r.bottom };
        });
    }""", selector)

def rects_overlap(a, b):
    return a['x'] < b['r'] and a['r'] > b['x'] and a['y'] < b['b'] and a['b'] > b['y']

def run_checks(page, viewport_label, vp_w, vp_h):
    print(f"\n{'='*60}")
    print(f"VIEWPORT: {viewport_label} ({vp_w}x{vp_h})")
    print(f"{'='*60}")

    page.set_viewport_size({"width": vp_w, "height": vp_h})

    # Go straight to a site (skip hub for performance)
    ts = int(time.time() * 1000)
    page.goto(f"{BASE}/mars-colony/?cb={ts}&site=jezero", timeout=120000)

    # Wait for game boot
    for i in range(MAX_POLLS):
        ok = page.evaluate("() => typeof window.__mc !== 'undefined' && !!__mc.site")
        if ok:
            break
        time.sleep(POLL_INTERVAL)
    else:
        note("Runtime", "critical", f"__mc never appeared for {viewport_label}")
        return

    info = page.evaluate("() => ({ site: __mc.site.id, unit: __mc.active?.name })")
    print(f"  Booted: site={info['site']}, active unit={info['unit']}")

    time.sleep(2)

    # ---- HUD layout checks ---------------------------------------------
    vp = page.evaluate("() => ({ w: window.innerWidth, h: window.innerHeight })")
    print(f"  Window inner: {vp['w']}x{vp['h']}")

    # Check if rotate prompt is visible
    rotate_display = page.evaluate("""() => {
        const el = document.querySelector('.mars-hud__rotate');
        if (!el) return 'no-element';
        return window.getComputedStyle(el).display;
    }""")
    print(f"  Rotate prompt display: {rotate_display}")
    is_portrait = vp['h'] > vp['w']
    if rotate_display == 'flex' and not is_portrait:
        note("HUD/rotate", "moderate", "Rotate prompt visible in landscape — should be hidden")
    if rotate_display == 'flex' and is_portrait and vp_w <= 899:
        print("  Rotate prompt SHOWN (expected in mobile portrait)")

    # Top bar — check if children overflow
    top_bar = px(page, ".mars-hud__top")
    if top_bar:
        top_children = all_els(page, ".mars-hud__top > *")
        rightmost = 0
        for ch in top_children:
            r = ch['x'] + ch['w']
            if r > rightmost:
                rightmost = r
        bar_right = top_bar['x'] + top_bar['w']
        print(f"  Top bar: x={top_bar['x']:.0f} w={top_bar['w']:.0f} right={bar_right:.0f}, rightmost child x+w = {rightmost:.0f}")
        if rightmost > bar_right + 1:
            note("HUD/top-bar", "critical",
                 f"Top bar children overflow container: {rightmost:.0f} > {bar_right:.0f}",
                 f"Viewport: {vp['w']}x{vp['h']}")
        if rightmost > vp['w']:
            child_repr = ", ".join(
                f"{ch['cls'][:25]}@{ch['x']:.0f}+{ch['w']:.0f}"
                for ch in top_children
            )
            note("HUD/top-bar", "critical",
                 f"Top bar children overflow viewport right edge: {rightmost:.0f} > {vp['w']}",
                 f"Children: [{child_repr}]")

    # HUD element bounds + overlap check
    hud_els = [
        ("minimap",   "#mc-minimap"),
        ("compass",   "#mc-compass"),
        ("telemetry", "#mc-telemetry"),
        ("inventory", "#mc-inventory"),
        ("gear",      "#mc-gear"),
        ("dronectl",  "#mc-dronectl"),
        ("gps",       "#mc-gps"),
    ]
    hud_rects = []
    for name, sel in hud_els:
        r = px(page, sel)
        if r:
            hud_rects.append((name, r))

    for name, r in hud_rects:
        has_size = r['w'] > 0 and r['h'] > 0
        in_view = (r['x'] >= -5 and r['y'] >= -5 and r['r'] <= vp['w'] + 5 and r['b'] <= vp['h'] + 5)
        if has_size and not in_view:
            note("HUD/clip", "moderate",
                 f"{name} may be partially off-screen",
                 f"({r['x']:.0f},{r['y']:.0f}) {r['w']:.0f}x{r['h']:.0f} in {vp['w']}x{vp['h']} viewport")

    # Pairwise overlap
    for i in range(len(hud_rects)):
        for j in range(i+1, len(hud_rects)):
            n1, r1 = hud_rects[i]
            n2, r2 = hud_rects[j]
            if r1['w'] > 0 and r1['h'] > 0 and r2['w'] > 0 and r2['h'] > 0 and rects_overlap(r1, r2):
                ox = max(0, min(r1['r'], r2['r']) - max(r1['x'], r2['x']))
                oy = max(0, min(r1['b'], r2['b']) - max(r1['y'], r2['y']))
                sev = "critical" if ox > 30 and oy > 30 else "moderate" if ox > 10 and oy > 10 else "minor"
                note(f"HUD/overlap/{n1}×{n2}", sev,
                     f"Overlap detected: {ox:.0f}×{oy:.0f}px",
                     f"{n1}=({r1['x']:.0f},{r1['y']:.0f}) {r1['w']:.0f}x{r1['h']:.0f}  "
                     f"{n2}=({r2['x']:.0f},{r2['y']:.0f}) {r2['w']:.0f}x{r2['h']:.0f}")

    # Print HUD positions for analysis
    print("  HUD positions:")
    for name, r in sorted(hud_rects, key=lambda x: (x[1]['x'], x[1]['y'])):
        print(f"    {name}: ({r['x']:.0f},{r['y']:.0f}) {r['w']:.0f}x{r['h']:.0f}  right={r['r']:.0f} bottom={r['b']:.0f}")

    # Touch zones
    tz_left = px(page, "#mc-touch-move")
    tz_right = px(page, "#mc-touch-look")
    is_touch = page.evaluate("() => 'ontouchstart' in window || navigator.maxTouchPoints > 0")
    touch_visible = page.evaluate("""() => {
        const m = document.getElementById('mc-touch-move');
        return m ? !m.hidden : false;
    }""")
    print(f"  Touch zones: MOVE={'visible' if tz_left else 'hidden'} LOOK={'visible' if tz_right else 'hidden'} (isTouch={is_touch}, touchZoneHidden={not touch_visible})")

    # Canvas sizing
    canvas = px(page, "#mc-canvas")
    if canvas:
        aspect_ok = abs((canvas['w'] / canvas['h']) - (vp['w'] / vp['h'])) < 0.02
        if not aspect_ok:
            note("Canvas", "moderate",
                 f"Canvas aspect ratio mismatch",
                 f"canvas={canvas['w']:.0f}x{canvas['h']:.0f} vp={vp['w']}x{vp['h']}")
        if abs(canvas['w'] - vp['w']) > 5:
            note("Canvas", "moderate",
                 f"Canvas width ({canvas['w']:.0f}) != viewport ({vp['w']:.0f})")

    # Vignette pointer-events check
    pe = page.evaluate("""() => {
        const el = document.getElementById('mc-vignette');
        return el ? window.getComputedStyle(el).pointerEvents : 'no-element';
    }""")
    if pe == 'auto':
        note("HUD/vignette", "critical", "Vignette has pointer-events:auto — blocks touch!")
    elif pe != 'no-element':
        print(f"  Vignette pointer-events: {pe} OK")

    # Menu panel sizing
    page.evaluate("() => document.querySelector('#mc-menu').dataset.open = 'true'")
    time.sleep(0.5)
    menu_panel = px(page, ".mars-menu__panel")
    if menu_panel:
        off_left = menu_panel['x'] < -2
        off_right = menu_panel['r'] > vp['w'] + 2
        off_top = menu_panel['y'] < -2
        off_bottom = menu_panel['b'] > vp['h'] + 2
        if off_left or off_right or off_top or off_bottom:
            note("Menu", "moderate",
                 "Menu panel extends outside viewport",
                 f"({menu_panel['x']:.0f},{menu_panel['y']:.0f}) {menu_panel['w']:.0f}x{menu_panel['h']:.0f} in {vp['w']}x{vp['h']}")
        print(f"  Menu panel: ({menu_panel['x']:.0f},{menu_panel['y']:.0f}) {menu_panel['w']:.0f}x{menu_panel['h']:.0f}")
    page.evaluate("() => document.querySelector('#mc-menu').dataset.open = 'false'")

    # COLLECT prompt button
    prompt_btn = px(page, "#mc-prompt .mars-btn")
    if prompt_btn and prompt_btn['h'] > 0:
        if prompt_btn['b'] > vp['h']:
            note("HUD/prompt", "moderate",
                 "COLLECT prompt below viewport", f"bottom={prompt_btn['b']:.0f} > {vp['h']}")

    # Minimap sizing
    minimap = px(page, ".mars-hud__minimap")
    if minimap:
        ratio = minimap['w'] / vp['w']
        print(f"  Minimap: {minimap['w']:.0f}px = {ratio*100:.1f}% of viewport width")
        if ratio > 0.45:
            note("HUD/minimap", "minor",
                 f"Minimap is {ratio*100:.0f}% of viewport width — very large on small screens")

    # Body font size + touch-action
    body_font = page.evaluate("() => window.getComputedStyle(document.body).fontSize")
    body_touch = page.evaluate("() => window.getComputedStyle(document.body).touchAction")
    print(f"  Body font-size: {body_font}, touch-action: {body_touch}")

    # Pixel ratio
    pr = page.evaluate("() => __mc.renderer.getPixelRatio()")
    print(f"  Renderer pixel ratio: {pr}")

    # Frame drop / cross-check: renderer size vs canvas CSS
    r_w = page.evaluate("() => __mc.renderer.domElement.width")
    r_h = page.evaluate("() => __mc.renderer.domElement.height")
    scale = page.evaluate("() => __mc.renderer.getPixelRatio()")
    print(f"  Renderer buffer: {r_w}x{r_h} (CSS: {canvas['w']:.0f}x{canvas['h']:.0f}, scale: {scale})")

    # 18. Joystick pads visible on touch devices?
    joy = page.evaluate("""() => {
        const zones = [document.getElementById('mc-touch-move'), document.getElementById('mc-touch-look')];
        return zones.map(z => {
            if (!z) return null;
            const b = z.querySelector('.joy-base');
            const n = z.querySelector('.joy-nub');
            const off = z.dataset.off === 'true';
            const br = b ? b.getBoundingClientRect() : null;
            return { off, baseVisible: !!br && br.width > 0, baseW: br ? br.width : 0,
                     zoneW: z.getBoundingClientRect().width };
        });
    }""")
    print(f"  Joysticks: {joy}")

    # 19. Drone mode: switch unit until a drone, check dronectl layout
    for _ in range(8):
        page.evaluate("() => document.dispatchEvent(new CustomEvent('mc-switch-unit'))")
        time.sleep(0.3)
        cur = page.evaluate("() => __mc.active.unit === __mc.recon || __mc.active.unit === __mc.lift")
        if cur:
            break
    is_drone = page.evaluate("() => __mc.active.kind === 'fly'")
    print(f"  Switched to drone: {is_drone} ({page.evaluate('() => __mc.active.name')})")
    if is_drone:
        time.sleep(0.5)
        dc = px(page, "#mc-dronectl")
        mm = px(page, "#mc-minimap")
        cp = px(page, "#mc-compass")
        gr = px(page, "#mc-gear")
        if dc:
            print(f"  Dronectl: ({dc['x']:.0f},{dc['y']:.0f}) {dc['w']:.0f}x{dc['h']:.0f}")
            for n2, r2 in [("minimap", mm), ("compass", cp), ("gear", gr)]:
                if r2 and r2['w'] > 0 and rects_overlap(dc, r2):
                    ox = max(0, min(dc['r'], r2['r']) - max(dc['x'], r2['x']))
                    oy = max(0, min(dc['b'], r2['b']) - max(dc['y'], r2['y']))
                    note(f"HUD/overlap/dronectl×{n2}", "moderate",
                         f"Drone board overlaps {n2} ({ox:.0f}x{oy:.0f}px)",
                         f"dronectl=({dc['x']:.0f},{dc['y']:.0f}) {dc['w']:.0f}x{dc['h']:.0f}  {n2}=({r2['x']:.0f},{r2['y']:.0f}) {r2['w']:.0f}x{r2['h']:.0f}")
        # right stick (look) should be visible for drones on touch
        look_vis = page.evaluate("() => document.getElementById('mc-touch-look').dataset.off")
        print(f"  Look-zone data-off (drone): {look_vis}")
        if is_touch and look_vis == 'true':
            note("Touch", "critical", "Right stick (PITCH·ROLL) hidden while flying a drone on touch — cannot steer!")

    print("  Checks complete.")


def main():
    import playwright.sync_api as pw

    server_proc = None
    import subprocess, urllib.request

    try:
        # Reuse an already-running server on 8931 if it answers; else start one.
        try:
            urllib.request.urlopen(BASE + "/mars-colony/index.html", timeout=2)
            print("Reusing running HTTP server on :8931")
        except Exception:
            print("Starting HTTP server...")
            public_dir = os.path.join(os.getcwd(), "public")
            server_proc = subprocess.Popen(
                [sys.executable, "-m", "http.server", "8931", "--bind", "127.0.0.1"],
                cwd=public_dir,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
            )
            time.sleep(1)

        with pw.sync_playwright() as p:
            browser = p.chromium.launch(
                args=["--enable-unsafe-swiftshader", "--no-sandbox"],
                headless=True,
            )

            viewports = [
                ("iPad Mini landscape",   1024, 768),
                ("Small phone portrait",  320, 568),
                ("Small phone landscape", 568, 320),
            ]

            for label, w, h in viewports:
                ctx = browser.new_context(
                    viewport={"width": w, "height": h},
                    device_scale_factor=2,
                    is_mobile=True,
                    has_touch=True,
                )
                page = ctx.new_page()
                try:
                    run_checks(page, label, w, h)
                except Exception as e:
                    import traceback
                    note("Runtime", "critical", f"Test crashed for {label}: {e}")
                    traceback.print_exc()
                finally:
                    ctx.close()

            # Device-emulated test (iPhone 13)
            print(f"\n{'='*60}")
            print("DEVICE EMULATION: iPhone 13")
            print(f"{'='*60}")
            iphone = p.devices["iPhone 13"]
            page2 = browser.new_page(**iphone)
            try:
                run_checks(page2, "iPhone 13 (emulated)", 390, 844)
            except Exception as e:
                import traceback
                note("Runtime", "critical", f"iPhone 13 test crashed: {e}")
                traceback.print_exc()
            finally:
                page2.close()

            browser.close()

    finally:
        if server_proc is not None:
            server_proc.terminate()
            server_proc.wait()

    # ---- Summary -----------------------------------------------------------
    print(f"\n{'='*60}")
    print("SUMMARY")
    print(f"{'='*60}")

    by_severity = {"critical": 0, "moderate": 0, "minor": 0}
    for i in ISSUES:
        by_severity[i["severity"]] = by_severity.get(i["severity"], 0) + 1
    print(f"  Total issues: {len(ISSUES)}")
    print(f"  By severity: {json.dumps(by_severity)}")
    print()

    # Deduplicate by category + msg
    seen = set()
    for i in ISSUES:
        key = (i["category"], i["msg"])
        if key not in seen:
            seen.add(key)
            sev = i["severity"].ljust(8)
            print(f"  [{sev}] {i['category']}: {i['msg']}")
            if i["detail"]:
                print(f"         {i['detail']}")


if __name__ == "__main__":
    main()
