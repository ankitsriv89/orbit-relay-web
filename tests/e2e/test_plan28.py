"""Plan 28 E2E — Mars Sim's own synth playlist (no marsapiens R2 album), the
ONGAK companion rework (host / CALL / DEPLOY / PARCEL courier), Gratbot's
beat-synced dance, and the opening "report to Ariana" mission step.

    python3 tests/e2e/serve.py &          # no-cache static server on :8932
    python3 tests/e2e/test_plan28.py      # add --headed to watch

Notes for this box (2 cores, SwiftShader):
  - Drive the game through __mc / custom events, never page.click() (the
    actionability gate times out under software GL).
  - Headless Chrome has no audio sink, so ctx.currentTime free-runs and the
    analyser reads 0. Assert on state/scheduler, not measured loudness. The
    beat CLOCK is derived from ctx.currentTime, which DOES advance, so
    music.beats() is testable; music.level() is not.
"""
import sys
import time

from playwright.sync_api import sync_playwright

CHROME = '/home/ankit/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome'
BASE = 'http://127.0.0.1:8932/mars-colony/index.html?site=jezero&cb='
EXPECTED = ('501', 'Unsupported method', 'station.glb', 'checkpost.glb',
            'hq.glb', 'antenna.glb', 'chargepad.glb', 'van.glb', 'favicon')

results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('  PASS  ' if ok else '  FAIL  ') + name + (f' :: {detail}' if detail != '' else ''))


def boot(page, timeout=140):
    page.goto(BASE + str(time.time()))
    for _ in range(timeout):
        if page.evaluate('typeof window.__mc !== "undefined" && !!window.__mc.ongak'):
            page.evaluate('__mc.intro?.skip()')
            time.sleep(1.2)
            return True
        time.sleep(1)
    return False


def unlock(page):
    page.evaluate('window.dispatchEvent(new Event("pointerdown"))')
    time.sleep(0.5)


def switch_to(page, unit_expr):
    """Dispatch the switch-unit event until __mc.active is the given unit."""
    for _ in range(9):
        if page.evaluate(f'__mc.active.unit === {unit_expr}'):
            return True
        page.evaluate('document.dispatchEvent(new CustomEvent("mc-switch-unit"))')
        time.sleep(0.15)
    return page.evaluate(f'__mc.active.unit === {unit_expr}')


def run(page):
    unlock(page)

    # --------------------------------------------------------------- music
    print('\n-- music  Mars Sim playlist --')
    n = page.evaluate('__mc.music.tracks.length')
    check('11 tracks in the playlist', n == 11, f'{n} tracks')
    check('every track is synth (no R2 album)', page.evaluate(
        '__mc.music.tracks.every(t => t.src.startsWith("synth:"))'))
    check('no streamed (absolute-URL) tracks', page.evaluate(
        '__mc.music.tracks.every(t => !/^https?:/.test(t.src))'))
    ids = page.evaluate('__mc.music.tracks.map(t=>t.id)')
    for want in ('perihelion', 'ferric', 'aphelion', 'regolith', 'nightshift', 'terminator'):
        check(f'new preset present: {want}', want in ids)

    # One early scheduler window — headless Chrome throttles setInterval once
    # the tab is treated as hidden, so keep the timing assertion short and up
    # front (the plan-27 suite's discipline). The dance section below proves
    # the beat CLOCK deterministically, off explicit beats.
    page.evaluate('__mc.music.play()')
    time.sleep(0.4)
    s0 = page.evaluate('__mc.music.scheduled')
    # Poll rather than a single window: headless Chrome starves setInterval
    # once the tab is treated as hidden, so the sequencer can queue nothing
    # for a second or two at a stretch — give it up to ~8 s to prove it runs.
    s1 = s0
    for _ in range(16):
        time.sleep(0.5)
        s1 = page.evaluate('__mc.music.scheduled')
        if s1 > s0:
            break
    check('sequencer runs on the audio clock', s1 > s0, f'{s0} -> {s1}')
    check('beat clock advances', page.evaluate('__mc.music.beats()') > 0)
    # Selecting a new-style preset makes it current + reports its own tempo.
    sel = page.evaluate('''(() => {
        __mc.music.select(__mc.music.tracks.findIndex(t=>t.id==="regolith"));
        return { title: __mc.music.title, bpm: __mc.music.bpm };
    })()''')
    check('percussive preset selectable', sel['title'] == 'Regolith Run', str(sel))
    check('preset reports its own tempo', sel['bpm'] == 100, f"{sel['bpm']} bpm")

    # ------------------------------------------------------------- companion
    print('\n-- ONGAK  bound companion --')
    check('ships docked with Gratbot (host)', page.evaluate('__mc.ongakHost === __mc.gratbot'))
    check('ONGAK spawned beside Gratbot', page.evaluate(
        'Math.hypot(__mc.ongak.position.x-__mc.gratbot.position.x,'
        '__mc.ongak.position.z-__mc.gratbot.position.z)') < 7,
        page.evaluate('Math.hypot(__mc.ongak.position.x-__mc.gratbot.position.x,'
                      '__mc.ongak.position.z-__mc.gratbot.position.z).toFixed(2)'))
    check('NOT in the switch cycle', page.evaluate(
        '__mc.units.every(u => u.unit !== __mc.ongak)'))
    check('spatial panner attached', page.evaluate('__mc.ongak.spatial') is True)

    # CALL re-hosts to whatever is active and un-deploys.
    called = page.evaluate('''(() => {
        __mc.ongak.setDeployed(true);
        const active = __mc.active.unit;
        document.getElementById('mc-ongak-call').click();
        return { host: __mc.ongakHost === active, deployed: __mc.ongak.deployed,
                 wasGratbot: active === __mc.gratbot };
    })()''')
    check('CALL re-hosts to the active unit', called['host'] is True)
    check('CALL un-deploys', called['deployed'] is False)

    # DEPLOY holds it in place while the host drives away.
    parked = page.evaluate('''(() => {
        document.getElementById('mc-ongak-deploy').click();   // deploy
        const dep = __mc.ongak.deployed;
        const p0 = { x: __mc.ongak.position.x, z: __mc.ongak.position.z };
        const r = __mc.rover.position;
        for (let i=0;i<150;i++) __mc.ongak.update(0.1, { x: r.x+300, z: r.z+300, y: 0 });
        const drift = Math.hypot(__mc.ongak.position.x-p0.x, __mc.ongak.position.z-p0.z);
        document.getElementById('mc-ongak-deploy').click();   // resume
        return { dep, drift, resumed: __mc.ongak.deployed };
    })()''')
    check('DEPLOY holds position', parked['dep'] is True and parked['drift'] < 0.05,
          f"drift {parked['drift']:.4f}m")
    check('RESUME clears deployed', parked['resumed'] is False)

    # Re-host to Gratbot and confirm the FOLLOW seek closes the gap.
    follow = page.evaluate('''(() => {
        __mc.ongakHost = __mc.gratbot;
        __mc.ongak.setDeployed(false);
        const g = __mc.gratbot.position;
        __mc.ongak.teleport(g.x + 55, g.z + 55);
        const d0 = Math.hypot(g.x-__mc.ongak.position.x, g.z-__mc.ongak.position.z);
        for (let i=0;i<200;i++) __mc.ongak.update(0.1, g);
        return { d0, d1: Math.hypot(g.x-__mc.ongak.position.x, g.z-__mc.ongak.position.z) };
    })()''')
    check('FOLLOW closes the gap to the host', follow['d1'] < 6.5, f"{follow['d1']:.2f}m")

    # -------------------------------------------------------------- parcel
    print('\n-- ONGAK  parcel courier --')
    parcel = page.evaluate('''(() => {
        // fabricate a real field cache: collect a surface sample, then move its
        // container right under Ongak so PARCEL is in reach.
        const s = __mc.site.samples.find(x => !x.buried && !x.collected);
        __mc.samples.collect(s);
        const c = __mc.samples.containers.find(x => x.id === s.id && x.state === 'field');
        c.mesh.position.set(__mc.ongak.position.x, c.mesh.position.y, __mc.ongak.position.z);
        __mc.tryParcel();
        return { loaded: __mc.ongak.hasCargo, gone: c.state === 'cargo', cid: c.id };
    })()''')
    check('PARCEL loads a field cache', parcel['loaded'] is True)
    check('loaded cache leaves the field', parcel['gone'] is True)
    # Teleport Ongak onto the lab pad; the frame loop's deliver-guard drops
    # the parcel into the analysis queue. rAF runs (throttled) in headless, so
    # give it a real-time window rather than a tight poll.
    before = page.evaluate('__mc.lab.delivered.length')
    page.evaluate('__mc.ongak.teleport(__mc.lab.padPos.x, __mc.lab.padPos.z)')
    for _ in range(30):
        if not page.evaluate('__mc.ongak.hasCargo'):
            break
        time.sleep(0.2)
    delivered = page.evaluate('''({ after: __mc.lab.delivered.length,
        still: __mc.ongak.hasCargo })''')
    check('parcel auto-delivers at the lab pad',
          delivered['after'] > before and delivered['still'] is False,
          f"{before} -> {delivered['after']}, carrying={delivered['still']}")

    # --------------------------------------------------------------- dance
    print('\n-- Gratbot  dance --')
    # Make Gratbot the active unit, dock Ongak with it, start the music.
    check('can select Gratbot', switch_to(page, '__mc.gratbot'))
    page.evaluate('''(() => {
        __mc.ongakHost = __mc.gratbot; __mc.ongak.setDeployed(false);
        const g = __mc.gratbot.position; __mc.ongak.teleport(g.x + 2, g.z + 2);
        __mc.music.play();
    })()''')
    check('dance eligible when Gratbot active + Ongak docked + music playing',
          page.evaluate('__mc.danceEligible()') is True)

    danced = page.evaluate('''(() => {
        __mc.music.play();
        __mc.toggleDance();
        const on = __mc.gratbot.dancing;
        // capture the body pose across a beat sweep and confirm it MOVES
        const ys = [];
        for (let i=0;i<24;i++) {
            __mc.gratbot.update(0.05, { throttle: 0, steer: 0, beats: i * 0.25 });
            ys.push(__mc.gratbot.mesh.position.y);
        }
        const span = Math.max(...ys) - Math.min(...ys);
        return { on, span };
    })()''')
    check('DANCE toggles on', danced['on'] is True)
    check('dancing bounces the body on the beat', danced['span'] > 0.02,
          f"y-span {danced['span']:.3f}m")

    moves = page.evaluate('''(() => {
        const out = [];
        for (let m=0;m<5;m++) {
            __mc.setDanceMove(m);
            const feet0 = __mc.gratbot.feet().map(f => [f.x, f.z]);
            for (let i=0;i<8;i++) __mc.gratbot.update(0.05, { throttle: 0, steer: 0, beats: i*0.25 });
            out.push(__mc.gratbot.danceMove);
        }
        return { out, count: __mc.gratbot.danceMoveCount };
    })()''')
    check('five distinct dance moves selectable', moves['out'] == [0, 1, 2, 3, 4]
          and moves['count'] == 5, str(moves['out']))

    # Move 1 is the TWO-LEG rear-up. The body ORIGIN alone is not enough to
    # prove it: the origin rises by construction while the pitch drives the
    # NOSE and the belly through the surface. Sample the chassis SHELL, and
    # sweep heading x framerate — the original sink was invisible at spawn
    # heading and at one dt (world-space rotation axes inverted the pitch at
    # heading pi, and the offset re-entered its own smoothing, so the angle
    # scaled with framerate: 31deg intended, 89deg at 60fps).
    # chassis shell corners in body-local space, from gratbot.js build()
    SHELL = [[0, 1.29, -0.465], [0, 0.69, -0.575], [0, 0.69, 0.575],
             [0, 0.565, -0.51], [0, 0.565, 0.51], [0, 1.03, 0.575],
             [0, 1.03, -0.575]]
    twoleg = page.evaluate('''((SHELL) => {
        const g = __mc.gratbot;
        g.setDanceMove(1);
        const P = new (g.position.constructor)();
        let shellMin = 999, pawMax = -999, footMin = 999, worst = '';
        const pitches = [];
        for (const dt of [0.1, 0.05, 0.016]) {
            for (const hd of [0, 90, 180, 270]) {
                g.update(0.05, { throttle: 0, steer: (hd*Math.PI/180 - g.heading)/0.1, beats: 0 });
                for (let i=0;i<150;i++) g.update(dt, { throttle: 0, steer: 0, beats: i*0.1 });
                for (let i=0;i<48;i++) {
                    g.update(dt, { throttle: 0, steer: 0, beats: i*0.25 });
                    g.mesh.updateWorldMatrix(true, false);
                    for (const l of SHELL) {
                        P.set(l[0], l[1], l[2]).applyMatrix4(g.mesh.matrixWorld);
                        const agl = P.y - __mc.terrain.sampleGroundHeight(P.x, P.z);
                        if (agl < shellMin) { shellMin = agl; worst = 'dt '+dt+' hdg '+hd; }
                    }
                    for (const f of g.feet()) {
                        const agl = f.y - __mc.terrain.sampleGroundHeight(f.x, f.z);
                        pawMax = Math.max(pawMax, agl);
                        footMin = Math.min(footMin, agl);
                    }
                }
                P.set(0, 0, -1).applyQuaternion(g.mesh.quaternion);   // body forward
                pitches.push(Math.asin(Math.max(-1, Math.min(1, P.y))) * 180/Math.PI);
            }
        }
        return { shellMin: +shellMin.toFixed(3), pawMax: +pawMax.toFixed(3),
                 footMin: +footMin.toFixed(3), worst,
                 pitch: +pitches[0].toFixed(1),
                 spread: +(Math.max(...pitches) - Math.min(...pitches)).toFixed(3) };
    })''', SHELL)
    check('TWO-LEG keeps the whole chassis above the surface',
          twoleg['shellMin'] > 0, f"min shell +{twoleg['shellMin']:.3f}m @ {twoleg['worst']}")
    check('TWO-LEG never puts a foot under the surface',
          twoleg['footMin'] > -0.01, f"min foot {twoleg['footMin']:+.3f}m")
    check('TWO-LEG rears nose-up 35-60°', 35 < twoleg['pitch'] < 60,
          f"{twoleg['pitch']:.1f}°")
    check('TWO-LEG pose is heading- and framerate-independent',
          twoleg['spread'] < 0.5, f"pitch spread {twoleg['spread']:.3f}°")
    check('TWO-LEG lifts front paws high off the ground',
          twoleg['pawMax'] > 0.6, f"paw max +{twoleg['pawMax']:.3f}m")

    # The rear-up leans the chassis back over its hind feet. That shift lands on
    # mesh.position, which IS the step integrator's state — if it is not undone
    # each frame the walker slides backwards for as long as it dances.
    nodrift = page.evaluate('''(() => {
        const g = __mc.gratbot;
        g.setDanceMove(1);
        // Hold beats CONSTANT so the pose is static — then any movement at all
        // is drift, with no beat-phase difference to confound the comparison.
        const at = (n) => { for (let i=0;i<n;i++) g.update(0.05, { throttle: 0, steer: 0, beats: 8 });
                            return { x: g.position.x, z: g.position.z }; };
        at(150);
        const a = at(4), b = at(400);
        return +Math.hypot(b.x-a.x, b.z-a.z).toFixed(4);
    })()''')
    check('dancing in place never drifts the walker', nodrift < 0.01,
          f"{nodrift:.4f}m over 400 frames")

    # Driving overrides the dance (walks normally); it resumes when stopped.
    walkdance = page.evaluate('''(() => {
        const p0 = { x: __mc.gratbot.position.x, z: __mc.gratbot.position.z };
        for (let i=0;i<20;i++) __mc.gratbot.update(0.1, { throttle: -1, steer: 0, beats: i*0.25 });
        const moved = Math.hypot(__mc.gratbot.position.x-p0.x, __mc.gratbot.position.z-p0.z);
        return { moved, stillDancing: __mc.gratbot.dancing };
    })()''')
    check('driving overrides the dance (still moves)', walkdance['moved'] > 3,
          f"{walkdance['moved']:.1f}m while dance flag on")

    # Pausing the music ends the dance via the frame-loop gate — simulate the
    # gate directly (the loop calls setDance(false) when !danceEligible).
    gate = page.evaluate('''(() => {
        __mc.music.pause();
        const elig = __mc.danceEligible();
        if (__mc.gratbot.dancing && !elig) __mc.gratbot.setDance(false);
        return { elig, dancing: __mc.gratbot.dancing };
    })()''')
    check('music paused makes dance ineligible', gate['elig'] is False)
    check('dance ends when no longer eligible', gate['dancing'] is False)

    # -------------------------------------------------------- Ariana mission
    print('\n-- mission  report to Ariana --')
    check('opening step is REPORT TO ARIANA', page.evaluate('''(() => {
        const t = __mc.missions.stepTexts('tutorial');
        return t.length && /ARIANA/.test(t[0]);
    })()'''))
    check('tutorial retitled to the briefing', 'ARIANA' in page.evaluate(
        "__mc.missions.titleOf('tutorial')"))

    return page.evaluate('__mc.music.tracks.length')


def main():
    headed = '--headed' in sys.argv
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            executable_path=CHROME, headless=not headed,
            args=['--enable-unsafe-swiftshader',
                  '--autoplay-policy=no-user-gesture-required', '--mute-audio'])
        page = browser.new_context().new_page()
        errors = []
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        page.on('pageerror', lambda e: errors.append('PAGEERROR ' + str(e)))
        if not boot(page):
            print('BOOT FAILED'); print(errors[:8]); browser.close(); return 1
        run(page)
        real = [e for e in errors if not any(x in e for x in EXPECTED)]
        check('no unexpected console errors', len(real) == 0, str(real[:4]))
        browser.close()
    ok = sum(1 for _, o in results if o)
    print(f'\n{ok}/{len(results)} checks passed')
    return 0 if ok == len(results) else 1


if __name__ == '__main__':
    sys.exit(main())
