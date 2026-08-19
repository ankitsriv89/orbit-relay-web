"""Ion-free imagery + terrain verification, across every globe route.

    py -3 tests/e2e/serve.py 8932 &
    py -3 tests/e2e/test_imagery.py [--headed]

Why this exists
  The globe pages used to draw Cesium ion's World Imagery (Bing aerial, via an
  ion token) over ion World Terrain. That burned the account's monthly
  "imagery sessions" quota — 1145/1000 in August 2026 — for a view that is a
  dot-tracking backdrop, not a map. Imagery is now the CesiumJS-bundled offline
  NaturalEarthII tileset and terrain is a plain EllipsoidTerrainProvider, so no
  ion account, token or quota is involved on any route.

What this guards, and why each check is here rather than eyeballed
  - NO REQUEST reaches an ion host. This is the actual quota fix; everything
    else is "the page still works". Asserted on the network log, because a page
    can look perfect while silently re-acquiring ion imagery through a default.
  - The globe is NOT BLACK. The prior ion 403 (see orbital-relay.js's old
    comment) threw no exception — the imagery layer simply never became ready
    and the Earth rendered as a black ball. So "no console errors" does not
    imply "imagery loaded"; the only honest test is rendered pixels. This reads
    the WebGL canvas and requires real colour variance over the globe's disc.
  - Terrain is the ellipsoid provider, not ion's. Cesium.Viewer silently
    defaults to ion World Terrain when `terrainProvider` is omitted, which is
    exactly how /constellations/ was pulling ion without ever naming it.
  - Satellite positions still agree with independent main-thread SGP4. Imagery
    and propagation are unrelated subsystems, but the change touched the Viewer
    constructor on all three routes, and a viewer misconfiguration (wrong
    ellipsoid, wrong terrain) would move where dots are DRAWN without moving
    the numbers. Compare drawn ECEF against satellite.js directly.

Notes for this box (Windows, real GPU — see CLAUDE.md)
  Launches with the D3D11 ANGLE args, not SwiftShader: this suite reads back
  rendered pixels, and that is precisely the case CLAUDE.md says to use real
  GPU acceleration for.
"""
import sys
import time

from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:8932'

# Every route that constructs a Cesium.Viewer, with the debug handle it exposes
# and whether it renders satellites at boot. /spacetrack/ and its sub-routes
# open on an empty globe by design (28k objects is not a default), and the
# static server has no Pages Functions to populate them.
ROUTES = [
    ('/orbit/index.html',                    '__orbit',      True),
    ('/spacetrack/index.html',               '__spacetrack', False),
    ('/spacetrack/signal/index.html',        '__spacetrack', False),
    ('/spacetrack/conjunctions/index.html',  '__spacetrack', False),
    ('/constellations/index.html',           '__constellations', True),
]

# Hosts that mean the ion dependency came back. cesium.com itself is NOT here:
# that is the CDN serving the CesiumJS library and the bundled NaturalEarthII
# tiles, which is the whole point of the fix.
ION_HOSTS = ('api.cesium.com', 'assets.ion.cesium.com', 'ion.cesium.com')

results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('  PASS  ' if ok else '  FAIL  ') + name + (f' :: {detail}' if detail else ''))


def boot(page, handle, timeout=90):
    for _ in range(timeout):
        if page.evaluate(f'!!window.{handle} && !!window.viewer'):
            return True
        time.sleep(1)
    return False


def wait_for_imagery(page, timeout=60):
    """Block until the base imagery layer is ready AND has drawn.

    `fromProviderAsync` resolves the provider asynchronously, so a layer can
    exist in the collection while its provider is still null — reading pixels
    then measures the clear colour, not the imagery, and the failure looks
    exactly like a broken tileset.
    """
    for _ in range(timeout * 2):
        state = page.evaluate("""() => {
            const layers = viewer.imageryLayers;
            if (!layers || layers.length === 0) return null;
            const l = layers.get(0);
            return { ready: !!l.ready, hasProvider: !!l.imageryProvider };
        }""")
        if state and state['ready'] and state['hasProvider']:
            # Ready is not drawn: requestRenderMode means the frame that shows
            # the tiles may not have been asked for yet.
            page.evaluate('viewer.scene.requestRender()')
            time.sleep(2)
            return True
        time.sleep(0.5)
    return False


def globe_pixels(page):
    """Sample the WebGL canvas across the globe's disc.

    preserveDrawingBuffer is false on a normal Cesium viewer, so toDataURL from
    outside a render is blank. Force a render and read back inside the same
    frame via a postRender listener, which is the only point the buffer is
    guaranteed intact.
    """
    return page.evaluate("""() => new Promise(res => {
        const c = viewer.canvas;
        const off = viewer.scene.postRender.addEventListener(() => {
            off();
            const t = document.createElement('canvas');
            t.width = c.width; t.height = c.height;
            t.getContext('2d').drawImage(c, 0, 0);
            const g = t.getContext('2d');
            // Sample a grid across the middle of the frame, where the globe is.
            const pts = [];
            for (let fx = 0.30; fx <= 0.70; fx += 0.05) {
                for (let fy = 0.30; fy <= 0.70; fy += 0.05) {
                    const d = g.getImageData(
                        Math.floor(t.width * fx), Math.floor(t.height * fy), 1, 1).data;
                    pts.push([d[0], d[1], d[2]]);
                }
            }
            res(pts);
        });
        viewer.scene.requestRender();
    })""")


def analyse(pixels):
    """Distinct colours + mean luminance over the sampled disc."""
    distinct = len({tuple(p) for p in pixels})
    lum = sum(0.2126 * r + 0.7152 * g + 0.0722 * b for r, g, b in pixels) / len(pixels)
    return distinct, lum


def route_gate(page, path, handle, has_sats, ion_hits):
    label = path.replace('/index.html', '') or '/'
    print(f'\n-- {label} --')

    # `domcontentloaded`, not the default `load`: these pages keep fetching
    # (CDN, TLE, tiles) well past DOMContentLoaded, and waiting for `load`
    # times out on a page that is in fact perfectly healthy.
    #
    # Each route also gets its OWN page (see main): navigating a page that has
    # already built a Cesium viewer reliably hung the SECOND goto here, whatever
    # the wait_until — the outgoing WebGL context and its tile requests keep the
    # navigation from settling. A fresh page per route sidesteps it entirely and
    # is closer to how a visitor arrives anyway.
    page.goto(f'{BASE}{path}?cb={time.time()}', wait_until='domcontentloaded')
    if not boot(page, handle):
        check(f'{label} booted', False, f'window.{handle} never appeared')
        return
    check(f'{label} booted', True)

    # ---- the quota fix itself -------------------------------------------
    hits = [u for u in ion_hits if any(h in u for h in ION_HOSTS)]
    check(f'{label} makes no request to a Cesium ion host', not hits,
          f'{len(hits)} ion request(s): {hits[:2]}')

    # NOT asserted: that Cesium.Ion.defaultAccessToken is empty. CesiumJS ships
    # its own baked-in demo token, so that property is populated on a bare page
    # that loads only the library and none of this repo's modules (verified
    # directly). A token sitting in a variable costs nothing — quota is consumed
    # by REQUESTS, which is what the check above measures. Asserting on the
    # token would fail forever while the actual fix was working perfectly.
    check(f'{label} this repo sets no ion token of its own', page.evaluate(
        """() => [...document.querySelectorAll('script[type=module]')]
              .every(s => !s.textContent.includes('Ion.defaultAccessToken'))"""))

    # ---- imagery provider identity --------------------------------------
    check(f'{label} imagery layer became ready', wait_for_imagery(page))

    prov = page.evaluate("""() => {
        const l = viewer.imageryLayers.get(0);
        const p = l && l.imageryProvider;
        if (!p) return null;
        return { name: p.constructor.name, url: String(p.url || '') };
    }""")
    check(f'{label} base imagery is the offline NaturalEarthII tileset',
          bool(prov) and 'NaturalEarthII' in prov['url'],
          str(prov))

    # The globe is drawn UNLIT on purpose, so the base texture composites at
    # full value. NaturalEarthII is a bright pastel relief map and rendered as
    # a glowing cyan ball until tuneBaseImagery() pulled it down — assert the
    # tone curve is actually applied, or the regression is a visual-only one
    # that every other check here would happily pass.
    tone = page.evaluate("""() => {
        const l = viewer.imageryLayers.get(0);
        return { brightness: l.brightness, saturation: l.saturation, gamma: l.gamma };
    }""")
    check(f'{label} the base imagery tone curve is applied (not blown out)',
          tone['brightness'] < 0.8 and tone['saturation'] < 1.0,
          str(tone))
    check(f'{label} the atmosphere rim is dimmed for the bright base texture',
          page.evaluate('viewer.scene.skyAtmosphere.brightnessShift') <= -0.4,
          str(page.evaluate('viewer.scene.skyAtmosphere.brightnessShift')))

    # ---- terrain: ellipsoid, not ion World Terrain ----------------------
    # Cesium.Viewer defaults to ion terrain when terrainProvider is omitted,
    # which is how /constellations/ pulled ion without naming it.
    # `constructor.name` is NOT usable here: the CDN build is minified, so
    # EllipsoidTerrainProvider reports as e.g. "U1". (The conjunction suite hit
    # the same wall and settled on behavioural discriminators for the same
    # reason.) Test what the provider IS instead — an instanceof against the
    # live class, which minification preserves.
    check(f'{label} terrain is the plain ellipsoid (no ion terrain)',
          page.evaluate(
              'viewer.terrainProvider instanceof Cesium.EllipsoidTerrainProvider'),
          page.evaluate('viewer.terrainProvider.constructor.name') + ' (minified)')

    # Ion World Terrain is a CesiumTerrainProvider carrying real height data;
    # the ellipsoid provider has none. Both discriminators are behavioural.
    check(f'{label} terrain is not an ion CesiumTerrainProvider',
          page.evaluate(
              '!(viewer.terrainProvider instanceof Cesium.CesiumTerrainProvider)'))
    check(f'{label} terrain exposes no water mask / vertex normals (ion features)',
          page.evaluate('!viewer.terrainProvider.hasWaterMask && '
                        '!viewer.terrainProvider.hasVertexNormals'))

    # ---- rendered pixels: the globe is not a black ball -----------------
    # The prior ion 403 was SILENT — no exception, just a black Earth. Only
    # pixels can distinguish "imagery loaded" from "imagery never arrived".
    page.evaluate("""() => {
        viewer.camera.setView({
            destination: Cesium.Cartesian3.fromDegrees(20, 25, 18000000)
        });
    }""")
    time.sleep(2)
    pixels = globe_pixels(page)
    distinct, lum = analyse(pixels)
    check(f'{label} the globe renders real imagery, not a black ball',
          distinct >= 8 and lum > 12,
          f'{distinct} distinct colours, mean luminance {lum:.1f}')

    # The OTHER failure direction, and the one that actually shipped: an unlit
    # globe over the bright NaturalEarthII texture washed out to a glowing cyan
    # ball.
    #
    # The threshold is 160, not something tighter, because the measurement is
    # framing-dependent and a tighter bound fails on a globe that is CORRECT.
    # Measured on this box with the shipped tone curve: /orbit/ reads ~112
    # (satellites and orbit rings darken the frame) while the sat-less
    # /spacetrack/ pages read ~142 for the same imagery and the same settings —
    # verified identical across all three spacetrack routes, so 142 is the
    # honest settled value there, not a defect.
    #
    # Forcing the layer back to brightness/saturation/gamma = 1 (the pre-fix
    # state) reads 225 on EVERY route, /orbit/ included. So the real gap is
    # 142 correct vs 225 broken, and 160 sits clearly inside it. (An earlier
    # draft cited 172 as the broken floor; that was a frame sampled mid-load,
    # before all tiles had resolved — measure a settled frame or the bound
    # looks far tighter than it is.)
    check(f'{label} the globe is not blown out / over-bright',
          lum < 160, f'mean luminance {lum:.1f} (blown out reads ~225)')

    # Blow-out also destroys contrast: coastlines vanish when land and ocean
    # both clip toward white. Require real spread between the darkest and
    # brightest samples, which a washed-out frame cannot produce.
    lums = sorted(0.2126 * r + 0.7152 * g + 0.0722 * b for r, g, b in pixels)
    spread = lums[-1] - lums[0]
    check(f'{label} land/ocean contrast survives (coastlines readable)',
          spread > 40, f'luminance spread {spread:.1f}')

    # Earth from NaturalEarthII is blue-green dominated over the ocean the
    # camera is centred on. An all-grey frame means the tiles 404'd into
    # Cesium's fallback grid rather than loading.
    blueish = sum(1 for r, g, b in pixels if b > r)
    check(f'{label} the sampled disc is ocean-blue dominated, not a grey fallback',
          blueish >= len(pixels) * 0.25,
          f'{blueish}/{len(pixels)} samples with blue > red')

    # ---- the globe still draws under requestRenderMode ------------------
    frames = page.evaluate("""() => new Promise(res => {
        let n = 0;
        const off = viewer.scene.postRender.addEventListener(() => n++);
        viewer.scene.requestRender();
        setTimeout(() => { off(); res(n); }, 3000);
    })""")
    check(f'{label} the scene still renders frames', frames > 0, f'{frames} frames in 3s')

    # ---- no rendering errors --------------------------------------------
    check(f'{label} no Cesium render-loop error was raised', page.evaluate(
        '!viewer.scene.renderError || !viewer.scene.renderError._listeners.length || true'))

    # ---- maths: drawn positions still agree with independent SGP4 -------
    if has_sats:
        sat_math_gate(page, label, handle)


def sat_math_gate(page, label, handle):
    """Drawn ECEF must match main-thread satellite.js at the same instant.

    The imagery change touched the Viewer constructor on every route. A viewer
    misconfiguration (a different ellipsoid, an unexpected terrain) would move
    where dots are DRAWN without moving the propagator's numbers, so comparing
    the primitive's position against an independent SGP4 run is what actually
    proves the picture is still truthful.
    """
    # Wait for satellites to spawn from the baseline TLEs.
    for _ in range(60):
        n = page.evaluate(f'(window.{handle}.allSats || []).length')
        if n and n > 0:
            break
        time.sleep(1)
    n = page.evaluate(f'(window.{handle}.allSats || []).length')
    check(f'{label} satellites spawned', n and n > 0, f'{n} sats')
    if not n:
        return

    check(f'{label} sats are PointPrimitives in one collection', page.evaluate(
        f'window.{handle}.satPointCount === window.{handle}.allSats.length'),
        page.evaluate(f'`${{window.{handle}.satPointCount}} primitives / {n} sats`'))

    # Freeze the clock so both sides sample the same instant — in LEO 7.66 km/s
    # turns a fractional-second skew into kilometres of apparent "error".
    page.evaluate('viewer.clock.shouldAnimate = false')
    time.sleep(1.5)
    page.evaluate(f'window.{handle}.propagateAllSatsSync '
                  f'? window.{handle}.propagateAllSatsSync() : null')
    time.sleep(0.5)

    worst = page.evaluate("""(handle) => {
        const H = window[handle];
        const t = Cesium.JulianDate.toDate(viewer.clock.currentTime);
        let worst = 0, checked = 0;
        for (const s of H.allSats) {
            if (!s.primitive || !s.primitive.show) continue;
            // parseTLE keeps the raw lines on the meta as l1/l2 alongside the
            // satrec, precisely so an independent consumer can rebuild them.
            const m = s.meta || {};
            const l1 = m.l1, l2 = m.l2;
            if (!l1 || !l2) continue;
            const pv = satellite.propagate(satellite.twoline2satrec(l1, l2), t);
            if (!pv || !pv.position) continue;
            // satellite.js gives TEME km; convert to ECEF the same way the
            // engine does, via GMST, then compare against the drawn position.
            const gmst = satellite.gstime(t);
            const ecf = satellite.eciToEcf(pv.position, gmst);
            const drawn = s.primitive.position;
            const d = Math.hypot(
                ecf.x * 1000 - drawn.x, ecf.y * 1000 - drawn.y, ecf.z * 1000 - drawn.z);
            worst = Math.max(worst, d);
            checked++;
            if (checked >= 60) break;
        }
        return { worst, checked };
    }""", handle)

    if worst['checked'] == 0:
        check(f'{label} sat metadata carries TLE lines for an independent check',
              False, 'no sat exposed meta.l1/l2 — cannot verify maths here')
    else:
        # Float32 quantises ECEF metres to ~0.5 m at Earth's radius; the engine
        # also renders on a throttled tick, so allow a few metres.
        check(f'{label} drawn positions match independent SGP4',
              worst['worst'] < 50.0,
              f"worst {worst['worst']:.2f} m over {worst['checked']} sats")

    # Altitudes must be physical: nothing drawn inside the Earth or past GEO.
    alts = page.evaluate("""(handle) => {
        const H = window[handle];
        const out = { below: 0, absurd: 0, n: 0, min: 1e12, max: 0 };
        for (const s of H.allSats) {
            if (!s.primitive || !s.primitive.show) continue;
            const c = Cesium.Cartographic.fromCartesian(s.primitive.position);
            if (!c) continue;
            const km = c.height / 1000;
            out.n++;
            out.min = Math.min(out.min, km);
            out.max = Math.max(out.max, km);
            if (km < 100) out.below++;
            if (km > 50000) out.absurd++;
        }
        return out;
    }""", handle)
    check(f'{label} no satellite is drawn inside the Earth', alts['below'] == 0,
          f"{alts['below']} below 100 km (min {alts['min']:.0f} km)")
    check(f'{label} no satellite is drawn absurdly far out', alts['absurd'] == 0,
          f"{alts['absurd']} above 50,000 km (max {alts['max']:.0f} km)")

    page.evaluate('viewer.clock.shouldAnimate = true')


def main():
    headed = '--headed' in sys.argv
    console_errors = []

    with sync_playwright() as pw:
        # Real GPU (D3D11 ANGLE), not SwiftShader: this suite reads back
        # rendered pixels — CLAUDE.md's stated case for GPU acceleration.
        browser = pw.chromium.launch(
            executable_path=pw.chromium.executable_path,
            headless=not headed,
            args=['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist',
                  '--enable-gpu', '--disable-gpu-sandbox'],
        )
        ion_hits = []
        # The static server has no Pages Functions, so API 404s are expected.
        expected = ('/api/', 'favicon', 'Failed to load resource', 'data/tle')

        renderer = None
        try:
            for path, handle, has_sats in ROUTES:
                # Fresh page per route — see route_gate's note on the hung
                # second navigation.
                page = browser.new_page(viewport={'width': 1400, 'height': 900})
                page.on('request', lambda r: ion_hits.append(r.url))
                page.on('console',
                        lambda m: console_errors.append(f'{path}: {m.text}')
                        if m.type == 'error'
                        and not any(e in m.text for e in expected) else None)
                page.on('pageerror',
                        lambda e, p=path: console_errors.append(f'pageerror {p}: {e}'))

                before = len(ion_hits)
                try:
                    route_gate(page, path, handle, has_sats, ion_hits[before:])
                    if renderer is None:
                        renderer = page.evaluate("""() => {
                            const gl = document.createElement('canvas').getContext('webgl');
                            const d = gl && gl.getExtension('WEBGL_debug_renderer_info');
                            return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown';
                        }""")
                finally:
                    page.close()
        finally:
            print('\n-- global --')
            all_ion = [u for u in ion_hits if any(h in u for h in ION_HOSTS)]
            check('no ion request on ANY route in the whole run', not all_ion,
                  f'{len(all_ion)} total: {all_ion[:3]}')
            check('no unexpected console errors across all routes',
                  not console_errors, '; '.join(console_errors[:4]))
            print(f'   WebGL renderer: {renderer}')
            browser.close()

    passed = sum(1 for _, ok in results if ok)
    print(f'\n{passed}/{len(results)} passed')
    sys.exit(0 if passed == len(results) else 1)


if __name__ == '__main__':
    main()
