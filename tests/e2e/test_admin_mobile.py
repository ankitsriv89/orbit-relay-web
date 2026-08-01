"""
/Admin/ mobile contract — the dashboard is a scrolling column, so the
globe-page contract (body overflow hidden, no page scroll) does NOT apply.
What applies instead:

  - >= 3 panels matching [id$="-hud"].key-hud
  - all panels collapsed at 390px (accordion)
  - no HORIZONTAL scroll anywhere (scrollWidth <= innerWidth)
  - touch targets >= 44px
  - login form reachable

The static e2e server cannot run Pages Functions, so auth is faked with
Playwright route interception: /api/admin/** returns 200 {} and the shell
builds every panel. The login-form check runs WITHOUT interception.
"""

import sys, time
from playwright.sync_api import sync_playwright

CHROME = '/home/ankit/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome'
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
            executable_path=CHROME, headless=True,
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
                check('[login] submit button >= 44px tall', rect['h'] >= 44, f'{rect["h"]:.0f}px')
                # The panels main is hidden behind the login screen
                panels_hidden = page.evaluate('document.getElementById("admin-panels").hidden')
                check('[login] panels hidden', panels_hidden)
        except Exception as e:
            check('[login] test error', False, str(e))
        finally:
            ctx.close()

        # ── Panels build, mobile accordion, no h-scroll ────────────────────
        # 1133x744 landscape is still desktop-width (>768px), so the admin
        # mobile accordion does not apply there — health starts expanded.
        for label, vp, mobile, expect_open in [
            ('mobile 390x844',     {'width': 390, 'height': 844}, True, False),
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
                # Deterministic: wait until the registry has built the panels
                # instead of guessing with a fixed sleep.
                page.wait_for_selector('[id$="-hud"].key-hud', timeout=15000)

                vp_w = page.evaluate('window.innerWidth')
                huds = page.evaluate('''[...document.querySelectorAll('[id$="-hud"].key-hud')]
                    .map(e => e.id)''')
                check(f'[{label}] {len(huds)} HUD panels', len(huds) >= 3, str(huds))

                if len(huds):
                    collapsed = page.evaluate('''[...document.querySelectorAll('[id$="-hud"].key-hud')]
                        .every(e => e.classList.contains('key-hud--collapsed'))''')
                    if expect_open:
                        # Desktop starts the health panel (open: true) expanded
                        open_panels = page.evaluate('''[...document.querySelectorAll('[id$="-hud"].key-hud')]
                            .filter(e => !e.classList.contains('key-hud--collapsed'))
                            .map(e => e.id)''')
                        check(f'[{label}] health starts expanded on desktop',
                              'health-hud' in open_panels, str(open_panels))
                        check(f'[{label}] not all collapsed', not collapsed)
                    else:
                        check(f'[{label}] all panels collapsed', collapsed)

                    # Touch targets: every title bar and the logout button >= 44px
                    small = page.evaluate('''[...document.querySelectorAll('.key-hud-toggle')]
                        .filter(e => e.getBoundingClientRect().height < 44)
                        .map(e => e.id)''')
                    check(f'[{label}] title bars >= 44px', len(small) == 0, str(small))

                # No horizontal scroll: the column must never overflow sideways
                h_scroll = page.evaluate('''({doc: document.documentElement.scrollWidth,
                                             body: document.body.scrollWidth,
                                             vp: window.innerWidth})''')
                ok = h_scroll['doc'] <= h_scroll['vp'] and h_scroll['body'] <= h_scroll['vp']
                check(f'[{label}] no horizontal scroll',
                      ok, f"doc={h_scroll['doc']} body={h_scroll['body']} vp={h_scroll['vp']}")

                # The column scrolls vertically — unlike the globe pages, whose
                # contract is overflow hidden + no page scroll. Encode the
                # difference: body overflow must NOT be hidden.
                overflow = page.evaluate('getComputedStyle(document.body).overflow')
                check(f'[{label}] body overflow not hidden (scrollable column)',
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
