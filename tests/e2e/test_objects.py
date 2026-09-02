"""
/objects/ encyclopedia — index + crawlable per-object detail shell.

    npm run dev                       # wrangler pages dev public → :8788
    py -3 tests/e2e/test_objects.py   # (or pass a base url)

Needs the Pages Functions (the /api/objects, /api/profile and
functions/objects/[norad] shell), so it targets :8788 — NOT the :8931 static
server the globe suites use. Cache-bust every load: a stale cached module has
produced a byte-identical measurement after a real change before.

Assumes the local D1s are migrated and have at least NORAD 25544 in `objects`:
    wrangler d1 execute orbit-catalog  --local --file d1/orbit.sql
    wrangler d1 execute orbit-profiles --local --file d1/profiles.sql
A `profile: null` object is exercised on purpose — most of ~28k objects have no
Tier 1 facts.
"""
import json
import sys
import time
from playwright.sync_api import sync_playwright

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8788'

VIEWPORTS = [
    (390, 844), (412, 915), (820, 1180), (1133, 744), (1400, 900),
]

results = []
def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('  PASS  ' if ok else '  FAIL  ') + name + (f' :: {detail}' if detail else ''))

def cb(path):
    sep = '&' if '?' in path else '?'
    return f'{BASE}{path}{sep}cb={time.time()}'

def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            executable_path=pw.chromium.executable_path, headless=True,
            args=['--enable-unsafe-swiftshader', '--no-sandbox'],
        )
        ctx = browser.new_context(viewport={'width': 1400, 'height': 900})
        page = ctx.new_page()
        console_errors = []
        page.on('console', lambda m: console_errors.append(m.text) if m.type == 'error' else None)

        # ── index page ──────────────────────────────────────────────────────
        print('\n== /objects/ index ==')
        console_errors.clear()
        page.goto(cb('/objects/'), wait_until='domcontentloaded', timeout=20000)
        page.wait_for_selector('#rows tr', timeout=15000)
        row_count = page.eval_on_selector_all('#rows tr', 'els => els.length')
        check('index renders rows', row_count > 0, f'{row_count} rows')
        check('index console clean', not console_errors, '; '.join(console_errors[:3]))

        count_text = page.text_content('#count')
        check('count line shows a total', 'object' in (count_text or ''), count_text)

        # a filter narrows the result count
        total_before = page.eval_on_selector_all('#rows tr', 'els => els.length')
        page.select_option('#f-status', index=1)  # first non-"Any" status
        page.wait_for_timeout(600)
        total_after = page.eval_on_selector_all('#rows tr', 'els => els.length')
        check('a filter changes the result set',
              total_after != total_before or (count_text != page.text_content('#count')),
              f'{total_before} to {total_after}')
        page.select_option('#f-status', index=0)
        page.wait_for_timeout(400)

        # ── no horizontal scroll at every viewport ──────────────────────────
        print('\n== no horizontal page scroll ==')
        for w, h in VIEWPORTS:
            page.set_viewport_size({'width': w, 'height': h})
            page.goto(cb('/objects/'), wait_until='domcontentloaded', timeout=20000)
            page.wait_for_selector('#rows tr', timeout=15000)
            over = page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
            check(f'no h-scroll at {w}x{h}', over <= 1, f'overflow {over}px')
        page.set_viewport_size({'width': 1400, 'height': 900})

        # ── detail page: crawlable shell ────────────────────────────────────
        print('\n== /objects/25544/ detail ==')
        console_errors.clear()
        page.goto(cb('/objects/25544/'), wait_until='domcontentloaded', timeout=20000)
        title = page.title()
        check('detail <title> names the object', 'object 25544' in title.lower() or '25544' in title, title)

        desc = page.get_attribute('meta[name="description"]', 'content')
        check('detail has a non-empty meta description', bool(desc and len(desc) > 20), (desc or '')[:80])

        ld_raw = page.eval_on_selector('script[type="application/ld+json"]', 'el => el.textContent')
        try:
            ld = json.loads(ld_raw)
            check('JSON-LD parses and is a CreativeWork', ld.get('@type') == 'CreativeWork', ld.get('@type'))
        except Exception as e:
            check('JSON-LD parses', False, str(e))

        page.wait_for_selector('#obj-body dl, #obj-body .obj-error, #obj-body .obj-prose', timeout=15000)
        body_text = page.text_content('#obj-body')
        check('detail body hydrates', bool(body_text and 'Loading' not in body_text), (body_text or '')[:60])
        check('detail console clean', not console_errors, '; '.join(console_errors[:3]))

        # typed placeholder, not a broken <img>, when there is no image
        broken = page.eval_on_selector_all(
            '#obj-body img',
            'els => els.filter(i => i.complete && i.naturalWidth === 0).length')
        check('no broken <img> in the detail body', broken == 0, f'{broken} broken')
        has_fig = page.eval_on_selector_all('#obj-body figure', 'els => els.length')
        check('detail shows a figure (image or typed placeholder)', has_fig > 0)

        # ── a profile:null object still renders ─────────────────────────────
        print('\n== a bare (profile:null) object ==')
        # 99999 is chosen to almost certainly not exist → real 404, not empty shell
        r = page.goto(cb('/objects/99999999/'), wait_until='domcontentloaded', timeout=20000)
        check('a missing NORAD is a real 404, not an empty shell',
              r.status == 404 and 'not found' in page.title().lower(), f'{r.status} / {page.title()}')

        # no horizontal scroll on the detail page too
        for w, h in VIEWPORTS:
            page.set_viewport_size({'width': w, 'height': h})
            page.goto(cb('/objects/25544/'), wait_until='domcontentloaded', timeout=20000)
            page.wait_for_selector('#obj-body dl, #obj-body .obj-prose, #obj-body .obj-error', timeout=15000)
            over = page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
            check(f'detail: no h-scroll at {w}x{h}', over <= 1, f'overflow {over}px')

        browser.close()

    passed = sum(1 for _, ok in results if ok)
    print(f'\n{passed}/{len(results)} passed')
    sys.exit(0 if passed == len(results) else 1)


if __name__ == '__main__':
    main()
