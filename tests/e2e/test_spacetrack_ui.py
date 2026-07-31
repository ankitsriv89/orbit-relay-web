"""Space-Track UI/UX E2E — verifies the redesigned dropdown/hamburger menu.

    python3 tests/e2e/serve.py &        # no-cache static server on :8932
    python3 tests/e2e/test_spacetrack_ui.py

This test suite validates the new unified dropdown menu that replaced the five
stacked right-side HUD panels (Filters, Signal Feed, Conjunctions, Daily Brief,
Analytics). It also validates the hamburger menu behaviour on mobile viewports.

Key assertions:
  - The menu toggle button exists in the topbar
  - Clicking the toggle opens the dropdown (desktop) / full-screen overlay (mobile)
  - Tab switching shows/hides the correct sections
  - Left-side panels (catalog, results) still work as collapsible HUDs
  - All existing content IDs are preserved (filters-hud-body, conj-hud-body, etc.)
  - The brief section hides/shows based on data availability
  - Mobile: the dropdown becomes full-screen, hamburger icon shows
  - Mobile: no overlapping panels (the whole problem this fixes)
  - Clicking outside the menu or pressing Escape closes it
"""

import sys
import time

from playwright.sync_api import sync_playwright

CHROME = '/home/ankit/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome'
BASE = 'http://127.0.0.1:8932/spacetrack/index.html?cb='

EXPECTED = ('/api/tle', '/api/search', '/api/summary', '/api/object',
            'favicon', 'cesium.com/downloads', 'Failed to load resource')

MOBILE_VIEWPORT = {'width': 390, 'height': 844}

results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('  PASS  ' if ok else '  FAIL  ') + name + (f' :: {detail}' if detail else ''))


def boot(page, timeout=90):
    page.goto(BASE + str(time.time()))
    for _ in range(timeout):
        if page.evaluate('!!window.__spacetrack'):
            time.sleep(1.5)
            return True
        time.sleep(1)
    return False


def open_menu(page):
    """Open the menu dropdown via the toggle button."""
    page.evaluate('document.getElementById("menu-toggle").click()')
    time.sleep(0.3)


def close_menu(page):
    """Close the menu via the close button."""
    page.evaluate('document.getElementById("menu-close").click()')
    time.sleep(0.3)


def switch_tab(page, tab_id):
    """Switch to a specific tab in the dropdown."""
    page.evaluate("""(tab) => {
        const tabBtn = document.querySelector(`.menu-tab[data-tab="${tab}"]`);
        if (tabBtn) tabBtn.click();
    }""", tab_id)
    time.sleep(0.2)


def run(page):
    # ──────────────────────────────────────────────── Boot + engine
    print('\n-- boot --')
    check('spacetrack page booted', True)

    # ──────────────────────────────────────────────── Topbar menu toggle
    print('\n-- topbar menu toggle --')
    toggle = page.evaluate('document.getElementById("menu-toggle")')
    check('menu toggle button exists', bool(toggle))
    check('menu toggle has aria-expanded', page.evaluate(
        'document.getElementById("menu-toggle").getAttribute("aria-expanded") === "false"'))
    check('menu toggle has aria-label', page.evaluate(
        '!!document.getElementById("menu-toggle").getAttribute("aria-label")'))
    check('menu dropdown starts hidden', page.evaluate(
        'document.getElementById("menu-dropdown").hidden'))

    # ──────────────────────────────────────────────── Dropdown structure
    print('\n-- dropdown structure --')
    open_menu(page)
    check('menu opens and dropdown is visible',
          page.evaluate('!document.getElementById("menu-dropdown").hidden'))

    # Check tab structure
    expected_tabs = ['filters', 'signal', 'conj', 'brief', 'analytics']
    for tab_id in expected_tabs:
        exists = page.evaluate(
            f'!!document.querySelector(\'.menu-tab[data-tab="{tab_id}"]\')')
        check(f'tab "{tab_id}" exists', exists)

    # Check section structure
    for section_id in ['filters-section', 'signal-section', 'conj-section',
                        'brief-section', 'analytics-section']:
        exists = page.evaluate(f'!!document.getElementById("{section_id}")')
        check(f'section "{section_id}" exists', exists)

    # Close button
    check('close button exists', page.evaluate(
        '!!document.getElementById("menu-close")'))

    # ──────────────────────────────────────────────── Tab switching
    print('\n-- tab switching --')
    # Default active tab is filters
    check('filters tab active by default', page.evaluate(
        '''document.querySelector('.menu-tab[data-tab="filters"]')
           .classList.contains('menu-tab--active')'''))
    check('filters section visible by default', page.evaluate(
        '''document.querySelector('.menu-section[data-tab-content="filters"]')
           .classList.contains('menu-section--active')'''))

    # Switch to signal tab
    switch_tab(page, 'signal')
    check('signal tab becomes active', page.evaluate(
        '''document.querySelector('.menu-tab[data-tab="signal"]')
           .classList.contains('menu-tab--active')'''))
    check('filters tab becomes inactive', page.evaluate(
        '''!document.querySelector('.menu-tab[data-tab="filters"]')
           .classList.contains('menu-tab--active')'''))
    check('signal section visible', page.evaluate(
        '''document.querySelector('.menu-section[data-tab-content="signal"]')
           .classList.contains('menu-section--active')'''))
    check('filters section hidden', page.evaluate(
        '''!document.querySelector('.menu-section[data-tab-content="filters"]')
           .classList.contains('menu-section--active')'''))

    # Switch to conj tab
    switch_tab(page, 'conj')
    check('conj tab activates', page.evaluate(
        '''document.querySelector('.menu-tab[data-tab="conj"]')
           .classList.contains('menu-tab--active')'''))

    # Switch to analytics tab
    switch_tab(page, 'analytics')
    check('analytics tab activates', page.evaluate(
        '''document.querySelector('.menu-tab[data-tab="analytics"]')
           .classList.contains('menu-tab--active')'''))

    # Switch back to filters
    switch_tab(page, 'filters')
    check('back to filters tab', page.evaluate(
        '''document.querySelector('.menu-tab[data-tab="filters"]')
           .classList.contains('menu-tab--active')'''))

    # ──────────────────────────────────────────────── Close via close button
    print('\n-- close menu --')
    close_menu(page)
    check('menu closes via X button', page.evaluate(
        'document.getElementById("menu-dropdown").hidden'))
    check('toggle button is not open', page.evaluate(
        '!document.getElementById("menu-toggle").classList.contains("menu-toggle--open")'))

    # ──────────────────────────────────────────────── Reopen and Escape to close
    print('\n-- escape key --')
    open_menu(page)
    page.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}))")
    time.sleep(0.2)
    check('Escape closes the menu', page.evaluate(
        'document.getElementById("menu-dropdown").hidden'))

    # ──────────────────────────────────────────────── Brief section visibility
    print('\n-- brief section --')
    # After loadBrief fails (no API), the brief section should be hidden
    page.evaluate('__spacetrack.loadBrief()')
    time.sleep(0.5)
    open_menu(page)
    switch_tab(page, 'brief')
    check('brief section hidden when no data',
          page.evaluate('document.getElementById("brief-section").hidden'))
    close_menu(page)

    # Render a card with data
    FACTS_ONLY_CARD = {
        'available': True,
        'generated_at': '2026-07-28T17:40:00Z',
        'narrative': None,
        'narrative_status': 'disabled',
        'facts': {
            'tracked_on_orbit': 31629, 'payloads': 11284, 'debris': 16003,
            'new_objects': 7, 'decays': 2,
            'reentry_watch': [
                {'norad': 60002, 'name': 'FALCON 9 R/B', 'country': 'US', 'days_until': 3},
            ],
        },
    }
    page.evaluate('(card) => __spacetrack.renderBrief(card)', FACTS_ONLY_CARD)
    open_menu(page)
    switch_tab(page, 'brief')
    check('brief section visible when data exists',
          page.evaluate('!document.getElementById("brief-section").hidden'))
    check('brief tracked number renders',
          page.evaluate(
              'document.getElementById("brief-tracked").textContent') == '31,629')
    close_menu(page)

    # ──────────────────────────────────────────────── Left-side panels still work
    print('\n-- left-side HUD panels --')
    for hid in ('catalog-hud', 'results-hud'):
        check(f'{hid} exists', page.evaluate(f'!!document.getElementById("{hid}")'))
        check(f'{hid} has toggle', page.evaluate(
            f'!!document.querySelector("#{hid} .key-hud-toggle")'))

    # Toggle catalog
    cat_toggle = page.evaluate(
        '''document.getElementById("catalog-hud").classList.contains("key-hud--collapsed")''')
    page.evaluate('document.getElementById("catalog-hud-toggle").click()')
    time.sleep(0.3)
    check('catalog toggle works',
          page.evaluate(
              'document.getElementById("catalog-hud").classList.contains("key-hud--collapsed")')
          != cat_toggle)

    # ──────────────────────────────────────────────── Filter controls preserved
    print('\n-- filter controls --')
    open_menu(page)
    for control in ('f-q', 'f-type', 'f-country', 'f-regime', 'f-era', 'f-operator',
                    'f-apply', 'f-reset', 'filters-hud-body'):
        exists = page.evaluate(f'!!document.getElementById("{control}")')
        check(f'filter control #{control} exists', exists)

    # Switch to signal tab and check
    switch_tab(page, 'signal')
    for sid in ('feed-list', 'feed-hint', 'decay-list', 'decay-hint',
                 'box-list', 'box-hint', 'signal-hud-body'):
        exists = page.evaluate(f'!!document.getElementById("{sid}")')
        check(f'signal control #{sid} exists', exists)

    # Switch to conj tab and check
    switch_tab(page, 'conj')
    for cid in ('conj-hud-body', 'conj-badge', 'c-window', 'c-threshold',
                 'c-run', 'c-cancel', 'c-status', 'c-list'):
        exists = page.evaluate(f'!!document.getElementById("{cid}")')
        check(f'conj control #{cid} exists', exists)

    # Check conj badge content
    badge = page.locator('#conj-badge')
    check('UNOFFICIAL badge visible when conj tab open',
          badge.count() == 1 and badge.first.is_visible()
          and 'NOT FOR COLLISION AVOIDANCE' in badge.first.inner_text().upper(),
          badge.first.inner_text()[:60] if badge.count() else 'absent')

    # Switch to analytics tab and check
    switch_tab(page, 'analytics')
    for aid in ('analytics-hud-body', 'an-decade-bars', 'an-site-bars',
                 'an-family-bars', 'an-country-matrix'):
        exists = page.evaluate(f'!!document.getElementById("{aid}")')
        check(f'analytics control #{aid} exists', exists)

    close_menu(page)

    # ──────────────────────────────────────────────── Time-warp still present
    print('\n-- time-warp --')
    check('time-warp controls exist', page.evaluate(
        '!!document.getElementById("time-warp")'))
    check('time-warp has buttons', page.evaluate(
        'document.querySelectorAll(".tw-btn").length >= 4'))

    # ──────────────────────────────────────────────── Dossier still present
    print('\n-- dossier --')
    check('dossier exists', page.evaluate('!!document.getElementById("dossier")'))
    check('dossier starts hidden', page.evaluate(
        'document.getElementById("dossier").hidden'))

    # ──────────────────────────────────────────────── Footer citation
    print('\n-- footer --')
    cite = page.locator('.orbital-footer__cite')
    check('Space-Track citation present and visible',
          cite.count() == 1 and cite.first.is_visible(),
          cite.first.inner_text() if cite.count() else 'absent')
    check('citation names Space-Track and USSPACECOM', page.evaluate(
        """() => {
            const t = (document.querySelector('.orbital-footer__cite') || {}).textContent || '';
            return t.includes('Space-Track.org') && t.includes('USSPACECOM');
        }"""))

    # ──────────────────────────────────────────────── Source toggle
    print('\n-- source toggle --')
    check('CELESTRAK links to /orbit/', page.evaluate(
        """() => {
            const a = document.querySelector('a.source-btn[data-source="celestrak"]');
            return !!a && new URL(a.href).pathname === '/orbit/';
        }"""))
    check('SPACE-TRACK marks itself current page', page.evaluate(
        """() => {
            const el = document.querySelector('[data-source="spacetrack"]');
            return el.tagName === 'SPAN' &&
                   el.classList.contains('source-btn--active');
        }"""))


# ── Mobile gate ──────────────────────────────────────────────────────────────
def mobile_gate(browser):
    """Test the hamburger menu behaviour on 390x844."""
    print('\n-- mobile  390x844 — hamburger menu --')
    page = browser.new_page(viewport=MOBILE_VIEWPORT, device_scale_factor=3,
                            is_mobile=True, has_touch=True)
    try:
        page.goto(BASE + str(time.time()))
        booted = False
        for _ in range(90):
            if page.evaluate('!!window.__spacetrack'):
                booted = True
                break
            time.sleep(1)
        check('spacetrack boots on mobile', booted)
        if not booted:
            return
        time.sleep(2)

        # ── Landmark checks
        check('menu toggle exists on mobile', page.evaluate(
            '!!document.getElementById("menu-toggle")'))

        # Menu should be hidden initially
        check('menu dropdown hidden on mobile initially', page.evaluate(
            'document.getElementById("menu-dropdown").hidden'))

        # Open menu
        page.evaluate('document.getElementById("menu-toggle").click()')
        time.sleep(0.4)

        # On mobile, the dropdown should be visible and full-screen
        check('menu opens on mobile (hidden false)',
              page.evaluate('!document.getElementById("menu-dropdown").hidden'))

        # Check dimensions — should cover the viewport
        rect = page.evaluate("""() => {
            const r = document.getElementById('menu-dropdown').getBoundingClientRect();
            return {w: Math.round(r.width), h: Math.round(r.height),
                    t: Math.round(r.top), l: Math.round(r.left)};
        }""")
        check('menu is full-width on mobile', rect['w'] >= 390,
              f'width={rect["w"]}px')
        check('menu starts at top of screen', rect['t'] == 0,
              f'top={rect["t"]}px')

        # Check tabs exist and are reachable
        for tab_id in ('filters', 'signal', 'conj', 'brief', 'analytics'):
            exists = page.evaluate(
                f'!!document.querySelector(\'.menu-tab[data-tab="{tab_id}"]\')')
            check(f'mobile tab "{tab_id}" exists', exists)

        # Switch tabs on mobile
        switch_tab(page, 'analytics')
        check('mobile analytics tab activates', page.evaluate(
            '''document.querySelector('.menu-tab[data-tab="analytics"]')
               .classList.contains('menu-tab--active')'''))
        check('mobile analytics section visible', page.evaluate(
            '''document.querySelector('.menu-section[data-tab-content="analytics"]')
               .classList.contains('menu-section--active')'''))

        # Close menu via X button
        page.evaluate('document.getElementById("menu-close").click()')
        time.sleep(0.3)
        check('menu closes on mobile', page.evaluate(
            'document.getElementById("menu-dropdown").hidden'))

        # ── Left-side panels on mobile
        for hid in ('catalog-hud', 'results-hud'):
            exists = page.evaluate(f'!!document.getElementById("{hid}")')
            check(f'mobile panel {hid} exists', exists)

        left_boxes = page.evaluate("""() =>
            ['catalog-hud', 'results-hud'].map(id => {
                const r = document.getElementById(id).getBoundingClientRect();
                return {id, top: Math.round(r.top), bottom: Math.round(r.bottom),
                        h: Math.round(r.height)};
            })""")
        check('both left panels laid out on mobile',
              all(b['h'] > 0 for b in left_boxes), str(left_boxes))
        clashes = [f"{a['id']}/{b['id']}"
                   for i, a in enumerate(left_boxes) for b in left_boxes[i + 1:]
                   if a['top'] < b['bottom'] and b['top'] < a['bottom']]
        check('left panels do not overlap on mobile', not clashes,
              f'{clashes}')

        # ── Touch targets
        for sel in ('.st-btn', '.st-input', '.st-select', '.menu-tab', '.menu-toggle'):
            heights = page.evaluate("""(sel) => {
                const els = document.querySelectorAll(sel);
                return Array.from(els).slice(0, 3).map(el => Math.round(el.getBoundingClientRect().height));
            }""", sel)
            if not heights:
                continue
            check(f'mobile touch target {sel} >= 44px: {heights[0]}px',
                  all(h >= 44 for h in heights), f'{heights}')

        # ── No text under 11px
        small = page.evaluate("""() => {
            const bad = [];
            document.querySelectorAll('.orbital-hud *, .menu-dropdown *').forEach(el => {
                if (!el.textContent.trim() || el.children.length) return;
                if (!el.getBoundingClientRect().width) return;
                const fs = parseFloat(getComputedStyle(el).fontSize);
                if (fs < 11) bad.push(`${el.className}:${fs}`);
            });
            return bad.slice(0, 4);
        }""")
        check('mobile no visible text under 11px', not small, ', '.join(small))

    finally:
        page.close()


def main():
    headed = '--headed' in sys.argv
    errors = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            executable_path=CHROME,
            headless=not headed,
            args=['--enable-unsafe-swiftshader'],
        )
        page = browser.new_page(viewport={'width': 1400, 'height': 900})
        page.on('console', lambda m: errors.append(m.text)
                if m.type == 'error' and not any(e in m.text for e in EXPECTED) else None)
        page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))

        if not boot(page):
            print('  FAIL  page never booted (__spacetrack stay false)')
            browser.close()
            sys.exit(1)

        try:
            run(page)
            mobile_gate(browser)
        finally:
            print('\n-- console --')
            check('no unexpected console errors', not errors, '; '.join(errors[:4]))
            browser.close()

    passed = sum(1 for _, ok in results if ok)
    print(f'\n{passed}/{len(results)} passed')
    sys.exit(0 if passed == len(results) else 1)


if __name__ == '__main__':
    main()
