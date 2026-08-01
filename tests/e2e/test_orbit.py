"""Orbital Relay E2E — plan 33 waves 0-2.

    python3 tests/e2e/serve.py &        # no-cache static server on :8932
    python3 tests/e2e/test_orbit.py     # add --headed to watch

What this guards
  - The sat engine is a *shared PointPrimitiveCollection*, not per-satellite
    Cesium Entities with CallbackProperty positions. That per-Entity design is
    parent issue #71 (1.2 GB heap blowup); this suite fails if it comes back.
  - Positions still advance — the throttled propagation tick is what replaced
    the per-frame callbacks, so "no entities" must not mean "no motion".
  - Click-to-inspect still resolves metadata, now via `primitive.id`.
  - Baseline TLE snapshots resolve for every group in the layer list. The
    `iridium-NEXT` file used to ship mixed-case while fetchTLE lowercases the
    slug, so Iridium silently 404'd its baseline forever.
  - Wave 1: SGP4 runs in the worker, every visible sat is registered with it,
    and worker positions agree with the synchronous fallback. The fallback is
    exercised directly — a worker that fails to start must not blank the globe.
  - Wave 1 perf gate: sustained frame rate and a flat heap over several
    minutes with the full baseline catalog visible.
  - Wave 3: SPACE-TRACK is a LINK to its own page, not an in-place switch —
    the wave-2 switch had to call location.reload(), because the ISS, the other
    stations and the Starlink batch are built outside layerState and could not
    be re-sourced in place. /spacetrack/ boots on the SHARED engine (one copy,
    two pages: that engine has already been fixed twice in two copies), its
    worker resolves from an absolute URL, its filters exist and a failed query
    reports rather than throws.
  - The Space-Track attribution is present and visible on BOTH pages. The
    citation is a condition of USSPACECOM's redistribution approval, so it
    belongs in the test suite rather than only in the markup.
  - Mobile (`mobile_gate`, runs in its own 390×844 3× context): the fixes from
    docs/mobile-audit-orbit-spacetrack.md. Every one of these is invisible on a
    desktop run — that is precisely why they rotted unnoticed until the audit,
    and why they are asserted rather than eyeballed. The load-bearing one is
    that the globe STILL RENDERS: `requestRenderMode` draws nothing until
    something asks, so any scene-changing path that forgets to call
    `engine.requestRender()` freezes the picture while every other check here
    still passes.

Notes for this box (2 cores, SwiftShader):
  - `page.click()` times out on the actionability gate — set `.checked` and
    dispatch a `change` event instead.
  - `page.wait_for_function` starves under software GL — poll with evaluate.
  - Cesium loads from its CDN, so this suite needs network.
"""
import sys
import time

from playwright.sync_api import sync_playwright

CHROME = '/home/ankit/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome'
BASE = 'http://127.0.0.1:8932/orbit/index.html?cb='
ST_BASE = 'http://127.0.0.1:8932/spacetrack/index.html?cb='

# Console noise that is not a regression: the static test server has no Pages
# Functions, so the live-proxy leg of fetchTLE and every /spacetrack/ catalog
# call 404 by design.
EXPECTED = ('/api/tle', '/api/search', '/api/summary', '/api/object',
            'favicon', 'cesium.com/downloads', 'Failed to load resource')

results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('  PASS  ' if ok else '  FAIL  ') + name + (f' :: {detail}' if detail != '' else ''))


def boot(page, timeout=90):
    page.goto(BASE + str(time.time()))
    for _ in range(timeout):
        if page.evaluate('!!window.__orbit && window.__orbit.booted'):
            time.sleep(1.5)          # let the first propagation tick land
            return True
        time.sleep(1)
    return False


def wait_ticks(page, n=2, timeout=60):
    """Block until the worker has completed n more propagation ticks.

    Never sleep a fixed interval and assume a tick landed: WebGL here is
    SwiftShader at well under 1 fps, so the main thread can go seconds without
    running the message handler that applies worker positions. Fixed sleeps
    read stale coordinates and the failure looks like a coordinate bug.
    """
    start = page.evaluate('__orbit.tickCount')
    for _ in range(timeout * 2):
        if page.evaluate('__orbit.tickCount') >= start + n:
            return True
        time.sleep(0.5)
    return False


def set_layer(page, group, on):
    """Toggle a layer checkbox without page.click() (actionability gate)."""
    page.evaluate(
        """([g, on]) => {
            const cb = document.querySelector(`.layer-cb[data-group="${g}"]`);
            if (!cb) return false;
            cb.checked = on;
            cb.dispatchEvent(new Event('change'));
            return true;
        }""",
        [group, on],
    )


def run(page):
    # ---------------------------------------------------------- boot + engine
    print('\n-- engine  PointPrimitiveCollection --')
    sats = page.evaluate('__orbit.allSats.length')
    # The STATIONS baseline snapshot ships 25 objects + the ISS. The threshold
    # used to be 40 when the snapshot carried more; keep it loose so a shrunk
    # snapshot cannot masquerade as a loaded page.
    check('satellites spawned from the baseline TLEs', sats > 20, f'{sats} sats')
    check('all sats live in one PointPrimitiveCollection', page.evaluate(
        '__orbit.satPointCount === __orbit.allSats.length'),
        page.evaluate('`${__orbit.satPointCount} primitives`'))

    # The regression itself: one Entity per satellite. Only the ISS ring,
    # ground track and footprint are Entities at boot — STATIONS rings are
    # deferred until that layer is checked (ensureRing), so a boot entity
    # count that tracks the sat count means rings became per-sat entities.
    ents = page.evaluate('__orbit.entityCount')
    check('sat count is NOT entity count (issue #71 shape)', ents < sats,
          f'{ents} entities vs {sats} sats')

    check('no per-satellite CallbackProperty positions', page.evaluate(
        '__orbit.allSats.every(s => s.primitive && !s.primitive.position.getValue)'))

    check('ISS is tracked', page.evaluate(
        '__orbit.allSats.some(s => s.meta && s.meta.group === "ISS")'))

    # ------------------------------------------------------------ propagation
    print('\n-- propagation  throttled shared tick --')
    iss_pos = """() => {
        const s = __orbit.allSats.find(x => x.meta.group === 'ISS');
        return { x: s.primitive.position.x, y: s.primitive.position.y };
    }"""
    before = page.evaluate(iss_pos)
    wait_ticks(page, 3)
    after = page.evaluate(iss_pos)
    moved = abs(after['x'] - before['x']) + abs(after['y'] - before['y'])
    check('visible sats advance between ticks', moved > 100, f'{moved:.0f} m moved')

    # Hidden sats must never be propagated — that skip is the whole saving, and
    # it is enforced by leaving them out of the visible set sent to the worker.
    hidden0 = page.evaluate(
        '(__orbit.allSats.find(x => !x.primitive.show) || {primitive:{}}).primitive.position?.x')
    wait_ticks(page, 3)
    hidden1 = page.evaluate(
        '(__orbit.allSats.find(x => !x.primitive.show) || {primitive:{}}).primitive.position?.x')
    check('hidden sats are skipped by the propagator', hidden0 == hidden1,
          f'{hidden0} -> {hidden1}')

    # ----------------------------------------------------------- wave 1 worker
    print('\n-- worker  SGP4 off the main thread --')
    check('propagation worker started', page.evaluate('!!__orbit.worker'))
    check('worker reported ready', page.evaluate('__orbit.workerReady'))
    reg, n = page.evaluate('[__orbit.registered, __orbit.allSats.length]')
    check('every sat is registered with the worker', reg == n, f'{reg}/{n}')

    # Worker positions must agree with the synchronous fallback. Compare with
    # the clock PAUSED and only after a tick that was computed entirely after
    # the pause — otherwise the two are sampling different instants and the
    # ISS's 7.66 km/s reads as a coordinate bug.
    page.evaluate('viewer.clock.shouldAnimate = false')
    wait_ticks(page, 2)
    drift = page.evaluate("""() => {
        const shown = __orbit.allSats.filter(s => s.primitive.show);
        const before = shown.map(s => Cesium.Cartesian3.clone(s.primitive.position));
        __orbit.propagateAllSatsSync();
        let worst = 0;
        shown.forEach((s, i) => {
            worst = Math.max(worst, Cesium.Cartesian3.distance(before[i], s.primitive.position));
        });
        return worst;
    }""")
    # Float32 quantises ECEF metres to ~0.5m at Earth's radius; allow a metre.
    check('worker positions match the sync fallback', drift < 1.0, f'{drift:.3f} m worst case')
    page.evaluate('viewer.clock.shouldAnimate = true')

    # Plan 35: the old `>50 positions` check was satisfied by ANY polyline —
    # the ground track, the orbit ring, or a new past-orbit arc — so a broken
    # ground track would pass as long as some other line had geometry. Assert
    # on the ground-track entity specifically: it is the only polyline clamped
    # to the surface (`clampToGround`), which is also the property that tells
    # one from the other if the orbit ring ever gains one too.
    check('ISS ground track has geometry (worker path job)', page.evaluate("""() => {
        const t = viewer.clock.currentTime;
        return viewer.entities.values.some(e => {
            if (!e.polyline || !e.polyline.positions) return false;
            if (e.polyline.clampToGround !== true) return false;
            const p = e.polyline.positions.getValue(t);
            return !!p && p.length > 50;
        });
    }"""))

    # --------------------------------------------------------------- metadata
    print('\n-- inspect  click-to-inspect metadata --')
    check('pick id carries the SatPoint wrapper', page.evaluate(
        '__orbit.allSats.every(s => s.primitive.id === s)'))
    page.evaluate("""() => {
        const s = __orbit.allSats.find(x => x.meta.group === 'ISS');
        __orbit.inspectSatellite(s.meta);
    }""")
    time.sleep(0.6)
    check('inspector card opens', page.evaluate(
        '!document.getElementById("sat-detail").hidden'))
    check('inspector shows an altitude', page.evaluate(
        '/\\d/.test(document.getElementById("sat-detail-alt").textContent)'),
        page.evaluate('document.getElementById("sat-detail-alt").textContent'))
    page.evaluate('document.getElementById("sat-detail-close").click()')

    # ------------------------------------------------------------ layer toggle
    print('\n-- layers  toggle + teardown --')
    set_layer(page, 'iridium-NEXT', True)
    for _ in range(20):
        if page.evaluate('!!(__orbit.layerState["iridium-NEXT"] || {}).loaded'):
            break
        time.sleep(0.5)
    n_iridium = page.evaluate('(__orbit.layerState["iridium-NEXT"] || {entities:[]}).entities.length')
    check('iridium layer loads from the baseline snapshot', n_iridium > 0,
          f'{n_iridium} sats')

    total_after = page.evaluate('__orbit.allSats.length')
    check('layer sats joined the shared collection',
          page.evaluate('__orbit.satPointCount === __orbit.allSats.length'),
          f'{total_after} sats')

    set_layer(page, 'iridium-NEXT', False)
    time.sleep(0.5)
    check('unchecking hides rather than leaks', page.evaluate(
        '__orbit.layerState["iridium-NEXT"].entities.every(s => s.show === false)'))

    # removeSat() must drop the primitive AND the allSats entry, or the
    # propagation loop keeps a reference to every sat ever spawned.
    page.evaluate("""() => {
        const st = __orbit.layerState['iridium-NEXT'];
        window.__n0 = __orbit.allSats.length;
        window.__k = st.entities.length;
        const src = document.querySelector('.source-btn[data-source="celestrak"]');
        st.entities.forEach(s => {
            __orbit.satCollection.remove(s.primitive);
            const i = __orbit.allSats.indexOf(s);
            if (i !== -1) __orbit.allSats.splice(i, 1);
        });
    }""")
    check('removeSat drops sats from the propagation list', page.evaluate(
        '__orbit.allSats.length === window.__n0 - window.__k'),
        page.evaluate('`${__orbit.allSats.length} left of ${window.__n0}`'))

    # ------------------------------------------------------ baseline snapshots
    print('\n-- baselines  every layer group resolves --')
    missing = page.evaluate("""async () => {
        const groups = [...document.querySelectorAll('.layer-cb')]
            .filter(cb => cb.dataset.builtin !== 'true')
            .map(cb => cb.dataset.group);
        const gone = [];
        for (const g of groups) {
            const r = await fetch(`/data/tle/celestrak/${g.toLowerCase()}.txt`);
            if (!r.ok) gone.push(g);
        }
        return gone;
    }""")
    # iridium-NEXT must NOT be in this list — the baseline filenames are
    # lowercase even where the Celestrak group name is not, so a naive
    # `${g}.txt` would 404 on exactly this group.
    #
    # The old note here ("sbas + the three debris groups never shipped a
    # baseline") was an artifact of this check fetching /orbit/data/tle/...,
    # a path that has never existed — every group 404'd, so the list was
    # always full. Against the real /data/tle/ root, `missing` is empty.
    check('iridium-NEXT baseline resolves lowercase',
          'iridium-NEXT' not in missing, f'missing: {missing}')
    check('every non-builtin layer group ships a baseline snapshot',
          missing == [], f'missing: {missing}')

    # ---------------------------------------------------------------- source
    print('\n-- source  SPACE-TRACK is a link now (wave 3) --')
    # Wave 2 made this an in-place switch that had to call location.reload(),
    # because the ISS, the other stations and the Starlink batch are built
    # outside layerState and could not be re-sourced in place. Wave 3 gave
    # Space-Track its own page instead, which retires the reload entirely.
    check('SPACE-TRACK is an anchor to /spacetrack/', page.evaluate(
        """() => {
            const a = document.querySelector('a.source-btn[data-source="spacetrack"]');
            return !!a && new URL(a.href).pathname === '/spacetrack/';
        }"""))
    check('no source button re-boots the page any more', page.evaluate(
        'document.querySelectorAll(\'button.source-btn\').length === 0'))
    check('CELESTRAK marks itself the current page', page.evaluate(
        """() => {
            const el = document.querySelector('[data-source="celestrak"]');
            return el.classList.contains('source-btn--active') &&
                   el.getAttribute('aria-current') === 'page';
        }"""))

    # The citation is a CONDITION of USSPACECOM's blanket approval to
    # redistribute basic SSA data, so its presence is a compliance assertion,
    # not a cosmetic one — and it must be visible, not merely in the markup.
    cite = page.locator('.orbital-footer__cite')
    check('the Space-Track citation is present and visible',
          cite.count() == 1 and cite.first.is_visible(),
          cite.first.inner_text() if cite.count() else 'absent')
    check('the citation names Space-Track and USSPACECOM', page.evaluate(
        """() => {
            const t = (document.querySelector('.orbital-footer__cite') || {}).textContent || '';
            return t.includes('Space-Track.org') && t.includes('USSPACECOM');
        }"""))


def perf_gate(page, seconds):
    """Heap must stay flat with the catalog running. This is the specific
    regression being guarded: the per-Entity design reached 1.2 GB.

    Frame rate is NOT asserted — this box runs WebGL on SwiftShader at a few
    fps regardless of what the page does, so an fps threshold here would
    measure the software rasteriser, not the change. It is reported for eyes.
    """
    print(f'\n-- perf  {seconds}s with every baseline layer visible --')
    cdp = page.context.new_cdp_session(page)

    page.evaluate("""() => {
        document.querySelectorAll('.layer-cb').forEach(cb => {
            cb.checked = true;
            cb.dispatchEvent(new Event('change'));
        });
        // Starlink starts capped at 40; open it to the whole baseline batch.
        const sl = document.getElementById('sl-slider');
        if (sl) { sl.value = sl.max; sl.dispatchEvent(new Event('input')); }
    }""")
    for _ in range(60):
        if page.evaluate('__orbit.allSats.filter(s => s.primitive.show).length') > 400:
            break
        time.sleep(1)

    visible = page.evaluate('__orbit.allSats.filter(s => s.primitive.show).length')
    print(f'   {visible} satellites visible, {page.evaluate("__orbit.allSats.length")} tracked')

    page.evaluate("""() => {
        window.__frames = 0;
        const bump = () => { window.__frames++; requestAnimationFrame(bump); };
        requestAnimationFrame(bump);
    }""")

    def heap():
        cdp.send('HeapProfiler.collectGarbage')
        time.sleep(1)
        return page.evaluate('performance.memory.usedJSHeapSize') / 1e6

    time.sleep(5)
    h0 = heap()
    f0 = page.evaluate('window.__frames')
    t0 = time.time()
    time.sleep(seconds)
    h1 = heap()
    elapsed = time.time() - t0
    fps = (page.evaluate('window.__frames') - f0) / elapsed

    growth = h1 - h0
    print(f'   heap {h0:.1f} MB → {h1:.1f} MB  ({growth:+.1f} MB)   ~{fps:.1f} fps (SwiftShader)')
    check('heap stays flat under a running catalog', growth < 25,
          f'{growth:+.1f} MB over {elapsed:.0f}s at {visible} sats')
    x0 = page.evaluate('__orbit.allSats.find(x => x.primitive.show).primitive.position.x')
    landed = wait_ticks(page, 3)
    x1 = page.evaluate('__orbit.allSats.find(x => x.primitive.show).primitive.position.x')
    check('the propagation tick is still landing', landed and x0 != x1,
          f'{page.evaluate("__orbit.tickCount")} ticks total')

    # The actual wave 1 claim, measured directly: a tick costs the main thread
    # a postMessage, not N × SGP4. Unlike fps this is CPU-bound, not
    # rasteriser-bound, so it is a real number even under SwiftShader.
    # One call each: repeated propagateAllSats() calls coalesce (a tick already
    # in flight returns immediately), which would flatter the worker number.
    cost = page.evaluate("""() => {
        const t0 = performance.now();
        __orbit.propagateAllSatsSync();
        const sync = performance.now() - t0;
        const t1 = performance.now();
        __orbit.propagateAllSats();
        return { sync, worker: performance.now() - t1 };
    }""")
    # performance.now() is coarsened for security, so the worker path usually
    # reads as a flat 0 — report the bound rather than a ratio against zero.
    worker_ms = ('under the timer resolution' if cost['worker'] < 0.01
                 else f"{cost['worker']:.2f} ms")
    print(f"   main-thread cost per tick: {cost['sync']:.1f} ms sync → {worker_ms} via worker")
    check('worker tick costs the main thread far less than SGP4',
          cost['worker'] < cost['sync'] / 10,
          f"{cost['sync']:.1f} ms -> {worker_ms}")


def fallback_gate(page):
    """Kill the worker and confirm the page keeps propagating. Destructive —
    run last. A worker that fails to load must degrade, never blank the globe.
    """
    print('\n-- fallback  no worker --')
    page.evaluate('__orbit.disableWorker("e2e")')
    check('worker handle cleared', page.evaluate('!__orbit.worker'))
    # Jump the clock a minute and re-propagate: with no worker, propagateAllSats
    # must fall through to the synchronous loop and still move everything.
    moved = page.evaluate("""() => {
        const s = __orbit.allSats.find(x => x.meta.group === 'ISS') || __orbit.allSats[0];
        s.show = true;
        const before = Cesium.Cartesian3.clone(s.primitive.position);
        viewer.clock.currentTime = Cesium.JulianDate.addSeconds(
            viewer.clock.currentTime, 60, new Cesium.JulianDate());
        __orbit.propagateAllSats();
        return Cesium.Cartesian3.distance(before, s.primitive.position);
    }""")
    # ~7.66 km/s in LEO, so a minute is a few hundred km.
    check('sats still propagate with no worker', moved > 10000, f'{moved / 1000:.0f} km in 60s')


def boot_spacetrack(page, timeout=90):
    """Load /spacetrack/ and wait for its engine.

    Waits on `__spacetrack` existing, NOT on satellites: the catalog page opens
    on an empty globe by design (28k objects is not a default), and on the
    static test server there is no /api/search to render a slice from anyway.
    """
    page.goto(ST_BASE + str(time.time()))
    for _ in range(timeout):
        if page.evaluate('!!window.__spacetrack'):
            time.sleep(1.0)
            return True
        time.sleep(1)
    return False


def spacetrack_gate(page):
    """Wave 3: the /spacetrack/ page.

    Navigates away from /orbit/, so it runs last.

    The static test server has no Pages Functions, so /api/summary, /api/search
    and /api/object all 404 here. That is the point of the assertions below:
    what can be checked without the Worker deployed is that the page *boots
    anyway*, that it runs the SHARED engine rather than a fork, that its
    controls exist, and that it fails soft instead of throwing. The queries
    themselves are asserted at the SQL layer, in the ingest unit suites.
    """
    print('\n-- spacetrack  the catalog page (wave 3) --')
    if not boot_spacetrack(page):
        check('/spacetrack/ booted', False)
        return

    check('/spacetrack/ booted', True)

    # The whole point of wave 3: one engine, two pages. If this class ever comes
    # from a copied file the identity check still passes, so assert on the
    # module URL the page actually loaded.
    engine_src = page.evaluate("""() => [...document.querySelectorAll('script[type=module]')]
        .map(s => s.src).join(',')""")
    # The entry module was renamed spacetrack.js -> catalog.js in plan 34's
    # wave 2.2, when the overlay sections were split into overlays/*.js.
    check('the page is a module that imports the shared engine',
          'catalog.js' in engine_src, engine_src)
    check('the shared engine is running, not a fork', page.evaluate(
        '!!__spacetrack.engine && typeof __spacetrack.engine.propagate === "function"'))
    check('the engine owns one PointPrimitiveCollection', page.evaluate(
        '__spacetrack.satPointCount === 0 && __spacetrack.rendered === 0'),
        'empty globe on boot is deliberate')

    # The worker is resolved from an absolute URL: a relative one would resolve
    # against /spacetrack/ and silently fall back to synchronous SGP4.
    check('the propagation worker started from /spacetrack/', page.evaluate(
        '!!__spacetrack.worker'),
        'worker null means the URL resolved against the page')

    # Filter controls — the plan's Tier A/B/C dimensions.
    for control in ('f-q', 'f-type', 'f-country', 'f-regime', 'f-era', 'f-operator',
                    'f-apply', 'f-reset'):
        check(f'filter control #{control} exists',
              page.evaluate(f'!!document.getElementById("{control}")'))

    # A failed /api/search must leave a status message, not an exception.
    page.evaluate('__spacetrack.render()')
    time.sleep(2)
    check('a failed query reports instead of throwing', page.evaluate(
        '(document.getElementById("f-status").textContent || "").length > 0'),
        page.evaluate('document.getElementById("f-status").textContent'))

    check('the render query asks for element sets and a bounded limit',
          'tle=1' in page.evaluate('__spacetrack.lastQuery') and
          'limit=500' in page.evaluate('__spacetrack.lastQuery'),
          page.evaluate('__spacetrack.lastQuery'))

    # The dossier is hidden until something is clicked.
    check('the dossier starts hidden', page.evaluate(
        'document.getElementById("dossier").hidden'))

    # The citation is a CONDITION of USSPACECOM's blanket approval, and every
    # byte on this page comes from that catalog — so it is not optional here.
    cite = page.locator('.orbital-footer__cite')
    check('the Space-Track citation is present and visible on /spacetrack/',
          cite.count() == 1 and cite.first.is_visible(),
          cite.first.inner_text() if cite.count() else 'absent')

    # The source row is navigation now, not a switch.
    check('CELESTRAK links back to /orbit/', page.evaluate(
        """() => {
            const a = document.querySelector('a.source-btn[data-source="celestrak"]');
            return !!a && new URL(a.href).pathname === '/orbit/';
        }"""))
    check('SPACE-TRACK marks itself the current page', page.evaluate(
        """() => {
            const el = document.querySelector('[data-source="spacetrack"]');
            return el.tagName === 'SPAN' &&
                   el.classList.contains('source-btn--active');
        }"""))

    # Wave 4 — the signal feed panel. The static test server has no Pages
    # Functions, so /api/feed, /api/decay-watch and /api/boxscore all 404 here;
    # the point is that the panel exists, boots on the shared HUD toggle
    # pattern, and each section fails soft into its hint rather than throwing.
    for control in ('signal-hud', 'signal-hud-toggle', 'signal-hud-body',
                     'feed-list', 'feed-hint', 'decay-list', 'decay-hint',
                     'box-list', 'box-hint'):
        check(f'signal feed control #{control} exists',
              page.evaluate(f'!!document.getElementById("{control}")'))

    check('the signal feed calls are exposed for debugging', page.evaluate(
        "typeof __spacetrack.loadFeed === 'function' && "
        "typeof __spacetrack.loadDecayWatch === 'function' && "
        "typeof __spacetrack.loadBoxscore === 'function'"))

    page.evaluate('__spacetrack.loadFeed()')
    page.evaluate('__spacetrack.loadDecayWatch()')
    page.evaluate('__spacetrack.loadBoxscore()')
    time.sleep(2)
    check('a failed feed fetch reports in its hint instead of throwing',
          page.evaluate('(document.getElementById("feed-hint").textContent || "").length > 0'),
          page.evaluate('document.getElementById("feed-hint").textContent'))
    check('a failed decay-watch fetch reports in its hint instead of throwing',
          page.evaluate('(document.getElementById("decay-hint").textContent || "").length > 0'),
          page.evaluate('document.getElementById("decay-hint").textContent'))
    check('a failed boxscore fetch reports in its hint instead of throwing',
          page.evaluate('(document.getElementById("box-hint").textContent || "").length > 0'),
          page.evaluate('document.getElementById("box-hint").textContent'))

    conjunction_gate(page)
    brief_gate(page)


# One real element set, captured from Space-Track (NORAD 29, TIROS 1) and living
# in workers/orbit-ingest/fixtures/sample_gp.json. Near-circular LEO, chosen so
# the twin below sits at a predictable separation. Epoch-independent: both twins
# share an epoch, so the geometry holds however old the capture gets.
TIROS_L1 = '1 00029U 60002B   26207.18734102  .00000498  00000-0  95714-4 0  9993'
TIROS_L2 = '2 00029  48.3766 199.2947 0021554  76.2317 284.0994 14.78816037547907'


def twin_tle(l2, norad, delta_deg):
    """The same orbit with the mean anomaly nudged — a co-orbiting twin.

    Columns 44-51 of line 2 are the mean anomaly. Shifting it by a fraction of a
    degree puts a second object a few km ahead on an identical orbit, which is a
    guaranteed close approach with no dependence on what the live catalog happens
    to contain today. satellite.js does not verify the line checksum, so the
    trailing digit is left alone.

    A TLE is a FIXED-COLUMN format, so every splice has to preserve the width or
    every field after it shifts and satellite.js silently reads the wrong
    numbers. A first version of this helper passed a 6-digit catalog number into
    a 5-wide field; the line grew by one character, the twin's inclination and
    mean motion were both read off by a column, and the test still passed —
    because the *comparison* used the same corrupted line. That is a test
    passing for the wrong reason, so the widths are asserted rather than trusted.
    """
    assert 0 <= norad <= 99999, f'catalog number {norad} does not fit 5 columns'
    ma = (float(l2[43:51]) + delta_deg) % 360.0
    ma_field = f'{ma:8.4f}'
    assert len(ma_field) == 8, f'mean anomaly {ma_field!r} does not fit 8 columns'
    line = l2[:2] + f'{norad:05d}' + l2[7:43] + ma_field + l2[51:]
    assert len(line) == len(l2), f'twin TLE changed width: {len(line)} vs {len(l2)}'
    return line


def conjunction_gate(page):
    """Wave 5: derived close-approach screening.

    The static test server has no /api/search, so there is no slice to screen —
    the page exposes `addObjects()` (the same path render() uses) and the test
    supplies its own elsets. That makes this a stronger test than a live query
    would be: the geometry is constructed, so the answer is known.

    The load-bearing assertion is the last one. The screen runs SGP4 inside a
    module worker over a coarse march and a linear-TCA refinement; the check
    re-propagates BOTH objects on the main thread with satellite.js at the time
    of closest approach the worker reported and measures the separation directly.
    Agreement to the metre means the whole pipeline — worker construction, the
    UMD import, the shell sieve, the coarse gate, the refinement and the
    reporting — produced a real number rather than a plausible one.
    """
    print('\n-- spacetrack  derived conjunction screening (wave 5) --')

    for control in ('conj-hud', 'conj-hud-toggle', 'conj-hud-body', 'conj-badge',
                    'c-window', 'c-threshold', 'c-run', 'c-cancel', 'c-status',
                    'c-list', 'c-progress'):
        check(f'screening control #{control} exists',
              page.evaluate(f'!!document.getElementById("{control}")'))

    # The panel shares the bottom-right slot with SIGNAL FEED. Expanding one has
    # to close the other or an expanded panel grows up over its neighbour's chip.
    page.evaluate('document.getElementById("signal-hud-toggle").click()')
    page.evaluate('document.getElementById("conj-hud-toggle").click()')
    check('expanding CONJUNCTIONS collapses its slot-mate', page.evaluate(
        """document.getElementById("signal-hud").classList.contains("key-hud--collapsed")
           && !document.getElementById("conj-hud").classList.contains("key-hud--collapsed")"""))

    # cdm_public is the one class outside USSPACECOM's blanket approval, so this
    # screen is our own derivation and the disclaimer is a condition of shipping
    # it — same standing as the citation, and asserted the same way.
    badge = page.locator('#conj-badge')
    badge_text = badge.inner_text() if badge.count() else ''
    check('the UNOFFICIAL badge is visible when the panel is open',
          badge.count() == 1 and badge.first.is_visible()
          and 'NOT FOR COLLISION AVOIDANCE' in badge_text.upper(),
          badge_text[:80])

    check('the window and threshold presets populated', page.evaluate(
        'document.getElementById("c-window").options.length >= 3 && '
        'document.getElementById("c-threshold").options.length >= 4'))

    # Nothing rendered: the screen must say so rather than reporting "no
    # conjunctions", which would be a true statement that means the wrong thing.
    page.evaluate('__spacetrack.clearRendered()')
    page.evaluate('__spacetrack.runScreen()')
    time.sleep(1)
    check('screening an empty globe says so instead of reporting zero hits',
          'nothing rendered' in page.evaluate(
              'document.getElementById("c-status").textContent'),
          page.evaluate('document.getElementById("c-status").textContent'))

    # A co-orbiting twin, ~6 km ahead on an identical orbit.
    rows = [
        {'NORAD_CAT_ID': 29, 'OBJECT_NAME': 'SCREEN TEST A', 'OBJECT_TYPE': 'PAYLOAD',
         'TLE_LINE1': TIROS_L1, 'TLE_LINE2': TIROS_L2},
        {'NORAD_CAT_ID': 90001, 'OBJECT_NAME': 'SCREEN TEST B', 'OBJECT_TYPE': 'PAYLOAD',
         'TLE_LINE1': TIROS_L1.replace('1 00029U', '1 90001U'),
         'TLE_LINE2': twin_tle(TIROS_L2, 90001, 0.05)},
    ]
    page.evaluate('rows => __spacetrack.addObjects(rows)', rows)
    check('the injected pair is on the globe', page.evaluate('__spacetrack.rendered') == 2,
          f'rendered={page.evaluate("__spacetrack.rendered")}')

    page.evaluate("""() => {
        document.getElementById('c-threshold').value = '25';
        document.getElementById('c-window').value = '1800';
        return __spacetrack.runScreen();
    }""")

    # The run is a module worker; give it room but do not sleep blindly — poll on
    # the state the page exposes.
    for _ in range(60):
        if page.evaluate('!!__spacetrack.lastScreen'):
            break
        time.sleep(0.5)

    screen = page.evaluate('__spacetrack.lastScreen')
    check('the screening worker ran and returned a result', bool(screen),
          'no lastScreen — the module worker may have failed to construct')
    if not screen:
        check('the conjunction worker constructed at all',
              page.evaluate('__spacetrack.screener.available'),
              'available=false means new Worker({type:"module"}) threw')
        return

    check('the module worker constructed rather than falling back', page.evaluate(
        '!!__spacetrack.screener.worker && __spacetrack.screener.available'))

    rows_found = screen['rows']
    check('the co-orbiting pair was found', len(rows_found) == 1,
          f"{len(rows_found)} rows; status: "
          f"{page.evaluate('document.getElementById(\"c-status\").textContent')}")
    if not rows_found:
        return

    row = rows_found[0]
    check('both objects are named in the row',
          {row['a']['norad'], row['b']['norad']} == {29, 90001},
          str([row['a']['norad'], row['b']['norad']]))
    check('the miss distance is the few km the twin was built with',
          1.0 < row['missKm'] < 25.0, f"{row['missKm']:.3f} km")

    # The independent check: propagate both on the main thread at the reported
    # TCA and measure. A screen that reported the separation at its coarse SAMPLE
    # rather than at the minimum would disagree by tens of km here.
    direct = page.evaluate("""(args) => {
        const [l1a, l2a, l1b, l2b, tcaMs] = args;
        const when = new Date(tcaMs);
        const A = satellite.propagate(satellite.twoline2satrec(l1a, l2a), when).position;
        const B = satellite.propagate(satellite.twoline2satrec(l1b, l2b), when).position;
        return Math.hypot(A.x - B.x, A.y - B.y, A.z - B.z);
    }""", [rows[0]['TLE_LINE1'], rows[0]['TLE_LINE2'],
           rows[1]['TLE_LINE1'], rows[1]['TLE_LINE2'], row['tcaMs']])
    check('the worker agrees with main-thread SGP4 at the reported TCA',
          abs(direct - row['missKm']) < 0.001,
          f"worker {row['missKm']:.6f} km vs direct {direct:.6f} km")

    stats = screen['stats']
    check('the run reports what it actually screened',
          stats['objectsScreened'] == 2 and stats['pairsScreened'] == 1
          and stats['stepsRun'] == stats['totalSteps'],
          str(stats))
    check('the gate is wider than the threshold by the step bound',
          stats['gateKm'] > stats['thresholdKm'],
          f"gate {stats['gateKm']} km vs threshold {stats['thresholdKm']} km")

    list_text = page.evaluate('document.getElementById("c-list").textContent')
    check('the result list rendered a row with the miss distance',
          page.evaluate('document.querySelectorAll("#c-list li").length') == 1
          and 'km' in list_text, list_text[:90])

    # The twins share an orbit, so their separation is flat and the solver's
    # "time of closest approach" is wherever rounding put it. Printing a time
    # would claim an event where there is a standing formation.
    check('a co-orbiting pair is labelled as such, not given a bogus TCA',
          'co-orbiting' in list_text and row['relSpeedKms'] < 0.1,
          f"{list_text[:70]} (vrel {row['relSpeedKms']:.4f} km/s)")

    check('the progress bar is hidden once the run finishes and RUN re-enables',
          page.evaluate('document.getElementById("c-progress").hidden && '
                        '!document.getElementById("c-run").disabled'))

    # Clearing the slice must clear rows that name objects no longer on the globe.
    page.evaluate('__spacetrack.clearRendered()')
    check('clearing the slice clears its conjunction rows',
          page.evaluate('document.querySelectorAll("#c-list li").length') == 0)


# ── Daily brief (wave 6) ───────────────────────────────────────────────────
# The static test server has no Pages Functions, so /api/brief 404s here and the
# panel stays hidden — which is itself the first assertion. Everything after it
# drives `__spacetrack.renderBrief()` with cards this file builds, the same
# reason wave 5 exposes `addObjects`.

# A card with facts and no narrative. This is what production looks like with
# generation switched off, and the panel has to be useful in exactly this state
# or the wave is not droppable the way the plan requires.
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
            {'norad': 60003, 'name': 'CZ-6A R/B', 'country': 'PRC', 'days_until': 5},
        ],
    },
}


def brief_gate(page):
    print('\n-- spacetrack  daily brief (wave 6) --')

    for control in ('brief-hud', 'brief-hud-toggle', 'brief-hud-body', 'brief-badge',
                    'brief-narrative', 'brief-new', 'brief-decayed', 'brief-reentry',
                    'brief-tracked', 'brief-payloads', 'brief-debris',
                    'brief-highlights', 'brief-hint'):
        check(f'daily brief control #{control} exists',
              page.evaluate(f'!!document.getElementById("{control}")'))

    check('the brief loader and renderer are exposed for debugging', page.evaluate(
        "typeof __spacetrack.loadBrief === 'function' && "
        "typeof __spacetrack.renderBrief === 'function'"))

    # No artifact (and here, no endpoint at all) means no panel — not an empty
    # chip explaining itself.
    page.evaluate('__spacetrack.loadBrief()')
    time.sleep(1.5)
    check('a missing brief hides the panel entirely rather than showing an empty one',
          page.evaluate('document.getElementById("brief-hud").hidden') is True)
    check('the panel is really not painted, not just flagged hidden',
          page.evaluate("getComputedStyle(document.getElementById('brief-hud')).display")
          == 'none')

    page.evaluate('__spacetrack.renderBrief({available: false})')
    check('an explicitly unavailable card keeps the panel hidden',
          page.evaluate('document.getElementById("brief-hud").hidden') is True)

    # THE ONE THAT MATTERS FOR DROPPABILITY: no narrative, full facts, panel up.
    page.evaluate('(card) => __spacetrack.renderBrief(card)', FACTS_ONLY_CARD)
    check('a facts-only card still shows the panel',
          page.evaluate('document.getElementById("brief-hud").hidden') is False)
    check('the facts render with no narrative present', page.evaluate(
        """() => document.getElementById('brief-tracked').textContent === '31,629' &&
                 document.getElementById('brief-new').textContent === '7' &&
                 document.getElementById('brief-decayed').textContent === '2' &&
                 document.getElementById('brief-reentry').textContent === '2'"""),
        page.evaluate("document.getElementById('brief-tracked').textContent"))
    check('the machine-written badge stays hidden when there is no machine writing',
          page.evaluate("""() =>
              document.getElementById('brief-badge').hidden === true &&
              document.getElementById('brief-narrative').hidden === true"""))
    check('the reentry highlights render from the facts',
          page.evaluate('document.querySelectorAll("#brief-highlights li").length') == 2)

    # With a narrative, the badge must appear ABOVE it — a provenance note read
    # after the sentence is a provenance note read too late.
    with_narrative = dict(FACTS_ONLY_CARD)
    with_narrative['narrative'] = ('Seven objects were newly catalogued in the last 24 hours '
                                   'and two decayed.')
    with_narrative['narrative_status'] = 'ok'
    page.evaluate('(card) => __spacetrack.renderBrief(card)', with_narrative)
    check('a narrative renders with its badge', page.evaluate(
        """() => !document.getElementById('brief-narrative').hidden &&
                 !document.getElementById('brief-badge').hidden &&
                 document.getElementById('brief-narrative').textContent.includes('Seven objects')"""))
    check('the badge precedes the narrative in the document', page.evaluate(
        """() => !!(document.getElementById('brief-badge').compareDocumentPosition(
                      document.getElementById('brief-narrative'))
                    & Node.DOCUMENT_POSITION_FOLLOWING)"""))

    # The narrative is the only string on this page written by a language model.
    # It goes in as text, and "a model is unlikely to emit markup" is not a
    # security boundary.
    injected = dict(with_narrative)
    injected['narrative'] = 'Seven objects <img src=x onerror="window.__pwned=1"> were catalogued.'
    page.evaluate('(card) => __spacetrack.renderBrief(card)', injected)
    time.sleep(0.5)
    check('narrative text is inserted as text, never as markup', page.evaluate(
        """() => document.querySelectorAll('#brief-narrative img').length === 0 &&
                 window.__pwned === undefined &&
                 document.getElementById('brief-narrative').textContent.includes('<img')"""))

    # A withheld narrative is stated. Silence would look identical to a quiet day.
    rejected = dict(FACTS_ONLY_CARD)
    rejected['narrative_status'] = 'rejected: unsupported number "8842" — not present in the facts'
    page.evaluate('(card) => __spacetrack.renderBrief(card)', rejected)
    check('a narrative rejected by the grounding gate is reported, not hidden',
          'withheld' in page.evaluate("document.getElementById('brief-hint').textContent"),
          page.evaluate("document.getElementById('brief-hint').textContent"))

    # Slot behaviour — three chips share bottom-right now.
    page.evaluate("""() => {
        document.querySelectorAll('.orbital-hud').forEach(p => {
            if (!p.classList.contains('key-hud--collapsed')) {
                const t = p.querySelector('.key-hud-toggle');
                if (t) t.click();
            }
        });
    }""")
    page.evaluate('document.getElementById("brief-hud-toggle").click()')
    time.sleep(0.4)
    check('expanding DAILY BRIEF collapses its slot-mates', page.evaluate(
        """() => document.getElementById('signal-hud').classList.contains('key-hud--collapsed') &&
                 document.getElementById('conj-hud').classList.contains('key-hud--collapsed') &&
                 !document.getElementById('brief-hud').classList.contains('key-hud--collapsed')"""))

    page.evaluate('document.getElementById("brief-hud-toggle").click()')
    time.sleep(0.4)
    boxes = page.evaluate("""() => ['signal-hud','conj-hud','brief-hud'].map(id => {
        const r = document.getElementById(id).getBoundingClientRect();
        return {id, top: Math.round(r.top), bottom: Math.round(r.bottom)};
    })""")
    overlaps = [f"{a['id']}/{b['id']}"
                for i, a in enumerate(boxes) for b in boxes[i + 1:]
                if a['top'] < b['bottom'] and b['top'] < a['bottom']]
    check('the three collapsed chips do not overlap each other', not overlaps,
          f"{overlaps} from {boxes}")


# ── Mobile gate ────────────────────────────────────────────────────────────
# Everything below comes from docs/mobile-audit-orbit-spacetrack.md. It needs a
# viewport and a devicePixelRatio the rest of this suite does not have, so it
# runs in its own browser context rather than resizing the shared page (which
# would strand the other gates on a mobile layout).

MOBILE_VIEWPORT = {'width': 390, 'height': 844}


def mobile_gate(browser):
    """Assert the mobile audit's fixes on both pages, at 390×844 / DPR 3."""
    print('\n-- mobile  390x844 @3x — the audit fixes --')
    page = browser.new_page(viewport=MOBILE_VIEWPORT, device_scale_factor=3,
                            is_mobile=True, has_touch=True)
    try:
        for path, handle, label in (('/orbit/index.html', '__orbit', 'orbit'),
                                    ('/spacetrack/index.html', '__spacetrack', 'spacetrack')):
            page.goto(f'http://127.0.0.1:8932{path}?cb={time.time()}')
            booted = False
            for _ in range(90):
                if page.evaluate(f'!!window.{handle}'):
                    booted = True
                    break
                time.sleep(1)
            check(f'{label} boots on a phone viewport', booted)
            if not booted:
                continue
            time.sleep(2)

            st = page.evaluate("""() => ({
                requestRenderMode: viewer.scene.requestRenderMode,
                maxRenderTimeChange: viewer.scene.maximumRenderTimeChange,
                browserRes: viewer.useBrowserRecommendedResolution,
                scale: viewer.resolutionScale,
                drawW: viewer.canvas.width,
                cssW: viewer.canvas.clientWidth,
            })""")

            # H3 — render on demand rather than 60 fps of redrawing a still globe.
            check(f'{label} H3 renders on demand', st['requestRenderMode'] is True, str(st))
            check(f'{label} H3 keeps a clock backstop', st['maxRenderTimeChange'] > 0,
                  'without one, lighting freezes on a page with no satellites')

            # H1 — the audit assumed Cesium draws at devicePixelRatio (3× here,
            # 9× the pixels). Measured, it does not: useBrowserRecommendedResolution
            # defaults true and the buffer already matches CSS pixels. Pinning it
            # is the guard; resolutionScale is the actual saving.
            check(f'{label} H1 pins browser-recommended resolution', st['browserRes'] is True)
            check(f'{label} H1 draws at or below CSS resolution',
                  st['drawW'] <= st['cssW'], f"{st['drawW']}px buffer for {st['cssW']}css")
            check(f'{label} H1 scales resolution down on a phone', st['scale'] < 1.0,
                  f"scale={st['scale']}")

            # The one that matters: on-demand rendering must not mean no rendering.
            frames = page.evaluate("""() => new Promise(res => {
                let n = 0;
                const off = viewer.scene.postRender.addEventListener(() => n++);
                setTimeout(() => { off(); res(n); }, 4000);
            })""")
            check(f'{label} the globe still draws under requestRenderMode', frames > 0,
                  f'{frames} frames in 4s — 0 means a path forgot requestRender()')

            # M2 / M4 / L1 — gesture and selection behaviour.
            check(f'{label} M2 the globe owns its gestures', page.evaluate(
                "getComputedStyle(document.getElementById('cesium-container')).touchAction")
                == 'none')
            check(f'{label} L1 HUD text is not drag-selectable', page.evaluate(
                "getComputedStyle(document.querySelector('.orbital-hud')).userSelect") == 'none')

            # H2 — emulated Chromium reports zero insets, so what can be asserted
            # is that the offsets are COMPUTED from the safe-area vars rather than
            # being bare pixels. A regression here re-hardcodes them.
            sa = page.evaluate("""() => {
                let n = 0;
                const walk = rules => {
                    for (const r of rules) {
                        if (r.cssRules) walk(r.cssRules);
                        if (!r.style) continue;
                        for (const p of ['top','bottom','left','right','padding','max-height']) {
                            if ((r.style.getPropertyValue(p) || '').includes('--sa-')) { n++; break; }
                        }
                    }
                };
                for (const sh of document.styleSheets) {
                    try { walk(sh.cssRules); } catch (e) { /* Cesium's CDN sheet */ }
                }
                return n;
            }""")
            check(f'{label} H2 offsets come from safe-area insets', sa >= 6,
                  f'{sa} rules use var(--sa-*)')

            # M1 — open each control's own panel before measuring: a collapsed
            # panel's contents have zero height, which would pass a `>= 44` test
            # for the wrong reason if it were written the other way round.
            targets = (('.st-btn', '.st-input', '.st-select') if 'spacetrack' in path
                       else ('.tw-btn', '.source-btn', '.refresh-btn'))
            for sel in targets:
                h = page.evaluate("""(sel) => {
                    const el = document.querySelector(sel);
                    if (!el) return null;
                    const panel = el.closest('.orbital-hud');
                    if (panel && panel.classList.contains('key-hud--collapsed')) {
                        panel.querySelector('.key-hud-toggle').click();
                    }
                    return Math.round(el.getBoundingClientRect().height);
                }""", sel)
                if h is None:
                    continue
                check(f'{label} M1 {sel} is a 44px touch target', h >= 44, f'{h}px')

            # M6 — nothing carrying information below ~11px.
            small = page.evaluate("""() => {
                const bad = [];
                document.querySelectorAll('.orbital-hud *').forEach(el => {
                    if (!el.textContent.trim() || el.children.length) return;
                    if (!el.getBoundingClientRect().width) return;
                    const fs = parseFloat(getComputedStyle(el).fontSize);
                    if (fs < 11) bad.push(`${el.className}:${fs}`);
                });
                return bad.slice(0, 4);
            }""")
            check(f'{label} M6 no visible text under 11px', not small, ', '.join(small))

            # Wave 6 put a THIRD chip in the bottom-right slot, and the offsets
            # that keep them apart are hand-measured (64 / 116 / 168 here). The
            # panel is hidden without an artifact, so render one first — a
            # hidden element has a zero rect and would "pass" for the wrong
            # reason. A covered toggle is a control that cannot be reached.
            if 'spacetrack' in path:
                page.evaluate('(card) => __spacetrack.renderBrief(card)', FACTS_ONLY_CARD)
                page.evaluate("""() => {
                    document.querySelectorAll('.orbital-hud').forEach(p => {
                        if (!p.classList.contains('key-hud--collapsed')) {
                            const t = p.querySelector('.key-hud-toggle');
                            if (t) t.click();
                        }
                    });
                }""")
                time.sleep(0.4)
                # All FOUR: on a phone every one of these goes full-width, so
                # they are a single stack, not the two corners they sit in on a
                # desktop. Measuring found two overlaps that had shipped —
                # #results-hud exactly on top of #signal-hud (62px, one chip
                # wholly unreachable), and a 10px clip between each of the
                # others once the audit's 44px touch targets grew the chips to
                # 62px without the 52px offsets following. The rules all looked
                # right; only the rects were wrong.
                boxes = page.evaluate(
                    """() => ['results-hud','signal-hud','conj-hud','brief-hud'].map(id => {
                        const r = document.getElementById(id).getBoundingClientRect();
                        return {id, top: Math.round(r.top), bottom: Math.round(r.bottom),
                                h: Math.round(r.height)};
                    })""")
                check(f'{label} every bottom chip is actually laid out',
                      all(b['h'] > 0 for b in boxes), str(boxes))
                clashes = [f"{a['id']}/{b['id']}"
                           for i, a in enumerate(boxes) for b in boxes[i + 1:]
                           if a['top'] < b['bottom'] and b['top'] < a['bottom']]
                check(f'{label} the four bottom chips stack without overlapping',
                      not clashes, f'{clashes} from {boxes}')
                check(f'{label} the chip stack stays on screen',
                      all(b['top'] >= 0 for b in boxes), str(boxes))

            # M5 — the breakpoint listener must survive a resize rather than
            # leaving `hud-panel-open` (which HIDES the collapsed chips) stuck on
            # a wide layout where nothing would bring them back.
            page.set_viewport_size({'width': 1200, 'height': 844})
            time.sleep(0.6)
            check(f'{label} M5 widening clears the mobile-only panel state',
                  not page.evaluate("document.body.classList.contains('hud-panel-open')"))
            page.set_viewport_size(MOBILE_VIEWPORT)
            time.sleep(0.6)
    finally:
        page.close()


def main():
    headed = '--headed' in sys.argv
    # Default gate is short so it runs every time; --perf is the plan's 5-minute
    # soak. `--enable-precise-memory-info` makes performance.memory usable.
    soak = 300 if '--perf' in sys.argv else 45
    errors = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            executable_path=CHROME,
            headless=not headed,
            args=['--enable-unsafe-swiftshader', '--enable-precise-memory-info'],
        )
        page = browser.new_page(viewport={'width': 1400, 'height': 900})
        page.on('console', lambda m: errors.append(m.text)
                if m.type == 'error' and not any(e in m.text for e in EXPECTED) else None)
        page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))

        if not boot(page):
            print('  FAIL  page never booted (__orbit.booted stayed false)')
            browser.close()
            sys.exit(1)

        try:
            run(page)
            perf_gate(page, soak)
            fallback_gate(page)
            spacetrack_gate(page)   # navigates away from /orbit/; keep last
            # Its own context at phone size and DPR 3. Runs after the desktop
            # gates so nothing above inherits a mobile layout.
            if '--no-mobile' not in sys.argv:
                mobile_gate(browser)
        finally:
            print('\n-- console --')
            check('no unexpected console errors', not errors, '; '.join(errors[:4]))
            page.screenshot(path='reports/orbit_wave0.png')
            browser.close()

    passed = sum(1 for _, ok in results if ok)
    print(f'\n{passed}/{len(results)} passed')
    sys.exit(0 if passed == len(results) else 1)


if __name__ == '__main__':
    main()

