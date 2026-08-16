"""
Analytics + Brief mobile contract (plan 38 task 9).

Both pages are DOM/CSS dashboards, not WebGL globes — API calls 404 against the
static e2e server (no Pages Functions here), which is fine: each page degrades
to its stale/empty hints rather than throwing, so the DOM contract still holds
without live data.

What applies, per CLAUDE.md's mobile section and this plan's task 9:
  - no HORIZONTAL scroll on the page itself at any of the five viewports
    (documentElement.scrollWidth <= window.innerWidth)
  - wide inner containers (the country-by-decade matrix, histograms) MAY
    scroll horizontally within themselves — that's `.st-country-matrix` /
    `.st-card--chart`'s own `overflow-x: auto`, not a bug
  - touch targets on interactive controls (nav, archive selector) >= 44px

Usage:
    py -3 tests/e2e/test_dashboard_mobile.py
"""

import sys, time
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:8931'

VIEWPORTS = {
    'iphone14':       {'width': 390,  'height': 844,  'dpr': 3.0, 'name': 'iPhone 14'},
    'pixel7':         {'width': 412,  'height': 915,  'dpr': 2.6, 'name': 'Pixel 7'},
    'ipad_air':       {'width': 820,  'height': 1180, 'dpr': 2.0, 'name': 'iPad Air'},
    'ipad_mini_land': {'width': 1133, 'height': 744,  'dpr': 2.0, 'name': 'iPad Mini landscape'},
    'desktop':        {'width': 1400, 'height': 900,  'dpr': 1.0, 'name': 'Desktop reference'},
}

PAGES = [
    '/spacetrack/analytics/',
    '/spacetrack/brief/',
]

results = []
def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('  PASS  ' if ok else '  FAIL  ') + name + (f' :: {detail}' if detail else ''))

def viewport_name(vp):
    return f"{vp['name']} ({vp['width']}x{vp['height']} @{vp['dpr']}x)"

def test_page_no_horizontal_scroll(page, page_path, vp):
    prefix = f'[{page_path}] {viewport_name(vp)}'

    metrics = page.evaluate('''() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
    })''')
    check(f'{prefix} page does not scroll horizontally',
          metrics['scrollWidth'] <= metrics['innerWidth'],
          f"scrollWidth={metrics['scrollWidth']}px vs innerWidth={metrics['innerWidth']}px")

def test_inner_containers_may_scroll(page, page_path, vp):
    """The country-by-decade matrix is the one section allowed its own
    overflow-x:auto (spacetrack.css:927) — every other `.st-card` clips
    horizontally (overflow-x:hidden, spacetrack.css:1409) by design, so a wide
    chart never leaks page-level scroll. Confirm the matrix keeps its own
    scroll capability rather than accidentally inheriting the clip."""
    prefix = f'[{page_path}] {viewport_name(vp)}'
    if page_path != '/spacetrack/analytics/':
        return

    matrix = page.evaluate('''() => {
        const el = document.querySelector('.st-country-matrix');
        if (!el) return null;
        return { overflowX: getComputedStyle(el).overflowX };
    }''')
    if matrix is None:
        return
    check(f'{prefix} .st-country-matrix keeps overflow-x auto/scroll',
          matrix['overflowX'] in ('auto', 'scroll'),
          matrix['overflowX'])

def test_touch_targets(page, page_path, vp):
    prefix = f'[{page_path}] {viewport_name(vp)}'
    if vp['width'] >= 600:
        return

    targets = page.evaluate('''() => {
        return [...document.querySelectorAll('a.st-nav__link, button, [role="button"], input[type="checkbox"]')]
            .filter(el => el.offsetWidth > 0 && el.offsetHeight > 0)
            .map(el => {
                const r = el.getBoundingClientRect();
                return {w: r.width, h: r.height, tag: el.tagName, cls: el.className};
            });
    }''')
    small = [t for t in targets if t['w'] < 44 or t['h'] < 44]
    # Inline text links inside prose (not nav/button/role=button) are exempt;
    # this selector only targets nav links, buttons and checkboxes already.
    check(f'{prefix} no interactive control smaller than 44x44px',
          len(small) == 0,
          f'{len(small)} small: {small[:3]}')

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
                time.sleep(1.5)

                test_page_no_horizontal_scroll(page, page_path, vp)
                test_inner_containers_may_scroll(page, page_path, vp)
                test_touch_targets(page, page_path, vp)
            except Exception as e:
                check(f'[{page_path}] crash on {viewport_name(vp)}', False, str(e))
            finally:
                context.close()

def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            executable_path=pw.chromium.executable_path,
            headless=True,
            args=['--enable-unsafe-swiftshader'],
        )
        try:
            run_tests(browser)
        finally:
            browser.close()

    passed = sum(1 for _, ok in results if ok)
    total = len(results)
    print(f'\n{"="*60}')
    print(f'RESULTS: {passed}/{total} passed')

    failures = [r for r in results if not r[1]]
    if failures:
        print(f'\nFAILURES ({len(failures)}):')
        for name, _ in failures:
            print(f'  FAIL  {name}')

    sys.exit(0 if passed == total else 1)

if __name__ == '__main__':
    main()
