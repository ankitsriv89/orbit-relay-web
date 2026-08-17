"""
Full live visual + interaction audit against production.

Beyond test_live_audit.py's static checks, this one actually *drives* the site:
drags/zooms the globe, toggles every layer checkbox, opens every panel/tab,
clicks satellites, and records video + screenshots of the whole thing.

Artifacts land in tests/e2e/artifacts/<route>/ :
    NN_<step>.png   screenshots at each interaction step
    *.webm          video of the full session for that route

Run:  py -3 tests/e2e/test_live_visual.py [base_url] [route ...]
"""

import sys, os, time, json, re

from playwright.sync_api import sync_playwright

ARGS = [a for a in sys.argv[1:]]
BASE = 'https://orbitalrelay.space'
if ARGS and ARGS[0].startswith('http'):
    BASE = ARGS.pop(0).rstrip('/')

ART = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'artifacts')

ALL_ROUTES = [
    '/', '/orbit/', '/spacetrack/', '/spacetrack/signal/',
    '/spacetrack/conjunctions/', '/spacetrack/brief/', '/spacetrack/analytics/',
    '/starlink/', '/constellations/', '/about/', '/wiki/',
]
ROUTES = ARGS or ALL_ROUTES
GLOBE_ROUTES = {'/orbit/', '/spacetrack/', '/starlink/', '/constellations/'}

results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(('  PASS  ' if ok else '  FAIL  ') + name + (f' :: {detail}' if detail else ''))


def slug(route):
    return route.strip('/').replace('/', '_') or 'root'


class Shot:
    """Sequential screenshotter so filenames sort in interaction order."""

    def __init__(self, page, outdir):
        self.page, self.outdir, self.n = page, outdir, 0
        os.makedirs(outdir, exist_ok=True)

    def __call__(self, label, full=False):
        self.n += 1
        safe = re.sub(r'[^a-z0-9]+', '-', label.lower()).strip('-')
        path = os.path.join(self.outdir, f'{self.n:02d}_{safe}.png')
        try:
            self.page.screenshot(path=path, full_page=full)
        except Exception as ex:
            print(f'    [shot] failed {label}: {str(ex)[:80]}')
        return path


def globe_state(page):
    """Camera + scene readout used to prove interactions actually moved things."""
    return page.evaluate(r'''() => {
        const v = window.viewer || (window.__spacetrack && (window.__spacetrack.viewer
            || (window.__spacetrack.engine && window.__spacetrack.engine.viewer)));
        if (!v || !v.scene) return null;
        const c = v.camera, s = v.scene, prims = s.primitives;
        let pts = 0, shown = 0;
        for (let i = 0; i < prims.length; i++) {
            const p = prims.get(i);
            if (p && typeof p.length === 'number' && p.get) {
                for (let j = 0; j < p.length; j++) {
                    const it = p.get(j);
                    if (it && 'position' in it && 'pixelSize' in it) {
                        pts++;
                        if (it.show) shown++;
                    }
                }
            }
        }
        const carto = c.positionCartographic;
        return {
            lon: +Cesium.Math.toDegrees(carto.longitude).toFixed(3),
            lat: +Cesium.Math.toDegrees(carto.latitude).toFixed(3),
            height: Math.round(carto.height),
            heading: +Cesium.Math.toDegrees(c.heading).toFixed(1),
            pitch: +Cesium.Math.toDegrees(c.pitch).toFixed(1),
            satPoints: pts, satPointsShown: shown,
            entities: v.entities ? v.entities.values.length : 0,
            entitiesShown: v.entities ? v.entities.values.filter(e => e.show).length : 0,
            clockRate: v.clock ? v.clock.multiplier : null,
            animating: v.clock ? v.clock.shouldAnimate : null,
        };
    }''')


def canvas_is_not_blank(page):
    """Is the globe actually drawing pixels?

    Sampled from a real screenshot, NOT by reading the WebGL canvas back in
    the page. Cesium creates its context without `preserveDrawingBuffer`, so
    the colour buffer is undefined by the time a `drawImage(canvas, …)` runs —
    it yields a fully transparent image on a globe that is rendering perfectly.
    That false negative reported `distinctColors: 1` for every globe route
    while the screenshots showed a fully drawn Earth.
    """
    try:
        png = page.screenshot(type='png')
    except Exception as ex:
        return {'ok': False, 'reason': f'screenshot failed: {ex}'}

    # Decode without external deps: count distinct colours over a sparse grid.
    import io, struct, zlib

    def decode_png(data):
        pos, w, h, idat = 8, None, None, bytearray()
        while pos < len(data):
            ln = struct.unpack('>I', data[pos:pos + 4])[0]
            typ = data[pos + 4:pos + 8]
            body = data[pos + 8:pos + 8 + ln]
            if typ == b'IHDR':
                w, h, bd, ct = struct.unpack('>IIBB', body[:10])
                if bd != 8 or ct not in (2, 6):
                    return None
                ch = 3 if ct == 2 else 4
            elif typ == b'IDAT':
                idat += body
            elif typ == b'IEND':
                break
            pos += 12 + ln
        raw = zlib.decompress(bytes(idat))
        stride = w * ch
        out, prev, p = [], bytearray(stride), 0
        for _ in range(h):
            f = raw[p]; p += 1
            line = bytearray(raw[p:p + stride]); p += stride
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                b = prev[i]
                c = prev[i - ch] if i >= ch else 0
                if f == 1: line[i] = (line[i] + a) & 255
                elif f == 2: line[i] = (line[i] + b) & 255
                elif f == 3: line[i] = (line[i] + ((a + b) >> 1)) & 255
                elif f == 4:
                    pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                    pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                    line[i] = (line[i] + pr) & 255
            out.append(bytes(line)); prev = line
        return w, h, ch, out

    dec = decode_png(png)
    if not dec:
        return {'ok': False, 'reason': 'unsupported png'}
    w, h, ch, rows = dec

    seen, lum, n = set(), 0, 0
    for y in range(0, h, max(1, h // 60)):
        row = rows[y]
        for x in range(0, w, max(1, w // 80)):
            o = x * ch
            r, g, bl = row[o], row[o + 1], row[o + 2]
            seen.add((r >> 4, g >> 4, bl >> 4))
            lum += 0.2126 * r + 0.7152 * g + 0.0722 * bl
            n += 1
    return {'ok': True, 'distinctColors': len(seen),
            'meanLuma': round(lum / max(n, 1), 1)}


def drive_globe(page, shot, route):
    """Move the camera around and prove the scene responds."""
    before = globe_state(page)
    if not before:
        check(f'[{route}] globe state readable', False, 'no viewer')
        return
    check(f'[{route}] globe state readable', True,
          f"h={before['height']} sats={before['satPoints']} shown={before['satPointsShown']}")

    box = page.locator('canvas').first.bounding_box()
    cx, cy = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2

    # --- drag-rotate ---
    page.mouse.move(cx, cy)
    page.mouse.down()
    for dx in range(0, 320, 40):
        page.mouse.move(cx - dx, cy + dx // 4)
        time.sleep(0.05)
    page.mouse.up()
    time.sleep(2.5)
    shot('globe-rotated')
    after_drag = globe_state(page)
    moved = (abs(after_drag['lon'] - before['lon']) > 0.5
             or abs(after_drag['lat'] - before['lat']) > 0.5
             or abs(after_drag['heading'] - before['heading']) > 0.5)
    check(f'[{route}] drag rotates the camera', moved,
          f"lon {before['lon']}->{after_drag['lon']} lat {before['lat']}->{after_drag['lat']}")

    # --- zoom in ---
    page.mouse.move(cx, cy)
    for _ in range(6):
        page.mouse.wheel(0, -400)
        time.sleep(0.25)
    time.sleep(2.5)
    shot('globe-zoomed-in')
    zoomed = globe_state(page)
    check(f'[{route}] wheel zooms in', zoomed['height'] < after_drag['height'] * 0.97,
          f"{after_drag['height']} -> {zoomed['height']} m")

    # Threshold calibrated against both states on this box: a rendering globe
    # samples ~114 distinct colours, the same page with globe+skybox+atmosphere
    # hidden samples ~30 (page chrome alone). 60 sits between them with margin
    # on each side. Verified by blanking a live globe and watching this fail.
    blank = canvas_is_not_blank(page)
    check(f'[{route}] globe canvas renders content',
          blank.get('ok') and blank.get('distinctColors', 0) > 60, json.dumps(blank))

    # --- zoom back out ---
    for _ in range(6):
        page.mouse.wheel(0, 400)
        time.sleep(0.25)
    time.sleep(2.0)
    shot('globe-zoomed-out')

    # --- click near a satellite dot to try the inspector ---
    page.mouse.click(cx, cy)
    time.sleep(1.5)
    shot('globe-clicked')


def exercise_layers(page, shot, route):
    """Toggle each layer checkbox and confirm the scene grows."""
    cbs = page.locator('#layers-hud .layer-cb, #layer-list .layer-cb')
    n = cbs.count()
    if n == 0:
        return
    print(f'    [layers] {n} layer checkboxes')

    checked_at_boot = page.evaluate(
        '''[...document.querySelectorAll('#layer-list .layer-cb')]
             .filter(c => c.checked).length''')
    check(f'[{route}] some layer is on at boot', checked_at_boot > 0,
          f'{checked_at_boot}/{n} checked — an all-off boot shows an empty globe')

    before = globe_state(page)
    # Turn on the first few non-builtin layers.
    turned_on = []
    for i in range(min(n, 4)):
        cb = cbs.nth(i)
        try:
            group = cb.get_attribute('data-group')
            if cb.is_checked():
                continue
            cb.check(force=True, timeout=5000)
            turned_on.append(group)
            time.sleep(3.5)
        except Exception as ex:
            print(f'    [layers] {group}: {str(ex)[:70]}')
    time.sleep(4)
    shot('layers-on')
    after = globe_state(page)
    if turned_on:
        check(f'[{route}] enabling layers adds satellites',
              after['satPointsShown'] > before['satPointsShown'],
              f"shown {before['satPointsShown']} -> {after['satPointsShown']} "
              f"after {turned_on}")

    # HUD count must agree with what is actually drawn.
    hud = page.evaluate(
        '''(document.getElementById('hud-sat-count') || {}).textContent''')
    if hud and hud.strip().isdigit():
        hud_n = int(hud.strip())
        check(f'[{route}] HUD count matches rendered satellites',
              abs(hud_n - after['satPointsShown']) <= max(2, after['satPointsShown'] * 0.1),
              f"HUD={hud_n} rendered={after['satPointsShown']}")


def exercise_panels(page, shot, route):
    """Open every collapsible HUD panel / tab / details element."""
    # HUD panel toggles.
    toggles = page.locator('.key-hud__toggle, .hud-toggle, [data-hud-toggle]')
    for i in range(min(toggles.count(), 8)):
        try:
            toggles.nth(i).click(timeout=3000, force=True)
            time.sleep(0.5)
        except Exception:
            pass
    if toggles.count():
        shot('hud-panels-toggled')

    # Tabs.
    tabs = page.locator('[role="tab"], .tab, .st-tab, [data-tab]')
    tcount = tabs.count()
    for i in range(min(tcount, 8)):
        try:
            tabs.nth(i).click(timeout=3000, force=True)
            time.sleep(1.2)
            shot(f'tab-{i}')
        except Exception:
            pass
    if tcount:
        print(f'    [tabs] exercised {min(tcount, 8)}/{tcount}')

    # <details> blocks (wiki/about).
    det = page.locator('details')
    for i in range(min(det.count(), 12)):
        try:
            det.nth(i).evaluate('d => d.open = true')
        except Exception:
            pass
    if det.count():
        time.sleep(0.6)
        shot('details-expanded', full=True)


def exercise_forms(page, shot, route):
    """Signal / conjunctions: run the actual computation buttons."""
    buttons = page.locator(
        'button:not([disabled])').filter(has_text=re.compile(
            r'compute|run|predict|screen|search|calculate|go', re.I))
    for i in range(min(buttons.count(), 4)):
        try:
            label = buttons.nth(i).inner_text(timeout=2000)[:28]
            buttons.nth(i).click(timeout=4000)
            time.sleep(5)
            shot(f'action-{re.sub(r"[^a-z0-9]+", "-", label.lower())}')
            print(f'    [action] clicked "{label}"')
        except Exception:
            pass


def audit_freshness(page, route):
    """Are the numbers on the page real and recent?"""
    data = page.evaluate(r'''() => {
        const txt = document.body.innerText;
        // ISO timestamps and "N hours/days ago" phrasing anywhere on the page.
        const iso = [...txt.matchAll(/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?/g)]
            .map(m => m[0]).slice(0, 20);
        const ago = [...txt.matchAll(/(\d+)\s*(minute|hour|day)s?\s*ago/gi)]
            .map(m => m[0]).slice(0, 10);
        return { iso, ago, len: txt.length };
    }''')
    now = time.time()
    stale, fresh = [], []
    for s in data['iso']:
        try:
            t = time.mktime(time.strptime(s[:10], '%Y-%m-%d'))
        except Exception:
            continue
        age_days = (now - t) / 86400
        # Only judge dates that look like data timestamps, not historical content.
        if -2 < age_days < 400:
            (fresh if age_days <= 3 else stale).append(f'{s} ({age_days:.1f}d)')
    print(f"    [freshness] fresh={fresh[:6]} stale={stale[:6]} ago={data['ago'][:5]}")
    return {'fresh': fresh, 'stale': stale, 'ago': data['ago']}


def main():
    os.makedirs(ART, exist_ok=True)
    console = {}

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            executable_path=pw.chromium.executable_path, headless=True,
            args=['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist',
                  '--enable-gpu', '--disable-gpu-sandbox'],
        )

        for route in ROUTES:
            print(f'\n{"=" * 66}\nROUTE: {route}\n{"=" * 66}')
            outdir = os.path.join(ART, slug(route))
            os.makedirs(outdir, exist_ok=True)
            ctx = browser.new_context(
                viewport={'width': 1400, 'height': 900},
                record_video_dir=outdir,
                record_video_size={'width': 1400, 'height': 900},
            )
            page = ctx.new_page()
            errs = []
            page.on('console', lambda m, e=errs: e.append(m.text) if m.type == 'error' else None)
            page.on('pageerror', lambda ex, e=errs: e.append(f'PAGEERROR {ex}'))
            page.on('response', lambda r, e=errs:
                    e.append(f'HTTP {r.status} {r.url}') if r.status >= 400 else None)
            shot = Shot(page, outdir)

            try:
                resp = page.goto(BASE + route, timeout=60000, wait_until='domcontentloaded')
                check(f'[{route}] HTTP ok', resp and resp.status == 200,
                      str(resp.status if resp else 'none'))
                time.sleep(16 if route in GLOBE_ROUTES else 5)
                shot('loaded')

                if route in GLOBE_ROUTES:
                    drive_globe(page, shot, route)
                    exercise_layers(page, shot, route)

                exercise_panels(page, shot, route)
                exercise_forms(page, shot, route)
                audit_freshness(page, route)

                shot('final', full=(route not in GLOBE_ROUTES))
            except Exception as ex:
                check(f'[{route}] ran without exception', False, str(ex)[:200])
            finally:
                console[route] = errs
                page.close()
                ctx.close()   # flushes the video file
                print(f'    [artifacts] {outdir}')

        browser.close()

    print(f'\n{"=" * 66}\nCONSOLE / HTTP ERRORS\n{"=" * 66}')
    for route, errs in console.items():
        uniq = list(dict.fromkeys(errs))
        if uniq:
            print(f'\n{route}:')
            for e in uniq[:12]:
                print(f'   {e[:180]}')

    passed = sum(1 for _, ok, _ in results if ok)
    print(f'\n{"=" * 66}\nRESULT: {passed}/{len(results)} passed\n{"=" * 66}')
    for name, ok, detail in results:
        if not ok:
            print(f'  FAIL  {name} :: {detail}')
    return 0 if passed == len(results) else 1


if __name__ == '__main__':
    sys.exit(main())
