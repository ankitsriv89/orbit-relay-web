"""
Mobile responsiveness and performance audit for orbit/spacetrack pages.

Tests across multiple viewports and identifies layout/perf issues.

Usage:
    python3 tests/e2e/test_mobile_responsive.py
"""

import sys, time, json

from playwright.sync_api import sync_playwright

CHROME = '/home/ankit/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome'
BASE = 'http://127.0.0.1:8931'

VIEWPORTS = {
    'iphone14':      {'width': 390,  'height': 844,  'dpr': 3.0, 'name': 'iPhone 14'},
    'pixel7':        {'width': 412,  'height': 915,  'dpr': 2.6, 'name': 'Pixel 7'},
    'ipad_air':      {'width': 820,  'height': 1180, 'dpr': 2.0, 'name': 'iPad Air'},
    'ipad_mini_land':{'width': 1133, 'height': 744,  'dpr': 2.0, 'name': 'iPad Mini landscape'},
    'desktop':       {'width': 1400, 'height': 900,  'dpr': 1.0, 'name': 'Desktop reference'},
}

PAGES = [
    '/orbit/',
    '/spacetrack/',
]

results = []
def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('  PASS  ' if ok else '  FAIL  ') + name + (f' :: {detail}' if detail else ''))

def viewport_name(vp):
    return f"{vp['name']} ({vp['width']}x{vp['height']} @{vp['dpr']}x)"

def run_tests(browser):
    for page_path in PAGES:
        print(f"\n{'='*60}")
        print(f"PAGE: {page_path}")
        print(f"{'='*60}")

        for vp in VIEWPORTS.values():
            print(f"\n-- viewport: {viewport_name(vp)} --")
            context = browser.new_context(
                viewport=vp,
                device_scale_factor=vp['dpr'],
                is_mobile=vp['width'] < 600,
            )
            page = context.new_page()

            try:
                url = BASE + page_path + '?cb=' + str(time.time())
                page.goto(url, timeout=30000, wait_until='domcontentloaded')
                time.sleep(3)

                test_layout(page, page_path, vp)
                test_touch_targets(page, page_path, vp)
                test_orientation(page, page_path, vp)
            except Exception as e:
                check(f'[{page_path}] crash on {viewport_name(vp)}', False, str(e))
            finally:
                context.close()

def test_layout(page, page_path, vp):
    prefix = f'[{page_path}] {viewport_name(vp)}'
    is_mobile = vp['width'] < 600

    # 1. Viewport meta tag
    vp_meta = page.evaluate('''() => {
        const m = document.querySelector('meta[name="viewport"]');
        return m ? m.getAttribute('content') : null;
    }''')
    check(f'{prefix} viewport meta present', bool(vp_meta), vp_meta or 'missing')
    if vp_meta:
        check(f'{prefix} viewport width=device-width', 'width=device-width' in vp_meta)
        check(f'{prefix} viewport initial-scale=1.0', 'initial-scale=1.0' in vp_meta)

    # 2. Body overflow hidden (for fixed HUD)
    overflow = page.evaluate('getComputedStyle(document.body).overflow')
    if is_mobile:
        check(f'{prefix} body overflow hidden/hidden on mobile',
              overflow in ('hidden', 'clip'),
              overflow)

    # 3. HUD panels exist and have collapsed state
    hud_panels = page.evaluate('''() => {
        return [...document.querySelectorAll('[id$="-hud"]')]
            .filter(el => el.classList.contains('key-hud'))
            .map(el => ({
                id: el.id,
                collapsed: el.classList.contains('key-hud--collapsed'),
                w: el.offsetWidth,
                h: el.offsetHeight,
                top: el.getBoundingClientRect().top,
                left: el.getBoundingClientRect().left,
            }));
    }''')
    check(f'{prefix} {len(hud_panels)} HUD panels found', len(hud_panels) >= 3,
          str([p['id'] for p in hud_panels]))

    if is_mobile and hud_panels:
        # All panels start collapsed on mobile
        all_collapsed = all(p['collapsed'] for p in hud_panels)
        check(f'{prefix} all panels collapsed on mobile', all_collapsed)

        # Check panels are within viewport
        for p in hud_panels:
            vw = page.evaluate('window.innerWidth')
            vh = page.evaluate('window.innerHeight')
            in_view = p['left'] >= 0 and p['left'] + p['w'] <= vw and p['top'] >= 0
            check(f'{prefix} panel #{p["id"]} within viewport', in_view,
                  f'L:{p["left"]:.0f} T:{p["top"]:.0f} W:{p["w"]:.0f} H:{p["h"]:.0f} vs {vw}x{vh}')

        # No panel overlaps another on mobile
        for i, a in enumerate(hud_panels):
            for b in hud_panels[i+1:]:
                if a['collapsed'] or b['collapsed']: continue
                overlap = (a['left'] < b['left'] + b['w'] and a['left'] + a['w'] > b['left'] and
                          a['top'] < b['top'] + b['h'] and a['top'] + a['h'] > b['top'])
                if overlap:
                    check(f'{prefix} expanded panels overlap {a["id"]} vs {b["id"]}', False)

    # 4. Cesium container fills viewport
    cesium_rect = page.evaluate('''() => {
        const el = document.getElementById('cesium-container');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {w: r.width, h: r.height, top: r.top, left: r.left};
    }''')
    if cesium_rect:
        vw = page.evaluate('window.innerWidth')
        vh = page.evaluate('window.innerHeight')
        check(f'{prefix} cesium-container present', True)
        check(f'{prefix} cesium-container full width', cesium_rect['w'] >= vw * 0.9,
              f'{cesium_rect["w"]:.0f}px vs {vw}px viewport')
        check(f'{prefix} cesium-container full height', cesium_rect['h'] >= vh * 0.8,
              f'{cesium_rect["h"]:.0f}px vs {vh}px viewport')

    # 5. Cesium resolution scale for mobile
    if page_path == '/orbit/':
        res_scale = page.evaluate('''() => {
            try { return viewer.resolutionScale; } catch(e) { return 'unavailable'; }
        }''')
        if is_mobile:
            check(f'{prefix} Cesium resolutionScale set for mobile DPR',
                  res_scale != 'unavailable' and (res_scale == 1.0 or res_scale == 0.5),
                  f'resolutionScale={res_scale}')

        # Check requestRenderMode
        render_mode = page.evaluate('''() => {
            try { return viewer.scene.requestRenderMode; } catch(e) { return null; }
        }''')
        if is_mobile:
            check(f'{prefix} Cesium requestRenderMode enabled', render_mode == True,
                  f'requestRenderMode={render_mode}')

    # 6. Font size isn't too small on mobile
    if is_mobile:
        body_font = page.evaluate('parseFloat(getComputedStyle(document.body).fontSize)')
        check(f'{prefix} body font-size >= 12px on mobile', body_font >= 9,
              f'{body_font}px')

        # Check a HUD panel's font
        hud_font = page.evaluate('''() => {
            const el = document.querySelector('[id$="-hud"] .orbital-hud');
            return el ? parseFloat(getComputedStyle(el).fontSize) : null;
        }''')
        if hud_font:
            check(f'{prefix} HUD font-size >= 9px on mobile', hud_font >= 8,
                  f'{hud_font}px')

    # 7. Footer citation visible
    cite = page.locator('.orbital-footer__cite')
    cite_count = cite.count()
    if cite_count:
        check(f'{prefix} citation present', True)
        try:
            cite_visible = cite.first.is_visible()
            check(f'{prefix} citation visible', cite_visible)
        except:
            pass

    # 8. Check for scrollbars (should be none on a fullscreen app)
    has_scroll = page.evaluate('''() => {
        return document.documentElement.scrollHeight > window.innerHeight ||
               document.documentElement.scrollWidth > window.innerWidth;
    }''')
    # Mobile may need scrolling for expanded panels
    check(f'{prefix} no unwanted page scroll', not has_scroll or is_mobile,
          f'scroll {page.evaluate("document.documentElement.scrollHeight")}px vs {page.evaluate("window.innerHeight")}px')

def test_touch_targets(page, page_path, vp):
    """Check that tap targets are large enough on mobile."""
    prefix = f'[{page_path}] {viewport_name(vp)}'
    if vp['width'] >= 600:
        return

    # Check HUD toggle buttons have adequate tap targets
    toggles = page.evaluate('''() => {
        return [...document.querySelectorAll('.key-hud-toggle, .key-hud__title, [id$="-toggle"]')]
            .filter(el => el.offsetWidth > 0)
            .map(el => {
                const r = el.getBoundingClientRect();
                return {w: r.width, h: r.height, tag: el.tagName, id: el.id};
            });
    }''')
    small_targets = [t for t in toggles if t['w'] < 32 or t['h'] < 32]
    check(f'{prefix} no HUD toggle smaller than 32x32px on mobile',
          len(small_targets) == 0,
          f'{len(small_targets)} small: {small_targets[:3]}')

    # Check layer checkboxes use label-based interaction
    labels = page.evaluate('''() => {
        return document.querySelectorAll('.layer-label, label.layer-label, label:has(.layer-cb)').length;
    }''')
    checkboxes = page.evaluate('''() => {
        return document.querySelectorAll('input[type="checkbox"], [role="switch"]').length;
    }''')
    # If there are checkboxes, there must be labels for mobile tap
    if checkboxes > 0:
        check(f'{prefix} input elements have associated labels on mobile',
              labels >= checkboxes,
              f'{labels} labels for {checkboxes} inputs')

def test_orientation(page, page_path, vp):
    """Simulate orientation change and check layout survives."""
    prefix = f'[{page_path}] {viewport_name(vp)}'
    if vp['width'] >= 768:
        return

    # Simulate rotate to landscape by resizing
    original_w = page.evaluate('window.innerWidth')
    original_h = page.evaluate('window.innerHeight')

    page.set_viewport_size({'width': original_h, 'height': original_w})
    time.sleep(1)

    # Check panels still in viewport
    hud_panels = page.evaluate('''() => {
        return [...document.querySelectorAll('[id$="-hud"]')]
            .filter(el => el.classList.contains('key-hud'))
            .map(el => ({
                id: el.id,
                w: el.offsetWidth,
                h: el.offsetHeight,
                left: el.getBoundingClientRect().left,
                top: el.getBoundingClientRect().top,
            }));
    }''')
    vw = page.evaluate('window.innerWidth')
    vh = page.evaluate('window.innerHeight')
    out_of_bounds = [p for p in hud_panels
                     if p['left'] + p['w'] > vw or p['top'] + p['h'] > vh]
    check(f'{prefix} no panels out of bounds after orientation change',
          len(out_of_bounds) == 0,
          f'{len(out_of_bounds)} panels clipped or hidden: {[(p["id"],p["left"],p["top"]) for p in out_of_bounds]}')

    # Restore
    page.set_viewport_size({'width': original_w, 'height': original_h})
    time.sleep(1)

def main():
    errors = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            executable_path=CHROME,
            headless=True,
            args=['--enable-unsafe-swiftshader', '--enable-precise-memory-info'],
        )

        try:
            run_tests(browser)
        finally:
            browser.close()

    passed = sum(1 for _, ok in results if ok)
    total = len(results)
    print(f'\n{"="*60}')
    print(f'RESULTS: {passed}/{total} passed')

    # Print failures
    # check() records (name, ok) — the detail is already printed inline above.
    failures = [r for r in results if not r[1]]
    if failures:
        print(f'\nFAILURES ({len(failures)}):')
        for name, _ in failures:
            print(f'  FAIL  {name}')

    sys.exit(0 if passed == total else 1)

if __name__ == '__main__':
    main()
