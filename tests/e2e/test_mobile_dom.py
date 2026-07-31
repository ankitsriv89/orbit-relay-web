"""
Lightweight mobile layout audit - DOM only, no Cesium boot wait.
"""

import sys, time
from playwright.sync_api import sync_playwright

CHROME = '/home/ankit/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome'
BASE = 'http://127.0.0.1:8931'

PAGES = { '/orbit/': 'modal-orbit', '/spacetrack/': 'modal-spacetrack' }

results = []
def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('  PASS  ' if ok else '  FAIL  ') + name + (f' :: {detail}' if detail else ''))

def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            executable_path=CHROME, headless=True,
            args=['--enable-unsafe-swiftshader', '--no-sandbox'],
        )

        for page_path, page_id in PAGES.items():
            print(f'\n{"="*50}\nPAGE: {page_path}\n{"="*50}')

            # Mobile viewport
            mobile_ctx = browser.new_context(
                viewport={'width': 390, 'height': 844},
                device_scale_factor=3.0, is_mobile=True,
            )
            mobile = mobile_ctx.new_page()
            try:
                url = BASE + page_path + '?cb=' + str(time.time())
                # Just wait for DOM, don't wait for Cesium CDN
                mobile.goto(url, timeout=15000, wait_until='commit')
                time.sleep(1)

                vp_w = mobile.evaluate('window.innerWidth')
                vp_h = mobile.evaluate('window.innerHeight')
                check(f'[{page_path}] mobile viewport size', vp_w == 390, f'{vp_w}x{vp_h}')

                # Viewport meta
                meta = mobile.evaluate('document.querySelector("meta[name=viewport]")?.content')
                check(f'[{page_path}] viewport meta present', bool(meta), meta or 'MISSING')
                if meta:
                    check('  width=device-width', 'width=device-width' in meta)
                    check('  initial-scale=1.0', 'initial-scale=1.0' in meta)
                    check('  viewport-fit=cover', 'viewport-fit=cover' in meta)

                # HUD panels exist
                huds = mobile.evaluate('''[...document.querySelectorAll('[id$="-hud"].key-hud')]
                    .map(e => e.id)''')
                check(f'[{page_path}] {len(huds)} HUD panels', len(huds) >= 3, str(huds))

                if len(huds) > 0:
                    # All start collapsed on mobile
                    collapsed = mobile.evaluate('''[...document.querySelectorAll('[id$="-hud"].key-hud')]
                        .every(e => e.classList.contains('key-hud--collapsed'))''')
                    check(f'  all panels start collapsed', collapsed)

                    # Panel positions vs viewport
                    panel_pos = mobile.evaluate('''[...document.querySelectorAll('[id$="-hud"].key-hud')]
                        .map(e => {
                            const r = e.getBoundingClientRect();
                            return {id: e.id, top: r.top, left: r.left, w: r.width, h: r.height,
                                    bottom: r.bottom, right: r.right};
                        })''')
                    for p in panel_pos:
                        in_view = p['left'] >= 0 and p['right'] <= vp_w and p['top'] >= 0
                        check(f'  #{p["id"]} L:{p["left"]:.0f} T:{p["top"]:.0f} {p["w"]:.0f}x{p["h"]:.0f} in view',
                              in_view)

                # Check overflow hidden
                overflow = mobile.evaluate('getComputedStyle(document.body).overflow')
                check(f'[{page_path}] body overflow hidden', overflow in ('hidden','clip'), overflow)

                # Check for page scroll
                has_scroll = mobile.evaluate('document.documentElement.scrollHeight > window.innerHeight')
                check(f'[{page_path}] no page scroll', not has_scroll,
                      f'scroll {mobile.evaluate("document.documentElement.scrollHeight")}px > {vp_h}px')

                # Check footer citation exists
                cite = mobile.evaluate('document.querySelector(".orbital-footer__cite")?.textContent')
                check(f'[{page_path}] citation present', bool(cite), (cite or '')[:60])

            except Exception as e:
                check(f'[{page_path}] mobile test error', False, str(e))
            finally:
                mobile_ctx.close()

            # Tablet viewport (iPad)
            tab_ctx = browser.new_context(
                viewport={'width': 820, 'height': 1180},
                device_scale_factor=2.0, is_mobile=False,
            )
            tab = tab_ctx.new_page()
            try:
                tab.goto(BASE + page_path + '?cb=' + str(time.time()), timeout=15000, wait_until='commit')
                time.sleep(1)

                vp_w = tab.evaluate('window.innerWidth')
                vp_h = tab.evaluate('window.innerHeight')
                tw = tab.evaluate('window.innerWidth')
                huds = tab.evaluate('''[...document.querySelectorAll('[id$="-hud"].key-hud')]
                    .map(e => {
                        const r = e.getBoundingClientRect();
                        return {id: e.id, top: r.top, left: r.left, w: r.width, h: r.height};
                    })''')
                check(f'[{page_path}] tablet {len(huds)} HUD panels', len(huds) >= 3)
                for p in huds[:2]:
                    in_view = p['left'] >= 0 and p['left'] + p['w'] <= tw
                    check(f'  #{p["id"]} in view on tablet', in_view,
                          f'L:{p["left"]:.0f} W:{p["w"]:.0f} vs {tw}px')

            except Exception as e:
                check(f'[{page_path}] tablet test error', False, str(e))
            finally:
                tab_ctx.close()

        browser.close()

    passed = sum(1 for _, ok in results if ok)
    total = len(results)
    print(f'\n{passed}/{total} passed')
    failures = [(n, d) for n, ok, d in results if not ok]
    if failures:
        print(f'\nFAILURES ({len(failures)}):')
        for n, d in failures:
            print(f'  FAIL  {n}  {d}')
    sys.exit(0 if passed == total else 1)

if __name__ == '__main__':
    main()
