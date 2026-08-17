"""
Live-site audit against https://orbitalrelay.space.

Three concerns, one pass:
  1. Nav / brand / home-link integrity on every route (the visible chrome).
  2. WebGL + orbital-line rendering on the globe routes (real GPU, not SwiftShader
     -- see CLAUDE.md "Browser/visual testing on this machine").
  3. Ticker/live-data freshness: are the numbers real and recent?

Run:  py -3 tests/e2e/test_live_audit.py [base_url]
Default base is production. Pass http://127.0.0.1:8788 to audit a local dev server.
"""

import sys, time, json
from playwright.sync_api import sync_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else 'https://orbitalrelay.space').rstrip('/')

# Every route that ships an index.html under public/.
ROUTES = [
    '/', '/orbit/', '/spacetrack/', '/spacetrack/signal/',
    '/spacetrack/conjunctions/', '/spacetrack/brief/', '/spacetrack/analytics/',
    '/starlink/', '/constellations/', '/about/', '/wiki/',
]

# Routes that boot Cesium and are expected to render a globe.
GLOBE_ROUTES = ['/orbit/', '/spacetrack/', '/starlink/', '/constellations/']

results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(('  PASS  ' if ok else '  FAIL  ') + name + (f' :: {detail}' if detail else ''))


def audit_chrome(page, route):
    """Nav / brand / home-link integrity."""
    info = page.evaluate(r'''() => {
        const pick = (el) => {
            if (!el) return null;
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return {
                tag: el.tagName, cls: el.className, href: el.getAttribute('href'),
                text: (el.textContent || '').trim().slice(0, 40),
                w: Math.round(r.width), h: Math.round(r.height),
                top: Math.round(r.top), left: Math.round(r.left),
                display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
            };
        };
        // Any element that claims to take you home.
        const homeSel = 'a[href="/"], a[href="./"], .spacetrack-nav__brand, .orbital-brand, .wordmark';
        const homes = [...document.querySelectorAll(homeSel)].map(pick);
        // Every <img> that looks like a logo, plus whether it actually loaded.
        const imgs = [...document.querySelectorAll('img')]
            .filter(i => /logo|wordmark|icon|brand/i.test(i.className + ' ' + i.src))
            .map(i => {
                const r = i.getBoundingClientRect();
                return {
                    src: i.getAttribute('src'), resolved: i.src,
                    complete: i.complete, natW: i.naturalWidth, natH: i.naturalHeight,
                    w: Math.round(r.width), h: Math.round(r.height),
                    cls: i.className,
                };
            });
        return { homes, imgs, title: document.title };
    }''')

    homes = info['homes']
    check(f'[{route}] has a home/brand link', len(homes) > 0,
          f'{len(homes)} found')

    for h in homes:
        label = f'[{route}] home link "{(h["text"] or h["cls"])[:28]}"'
        visible = (h['display'] != 'none' and h['visibility'] != 'hidden'
                   and float(h['opacity'] or 1) > 0.05)
        check(label + ' visible', visible,
              f"display={h['display']} vis={h['visibility']} op={h['opacity']}")
        if visible:
            # A brand that renders at zero size is present in the DOM but invisible.
            check(label + ' has size', h['w'] > 8 and h['h'] > 8,
                  f"{h['w']}x{h['h']}")
            # Must not be pushed off-screen.
            check(label + ' on-screen', h['top'] > -5 and h['left'] > -5,
                  f"top={h['top']} left={h['left']}")

    # Logo images must actually decode -- a 404 gives naturalWidth 0.
    for im in info['imgs']:
        label = f'[{route}] img {im["src"]}'
        check(label + ' loaded', im['complete'] and im['natW'] > 0,
              f"natural={im['natW']}x{im['natH']} resolved={im['resolved']}")


def audit_globe(page, route):
    """WebGL renderer + whether orbital lines / satellite points actually exist."""
    gl = page.evaluate(r'''() => {
        const c = document.createElement('canvas');
        const ctx = c.getContext('webgl2') || c.getContext('webgl');
        if (!ctx) return { ok: false };
        const dbg = ctx.getExtension('WEBGL_debug_renderer_info');
        return {
            ok: true,
            renderer: dbg ? ctx.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown',
            vendor: dbg ? ctx.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : 'unknown',
        };
    }''')
    check(f'[{route}] WebGL available', gl.get('ok'), gl.get('renderer', ''))
    if gl.get('ok'):
        sw = 'swiftshader' in (gl.get('renderer') or '').lower()
        check(f'[{route}] hardware-accelerated (not SwiftShader)', not sw,
              gl.get('renderer'))

    # Cesium scene state: is the globe up, and what is actually in the scene?
    scene = page.evaluate(r'''() => {
        const v = window.viewer
            || (window.__spacetrack && (window.__spacetrack.viewer
                || (window.__spacetrack.engine && window.__spacetrack.engine.viewer)));
        if (!v || !v.scene) return { viewer: false };
        const s = v.scene;
        const prims = s.primitives;
        let points = 0, polylines = 0, collections = 0;
        for (let i = 0; i < prims.length; i++) {
            const p = prims.get(i);
            collections++;
            if (p && p.constructor) {
                const n = p.constructor.name;
                if (/PointPrimitiveCollection/.test(n) && typeof p.length === 'number') points += p.length;
                if (/PolylineCollection/.test(n) && typeof p.length === 'number') polylines += p.length;
            }
        }
        return {
            viewer: true,
            globeShow: !!(s.globe && s.globe.show),
            entities: v.entities ? v.entities.values.length : 0,
            primitiveCollections: collections,
            points, polylines,
            canvasW: s.canvas ? s.canvas.width : 0,
            canvasH: s.canvas ? s.canvas.height : 0,
            fxaa: !!(s.postProcessStages && s.postProcessStages.fxaa && s.postProcessStages.fxaa.enabled),
            resolutionScale: v.resolutionScale,
            requestRenderMode: s.requestRenderMode,
        };
    }''')

    if not scene.get('viewer'):
        check(f'[{route}] Cesium viewer reachable', False,
              'no window.viewer / __spacetrack handle')
        return scene

    check(f'[{route}] Cesium viewer reachable', True)
    check(f'[{route}] globe visible', scene.get('globeShow'), json.dumps(scene))
    check(f'[{route}] canvas has real size',
          scene.get('canvasW', 0) > 200 and scene.get('canvasH', 0) > 200,
          f"{scene.get('canvasW')}x{scene.get('canvasH')}")
    # The user's "orbital lines look weird" -- record what's actually drawn.
    print(f"    [scene] points={scene.get('points')} polylines={scene.get('polylines')} "
          f"entities={scene.get('entities')} resolutionScale={scene.get('resolutionScale')} "
          f"fxaa={scene.get('fxaa')} requestRenderMode={scene.get('requestRenderMode')}")
    return scene


def audit_tickers(page, route):
    """Any element that displays a live number/timestamp -- is it populated and fresh?"""
    tick = page.evaluate(r'''() => {
        const out = [];
        const sel = [
            '[id*="ticker" i]', '[class*="ticker" i]', '[id*="count" i]',
            '[class*="stat" i]', '[id*="updated" i]', '[class*="updated" i]',
            '[id*="epoch" i]', '[class*="epoch" i]', '[id*="age" i]',
        ].join(',');
        const seen = new Set();
        for (const el of document.querySelectorAll(sel)) {
            if (seen.has(el)) continue;
            seen.add(el);
            const t = (el.textContent || '').trim();
            if (!t || t.length > 120) continue;
            const r = el.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) continue;
            out.push({ id: el.id, cls: String(el.className).slice(0, 40), text: t.slice(0, 80) });
        }
        return out.slice(0, 40);
    }''')
    empties = [t for t in tick
               if t['text'] in ('—', '-', '', '--', 'null', 'undefined', 'NaN', 'Loading…', 'Loading...')]
    print(f"    [tickers] {len(tick)} live-ish elements, {len(empties)} empty/placeholder")
    for t in tick[:15]:
        print(f"      {t['id'] or t['cls']}: {t['text']}")
    check(f'[{route}] no placeholder/NaN tickers', len(empties) == 0,
          '; '.join(f"{t['id'] or t['cls']}={t['text']}" for t in empties[:6]))
    return tick


def main():
    console_errors = {}
    failed_requests = {}

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            executable_path=pw.chromium.executable_path, headless=True,
            args=['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist',
                  '--enable-gpu', '--disable-gpu-sandbox'],
        )
        ctx = browser.new_context(viewport={'width': 1400, 'height': 900})

        for route in ROUTES:
            print(f'\n{"=" * 64}\nROUTE: {route}\n{"=" * 64}')
            errs, bad = [], []
            page = ctx.new_page()
            page.on('console', lambda m, e=errs: e.append(m.text) if m.type == 'error' else None)
            page.on('pageerror', lambda ex, e=errs: e.append(f'PAGEERROR {ex}'))
            page.on('requestfailed',
                    lambda r, b=bad: b.append(f'{r.url} :: {r.failure}'))
            page.on('response',
                    lambda r, b=bad: b.append(f'{r.status} {r.url}') if r.status >= 400 else None)

            try:
                resp = page.goto(BASE + route, timeout=45000, wait_until='domcontentloaded')
                check(f'[{route}] HTTP ok', resp and resp.status == 200,
                      str(resp.status if resp else 'no response'))
                # Globe routes need time for Cesium CDN + TLE fetch + first render.
                time.sleep(12 if route in GLOBE_ROUTES else 4)

                audit_chrome(page, route)
                if route in GLOBE_ROUTES:
                    audit_globe(page, route)
                audit_tickers(page, route)

                # Horizontal scroll -- a repo non-negotiable.
                hscroll = page.evaluate(
                    'document.documentElement.scrollWidth > document.documentElement.clientWidth + 1')
                check(f'[{route}] no horizontal page scroll', not hscroll,
                      page.evaluate('document.documentElement.scrollWidth + " > " '
                                    '+ document.documentElement.clientWidth'))
            except Exception as ex:
                check(f'[{route}] loaded without exception', False, str(ex)[:200])
            finally:
                console_errors[route] = errs
                failed_requests[route] = bad
                page.close()

        browser.close()

    print(f'\n{"=" * 64}\nCONSOLE ERRORS / FAILED REQUESTS\n{"=" * 64}')
    for route in ROUTES:
        errs = console_errors.get(route, [])
        bad = failed_requests.get(route, [])
        if errs or bad:
            print(f'\n{route}:')
            for e in dict.fromkeys(errs):
                print(f'   [console] {e[:200]}')
            for b in dict.fromkeys(bad):
                print(f'   [request] {b[:200]}')

    passed = sum(1 for _, ok, _ in results if ok)
    total = len(results)
    print(f'\n{"=" * 64}\nRESULT: {passed}/{total} passed\n{"=" * 64}')
    for name, ok, detail in results:
        if not ok:
            print(f'  FAIL  {name} :: {detail}')
    return 0 if passed == total else 1


if __name__ == '__main__':
    sys.exit(main())
