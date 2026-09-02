"""
The inline object-profile panel on /spacetrack/ (object-profiles plan, task 10).

    npm run dev                            # wrangler pages dev public → :8788
    py -3 tests/e2e/test_profile_panel.py  # (or pass a base url)

Needs the Pages Functions (/api/profile), so it targets :8788. /spacetrack/ is a
Cesium globe page, so the browser is launched with the real-GPU ANGLE/D3D11 args
from .claude/rules/testing-e2e.md — headless SwiftShader can boot the globe but
is slower and flakier for it.

Selection is driven through __spacetrack.openDossier(norad), the same entry the
click handler uses. Assumes the local D1s are migrated and hold NORAD 25544
(with a profile) and at least one object WITHOUT a profile.
"""
import sys
import time
from playwright.sync_api import sync_playwright

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8788'
WITH_PROFILE = 25544
NO_PROFILE = 55555   # seeded as COSMOS 2251 DEB, catalogue-only

results = []
def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('  PASS  ' if ok else '  FAIL  ') + name + (f' :: {detail}' if detail else ''))

GPU_ARGS = [
    '--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist',
    '--enable-gpu', '--disable-gpu-sandbox',
]

def boot(page):
    page.goto(f'{BASE}/spacetrack/?cb={time.time()}', wait_until='domcontentloaded', timeout=30000)
    for _ in range(90):
        if page.evaluate('!!window.__spacetrack && typeof __spacetrack.openDossier === "function"'):
            time.sleep(1.0)
            return True
        time.sleep(1)
    return False

def open_object(page, norad):
    page.evaluate('(n) => __spacetrack.openDossier(n)', norad)
    # the dossier fetch + the (fire-and-forget) profile fetch
    page.wait_for_function(
        '() => !document.getElementById("dossier").hidden', timeout=10000)
    page.wait_for_timeout(1500)

def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            executable_path=pw.chromium.executable_path, headless=True, args=GPU_ARGS)
        page = browser.new_page(viewport={'width': 1400, 'height': 900})
        errors = []
        # A 404 from /api/profile/<norad> is the DESIGNED answer for an object
        # with no profile (the plan fixes it as 404, not 200 + null). The
        # browser logs it as a generic "Failed to load resource … 404" console
        # error with no URL, so track profile 404s separately and subtract one
        # generic-resource console error per profile 404 seen.
        profile_404s = [0]
        def note_response(r):
            if '/api/profile/' in r.url and r.status == 404:
                profile_404s[0] += 1
        page.on('response', note_response)
        def note_console(m):
            if m.type != 'error':
                return
            if 'Failed to load resource' in m.text and '404' in m.text and profile_404s[0] > 0:
                profile_404s[0] -= 1
                return
            errors.append(m.text)
        page.on('console', note_console)
        page.on('pageerror', lambda e: errors.append(f'PAGEERROR {e}'))

        print('\n== boot /spacetrack/ ==')
        if not boot(page):
            check('/spacetrack/ booted with openDossier', False)
            _finish()
            return
        check('/spacetrack/ booted with openDossier', True)

        renderer = page.evaluate("""() => {
            const c = document.createElement('canvas');
            const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
            const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
            return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';
        }""")
        print(f'  (WebGL renderer: {renderer})')

        # ── object WITH a profile ──────────────────────────────────────────
        print('\n== an object with a profile ==')
        errors.clear()
        open_object(page, WITH_PROFILE)
        panel_visible = page.evaluate('!document.getElementById("dossier-profile").hidden')
        check('the profile panel opens for a profiled object', panel_visible)

        facts = page.eval_on_selector_all('#dossier-profile .st-profile__facts dt', 'e => e.length')
        check('the panel shows key facts', facts > 0, f'{facts} facts')

        srcs = page.eval_on_selector_all('#dossier-profile .st-profile__src', 'e => e.length')
        check('at least one fact carries a visible source attribution', srcs > 0, f'{srcs} sources')

        href = page.get_attribute('#dossier-profile .st-profile__more', 'href')
        check('the link out points at /objects/<norad>/', href == f'/objects/{WITH_PROFILE}/', href)

        # touch targets >= 44px
        more_h = page.eval_on_selector('#dossier-profile .st-profile__more',
                                       'e => e.getBoundingClientRect().height')
        check('the "full entry" link is a >= 44px touch target', more_h >= 44, f'{more_h}px')

        check('console clean with the panel open', not errors, '; '.join(errors[:3]))

        # ── object WITHOUT a profile ───────────────────────────────────────
        print('\n== an object without a profile ==')
        errors.clear()
        open_object(page, NO_PROFILE)
        hidden = page.evaluate('document.getElementById("dossier-profile").hidden')
        check('the panel is ABSENT (not empty) for an object with no profile', hidden)
        empty = page.evaluate('document.getElementById("dossier-profile").children.length === 0')
        check('the panel mount holds no leftover nodes', empty)

        # the dossier's own fields still populate
        norad_txt = page.text_content('#d-norad')
        check('the dossier still populates its own fields', str(NO_PROFILE) in (norad_txt or ''), norad_txt)
        check('console clean for the no-profile object', not errors, '; '.join(errors[:3]))

        # going back to the profiled object re-shows the panel
        open_object(page, WITH_PROFILE)
        check('re-selecting a profiled object re-opens the panel',
              page.evaluate('!document.getElementById("dossier-profile").hidden'))

        # ── no horizontal scroll with the panel open ──────────────────────
        print('\n== no horizontal page scroll, panel open ==')
        for w, h in [(390, 844), (1133, 744)]:
            page.set_viewport_size({'width': w, 'height': h})
            open_object(page, WITH_PROFILE)
            over = page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
            check(f'no h-scroll at {w}x{h} with the panel open', over <= 1, f'overflow {over}px')

        browser.close()
    _finish()

def _finish():
    passed = sum(1 for _, ok in results if ok)
    print(f'\n{passed}/{len(results)} passed')
    sys.exit(0 if passed == len(results) else 1)

if __name__ == '__main__':
    main()
