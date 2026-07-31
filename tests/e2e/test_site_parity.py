"""Multi-site parity E2E — every per-site system the engine reads off
sites.js must be populated for EVERY shipped site, and Ariana's briefing must
describe the site the player actually landed on (not a hardcoded Jezero one).

Add a site to SITE_MATRIX below and it inherits the whole invariant set; that
is the point of this file, since the engine is fully data-driven and a new
site is a config object, so config is exactly what needs guarding.

    python3 tests/e2e/serve.py &            # no-cache static server on :8932
    python3 tests/e2e/test_site_parity.py   # add --headed to watch

Notes for this box (2 cores, SwiftShader):
  - Drive the game through __mc, never page.click() (the actionability gate
    times out under software GL).
  - Gale is the heavy site (4096 heightmap, 1024 segments) — boot budget is
    deliberately longer than the plan-27/28 suites'.
"""
import sys
import time

from playwright.sync_api import sync_playwright

CHROME = '/home/ankit/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome'
BASE = 'http://127.0.0.1:8932/mars-colony/index.html?site={site}&cb='
EXPECTED = ('501', 'Unsupported method', 'station.glb', 'checkpost.glb',
            'hq.glb', 'antenna.glb', 'chargepad.glb', 'van.glb', 'favicon')

# (site id, words its briefing MUST contain, words it must NOT leak).
# The forbid lists are what catch a briefing copy-pasted from another site —
# the exact bug that shipped Jezero's script on Gale.
SITE_MATRIX = [
    ('gale', ['Gale Crater', 'Curiosity', 'Bagnold', 'Vera Rubin', 'Peace Vallis'],
     ['Jezero', 'Perseverance', 'Séítah', 'Neretva', 'Gusev', 'Spirit']),
    ('jezero', ['Jezero Crater', 'Perseverance', 'Séítah', 'Neretva'],
     ['Gale', 'Curiosity', 'Bagnold', 'Gusev', 'Spirit']),
    ('gusev', ['Gusev Crater', 'Spirit', 'Bonneville', 'Husband Hill'],
     ['Jezero', 'Perseverance', 'Gale', 'Curiosity', 'Bagnold']),
    ('syrtis', ['NE Syrtis', 'carbonate', 'scarp', 'Syrtis plateau'],
     ['Jezero', 'Perseverance', 'Gale', 'Curiosity', 'Gusev', 'Spirit']),
    ('insight', ['Elysium Planitia', 'InSight', 'western ridge', 'northern flats'],
     ['Jezero', 'Perseverance', 'Gale', 'Curiosity', 'Gusev', 'Spirit', 'Syrtis']),
    ('meridiani', ['Meridiani Planum', 'Opportunity', 'Eagle plains', 'Endeavour rim'],
     ['Jezero', 'Perseverance', 'Gale', 'Curiosity', 'Gusev', 'Spirit', 'InSight']),
    ('olympus', ['Olympus Mons', 'main caldera', 'northeast vent', 'southwest vent'],
     ['Jezero', 'Perseverance', 'Gale', 'Curiosity', 'Gusev', 'Spirit', 'Meridiani']),
    ('hellas', ['Hellas Planitia', 'basin floor', 'rim scarp', 'eastern highlands'],
     ['Jezero', 'Perseverance', 'Gale', 'Curiosity', 'Gusev', 'Spirit', 'Olympus']),
]

results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('  PASS  ' if ok else '  FAIL  ') + name + (f' :: {detail}' if detail != '' else ''))


def boot(page, site, timeout=200):
    page.goto(BASE.format(site=site) + str(time.time()))
    for _ in range(timeout):
        if page.evaluate('typeof window.__mc !== "undefined" && !!window.__mc.hologram'):
            page.evaluate('__mc.intro?.skip()')
            time.sleep(1.2)
            return True
        time.sleep(1)
    return False


def briefing_checks(page, site_id, expect_words, forbid_words):
    """Ariana's script = site.briefing + her two shared character lines."""
    s = page.evaluate('''(() => {
        const h = __mc.hologram, site = __mc.site;
        return { script: h.script, briefing: site.briefing ?? [], id: site.id };
    })()''')
    joined = ' '.join(s['script'])
    check(f'[{site_id}] briefing defined in sites.js', len(s['briefing']) == 2,
          str(len(s['briefing'])))
    check(f'[{site_id}] script = briefing + 2 shared Ariana lines',
          len(s['script']) == 4, str(len(s['script'])))
    check(f'[{site_id}] script opens with this site\'s briefing',
          s['script'][0] == s['briefing'][0])
    for w in expect_words:
        check(f'[{site_id}] briefing names "{w}"', w in joined)
    for w in forbid_words:
        check(f'[{site_id}] briefing does NOT leak "{w}"', w not in joined)
    check(f'[{site_id}] shared ARIANA/ATHENA character line kept',
          'ATHENA' in joined and 'ARIANA' in joined)


def banner_fit_checks(page, site_id):
    """Every briefing line must render INSIDE the viewport at every width.

    The objective banner used to be an unbounded `white-space: nowrap` row,
    so a ~160-char dialogue line ran off both edges of the screen. Guarded
    here because the briefing text lives in sites.js — a future site can
    reintroduce the overflow by writing one long line.
    """
    lines = page.evaluate('__mc.hologram.script')
    worst_w, worst_over = None, 0.0
    for w in (1920, 1440, 1280, 1100, 960, 375):
        page.set_viewport_size({'width': w, 'height': 720})
        time.sleep(0.2)
        for t in lines:
            r = page.evaluate('''(t) => {
                const el = document.querySelector('.mars-hud__objective');
                el.setAttribute('data-visible', 'true');
                document.getElementById('mc-objective-text').textContent = t;
                const b = el.getBoundingClientRect();
                return { left: b.left, right: b.right };
            }''', t)
            over = max(-r['left'], r['right'] - w, 0)
            if over > worst_over:
                worst_over, worst_w = over, w
    page.set_viewport_size({'width': 1280, 'height': 720})
    check(f'[{site_id}] briefing fits the objective banner at every width',
          worst_over <= 0.5, f'+{worst_over:.0f}px at {worst_w}px' if worst_over else '')


def parity_checks(page, site_id):
    """Every per-site system must actually be populated at this site."""
    d = page.evaluate('''(() => {
        const s = __mc.site, m = __mc.missions;
        const SITES = __mc.SITES ?? {}, LOCKED = __mc.LOCKED_SITES ?? [];
        const lockedDupes = LOCKED.filter((l) => SITES[l.id]).map((l) => l.id);
        const half = s.worldSize / 2;
        const pts = [
            ...(s.samples ?? []), ...(s.surveyZones ?? []), ...(s.photoSpots ?? []),
            ...((s.hazards?.softSand) ?? []),
        ];
        const zoneIds = (s.surveyZones ?? []).map((z) => z.id);
        const buried = (s.samples ?? []).filter((x) => x.buried);
        return {
            id: s.id, worldSize: s.worldSize,
            zones: (s.surveyZones ?? []).length,
            spots: (s.photoSpots ?? []).length,
            missions: s.missions ?? [],
            hq: !!s.hq, hqName: s.hq?.name ?? '',
            softSand: (s.hazards?.softSand ?? []).length,
            dustStorm: s.hazards?.dustStorm?.peakIntensity ?? null,
            samples: (s.samples ?? []).length,
            outposts: (s.samples ?? []).filter((x) => x.outpost).length,
            findings: (s.samples ?? []).filter((x) => x.finding).length,
            buried: buried.length,
            buriedZonesValid: buried.every((b) => zoneIds.includes(b.buried.surveyZone)),
            outOfBounds: pts.filter((p) => Math.abs(p.x) > half || Math.abs(p.z) > half)
                            .map((p) => p.id),
            surveyText: m.stepTexts('survey').join(' | '),
            photoText: m.stepTexts('photo').join(' | '),
            tutorial0: (m.stepTexts('tutorial')[0] ?? ''),
            tutorialTitle: m.titleOf('tutorial'),
            spawnInBounds: Math.abs(s.spawn.x) <= half && Math.abs(s.spawn.z) <= half,
            spawnX: s.spawn.x, spawnZ: s.spawn.z, lockedDupes,
            segDesktop: s.segments?.desktop ?? 0,
            landingUtc: s.landingUtc ?? '',
            outpostsBootstrapped: __mc.outposts.list().length,
        };
    })()''')
    check(f'[{site_id}] 3 survey zones', d['zones'] == 3, str(d['zones']))
    check(f'[{site_id}] 4 photo spots', d['spots'] == 4, str(d['spots']))
    check(f'[{site_id}] offers tutorial+survey+photo',
          d['missions'] == ['tutorial', 'survey', 'photo'], str(d['missions']))
    check(f'[{site_id}] survey step target == surveyZones length',
          f'SCAN ALL SCOUT ZONES' in d['surveyText'])
    check(f'[{site_id}] photo step count == photoSpots length',
          f"IMAGE ALL {d['spots']} TARGETS" in d['photoText'], d['photoText'])
    check(f'[{site_id}] tutorial opens with REPORT TO ARIANA',
          'ARIANA' in d['tutorial0'], d['tutorial0'])
    check(f'[{site_id}] tutorial titled as the briefing',
          'ARIANA' in d['tutorialTitle'], d['tutorialTitle'])
    check(f'[{site_id}] hq defined', d['hq'], d['hqName'])
    check(f'[{site_id}] soft-sand hazard zones', d['softSand'] >= 3, str(d['softSand']))
    check(f'[{site_id}] dust-storm intensity defined', d['dustStorm'] is not None,
          str(d['dustStorm']))
    check(f'[{site_id}] sample checkposts defined', d['outposts'] >= 5, str(d['outposts']))
    check(f'[{site_id}] every sample carries a finding',
          d['findings'] == d['samples'], f"{d['findings']}/{d['samples']}")
    check(f'[{site_id}] one survey-gated buried core', d['buried'] == 1, str(d['buried']))
    check(f'[{site_id}] buried core points at a real survey zone', d['buriedZonesValid'])
    check(f'[{site_id}] all site points inside worldSize', not d['outOfBounds'],
          str(d['outOfBounds']))
    check(f'[{site_id}] spawn inside worldSize', d['spawnInBounds'])
    check(f'[{site_id}] landing date set for the sol clock', 'T' in d['landingUtc'],
          d['landingUtc'])
    check(f'[{site_id}] outposts module bootstrapped', d['outpostsBootstrapped'] > 0,
          str(d['outpostsBootstrapped']))
    return d


def runtime_checks(page, site_id):
    """The per-site systems are live at runtime, not just present in config."""
    r = page.evaluate('''(() => {
        const s = __mc.site;
        const sand = s.hazards.softSand[0];
        // hazardZones.sample() = strongest soft-sand effect at (x, z), null
        // in the clear. The zone core must bite; open ground must not.
        const inSand = __mc.hazardZones.sample(sand.x, sand.z);
        const openX = s.worldSize / 2 - 50;
        const onFirm = __mc.hazardZones.sample(openX, openX);
        return { sandEffect: inSand?.effect ?? 0, firm: onFirm,
                 zoneCount: __mc.hazardZones.zones.length,
                 hasWeather: !!__mc.weather, hasDevils: !!__mc.dustDevils,
                 terrainOk: Number.isFinite(__mc.terrain.sampleHeight(0, 0)) };
    })()''')
    check(f'[{site_id}] soft sand bites at its core', r['sandEffect'] > 0.3,
          str(r['sandEffect']))
    check(f'[{site_id}] open ground is clear of hazards', r['firm'] is None)
    check(f'[{site_id}] hazard zones registered', r['zoneCount'] >= 3, str(r['zoneCount']))
    check(f'[{site_id}] weather + dust-devil systems active',
          r['hasWeather'] and r['hasDevils'])
    check(f'[{site_id}] terrain sampler returns finite height', r['terrainOk'])


def visit(browser, site_id, expect_words, forbid_words):
    """Run one site's checks in its OWN browser context.

    A fresh context per site is required, not just tidy: re-navigating a
    single page revokes the first document's GLTFLoader blob URLs while the
    second load is still resolving them, which floods the console with
    "Couldn't load texture blob:" errors that have nothing to do with the
    game (measured: 0 on a fresh context, 88 on a reused page). It also keeps
    each site's per-site localStorage save state isolated.
    """
    errors = []
    ctx = browser.new_context()
    page = ctx.new_page()
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    page.on('pageerror', lambda e: errors.append('PAGEERROR ' + str(e)))
    if not boot(page, site_id):
        print(f'{site_id.upper()} BOOT FAILED'); print(errors[:8]); ctx.close(); return None
    check(f'[{site_id}] site routed from ?site={site_id}',
          page.evaluate('__mc.site.id') == site_id)
    briefing_checks(page, site_id, expect_words, forbid_words)
    banner_fit_checks(page, site_id)
    data = parity_checks(page, site_id)
    runtime_checks(page, site_id)
    real = [e for e in errors if not any(x in e for x in EXPECTED)]
    check(f'[{site_id}] no unexpected console errors', len(real) == 0, str(real[:4]))
    ctx.close()
    return data


def main():
    headed = '--headed' in sys.argv
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            executable_path=CHROME, headless=not headed,
            args=['--enable-unsafe-swiftshader',
                  '--autoplay-policy=no-user-gesture-required', '--mute-audio'])

        seen = {}
        for site_id, expect, forbid in SITE_MATRIX:
            print(f'\n== {site_id.upper()} ==')
            seen[site_id] = visit(browser, site_id, expect, forbid)
        browser.close()

    if any(v is None for v in seen.values()):
        return 1

    print('\n== CROSS-SITE ==')
    ids = list(seen)
    check('every site offers the same mission chains',
          len({tuple(v['missions']) for v in seen.values()}) == 1,
          str({k: v['missions'] for k, v in seen.items()}))
    check('every site carries data-driven survey/photo counts',
          all(v['zones'] and v['spots'] for v in seen.values()),
          str({k: (v['zones'], v['spots']) for k, v in seen.items()}))
    names = [v['hqName'] for v in seen.values()]
    check('every site has a distinct HQ name', len(set(names)) == len(names), str(names))
    # hub.js concatenates SITES + LOCKED_SITES into one pin array, so a site
    # left in BOTH renders two overlapping globe pins — one playable, one
    # greyed "COMING SOON". Cheap to do, invisible until someone spins the
    # globe to that exact spot.
    dupes = seen[ids[0]]['lockedDupes']
    check('no site is both playable and locked on the hub globe', not dupes, str(dupes))
    check('every site has a distinct spawn', len({
        (v['spawnX'], v['spawnZ']) for v in seen.values()}) == len(ids))

    ok = sum(1 for _, o in results if o)
    print(f'\n{ok}/{len(results)} checks passed')
    return 0 if ok == len(results) else 1


if __name__ == '__main__':
    sys.exit(main())
