"""
/Admin/ mobile contract — a sidebar-based console (plan 36 UI pass).

Layout: fixed left sidebar of panel links + a right content area showing the
selected panel. On mobile (<768px) the sidebar slides in off-canvas behind a
hamburger toggle. What applies:

  - login form reachable unauthenticated; dashboard shell hidden behind it
  - >= 3 panel links in the sidebar nav
  - mobile: sidebar off-canvas by default; toggle reveals it; tapping a panel
    opens it and dismisses the drawer
  - no HORIZONTAL scroll anywhere (scrollWidth <= innerWidth)
  - touch targets >= 44px
  - body overflow not hidden (the content column scrolls)

The static e2e server cannot run Pages Functions, so auth is faked with
Playwright route interception: /api/admin/** returns 200 {} and the shell
builds every panel. The login-form check runs WITHOUT interception.
"""

import sys, time
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:8931'

results = []
def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('  PASS  ' if ok else '  FAIL  ') + name + (f' :: {detail}' if detail else ''))

def fake_auth(page):
    page.route('**/api/admin/**', lambda route: route.fulfill(
        status=200, content_type='application/json', body='{}'))
    return page

def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            executable_path=pw.chromium.executable_path, headless=True,
            args=['--enable-unsafe-swiftshader', '--no-sandbox'],
        )

        # ── Login form is reachable without auth ────────────────────────────
        ctx = browser.new_context(viewport={'width': 390, 'height': 844},
                                  device_scale_factor=3.0, is_mobile=True)
        page = ctx.new_page()
        try:
            page.goto(BASE + '/admin/?cb=' + str(time.time()), timeout=15000,
                      wait_until='domcontentloaded')
            time.sleep(1)
            login_visible = page.evaluate('!document.getElementById("login-screen").hidden')
            pw_field = page.evaluate('''document.querySelector('#login-form input[type=password]')
                !== null''')
            check('[login] form visible unauthenticated', login_visible)
            check('[login] password input present', pw_field)
            if login_visible:
                rect = page.evaluate('''(() => {
                    const b = document.querySelector('.admin-login__btn');
                    const r = b.getBoundingClientRect();
                    return {w: r.width, h: r.height};
                })()''')
                check('[login] submit button >= 44px tall', rect['h'] >= 44, f"{rect['h']:.0f}px")
                # The dashboard shell is hidden behind the login screen
                shell_hidden = page.evaluate('document.getElementById("admin-shell").hidden')
                check('[login] shell hidden', shell_hidden)
        except Exception as e:
            check('[login] test error', False, str(e))
        finally:
            ctx.close()

        # ── Sidebar panels build, mobile drawer, no h-scroll ───────────────
        for label, vp, mobile, expect_nav_open in [
            ('mobile 390x844',     {'width': 390, 'height': 844}, True, False),
            # 1133x744 landscape is still desktop-width (>768px), so the
            # off-canvas drawer does not apply — the sidebar is static.
            ('landscape 1133x744', {'width': 1133, 'height': 744}, True, True),
            ('desktop 1400x900',   {'width': 1400, 'height': 900}, False, True),
        ]:
            print(f'\n{"="*50}\nVIEWPORT: {label}\n{"="*50}')
            ctx = browser.new_context(viewport=vp,
                                      device_scale_factor=3.0 if mobile else 1.0,
                                      is_mobile=mobile)
            page = fake_auth(ctx.new_page())
            try:
                page.goto(BASE + '/admin/?cb=' + str(time.time()), timeout=15000,
                          wait_until='domcontentloaded')
                # Deterministic: wait until the registry has built the sidebar
                # instead of guessing with a fixed sleep.
                page.wait_for_selector('#admin-nav-list [data-panel]', timeout=15000)

                nav_items = page.evaluate('''[...document.querySelectorAll('#admin-nav-list [data-panel]')]
                    .map(e => e.dataset.panel)''')
                check(f'[{label}] {len(nav_items)} sidebar panels', len(nav_items) >= 3, str(nav_items))

                if len(nav_items):
                    # One panel is active and its content is visible
                    active = page.evaluate('''document.querySelector('.admin-nav__link--active')
                        ? document.querySelector('.admin-nav__link--active').dataset.panel : null''')
                    visible = page.evaluate(f'''!document.getElementById("{active + '-body' if active else 'none'}").hidden''')
                    check(f'[{label}] active panel shown', bool(active) and visible, str(active))

                    # Touch targets: every VISIBLE sidebar link, plus
                    # toggle/refresh/logout. Hidden-by-CSS elements (the
                    # hamburger on desktop) report 0x0 and are skipped.
                    small = page.evaluate('''[...document.querySelectorAll(
                        '.admin-nav__link, .admin-topbar__toggle, .admin-topbar__refresh, .admin-nav__logout')]
                        .filter(e => e.offsetParent !== null)
                        .filter(e => e.getBoundingClientRect().height < 44)
                        .map(e => e.id || e.className)''')
                    check(f'[{label}] touch targets >= 44px', len(small) == 0, str(small))

                    # Desktop shows the sidebar statically; mobile hides it off-canvas
                    nav_open = page.evaluate('''(() => {
                        const nav = document.getElementById('admin-nav');
                        const x = nav.getBoundingClientRect().left;
                        const w = nav.getBoundingClientRect().width;
                        return x >= 0 && w > 0;
                    })()''')
                    check(f'[{label}] nav {"open on desktop" if not mobile else "closed on mobile"}',
                          nav_open == expect_nav_open, f'visible={nav_open}')

                if mobile and vp['width'] < 768:
                    # Toggle reveals the drawer; tapping a panel dismisses it
                    page.click('#nav-toggle', timeout=10000)
                    time.sleep(0.3)
                    drawer = page.evaluate('document.body.hasAttribute("data-nav-open")')
                    check(f'[{label}] toggle opens drawer', drawer)
                    if drawer:
                        page.click('#admin-nav-list [data-panel]', timeout=10000)
                        time.sleep(0.3)
                        closed = page.evaluate('!document.body.hasAttribute("data-nav-open")')
                        check(f'[{label}] panel tap closes drawer', closed)

                # No horizontal scroll: sidebar + content must never overflow sideways
                h_scroll = page.evaluate('''({doc: document.documentElement.scrollWidth,
                                             body: document.body.scrollWidth,
                                             vp: window.innerWidth})''')
                ok = h_scroll['doc'] <= h_scroll['vp'] and h_scroll['body'] <= h_scroll['vp']
                check(f'[{label}] no horizontal scroll',
                      ok, f"doc={h_scroll['doc']} body={h_scroll['body']} vp={h_scroll['vp']}")

                # The content column scrolls vertically — body overflow must
                # NOT be hidden (globe pages require the opposite).
                overflow = page.evaluate('getComputedStyle(document.body).overflow')
                check(f'[{label}] body overflow not hidden (scrollable content)',
                      overflow not in ('hidden', 'clip'), overflow)

            except Exception as e:
                check(f'[{label}] test error', False, str(e))
            finally:
                ctx.close()

        browser.close()

    passed = sum(1 for _, ok in results if ok)
    total = len(results)
    print(f'\n{passed}/{total} passed')
    failures = [n for n, ok in results if not ok]
    if failures:
        print(f'\nFAILURES ({len(failures)}):')
        for n in failures:
            print(f'  FAIL  {n}')
    sys.exit(0 if passed == total else 1)

if __name__ == '__main__':
    main()
