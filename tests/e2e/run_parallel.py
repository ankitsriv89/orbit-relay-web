"""
Shard the live visual suite across worker processes.

This box has 16 logical cores and a real GPU (see CLAUDE.md "Browser/visual
testing on this machine"), so the suite is I/O- and GPU-bound, not CPU-bound:
most of each route's wall time is waiting on the Cesium CDN, the TLE fetch and
the deliberate settle sleeps. Running routes concurrently collapses that wait.

Concurrency is capped (default 4) rather than set to core count: every worker
drives its own GPU-accelerated Chromium against the same D3D11 device, and
oversubscribing the GPU makes the globe routes render *slower* and flakier,
which is the opposite of the point.

Run:  py -3 tests/e2e/run_parallel.py [--jobs N] [base_url]
"""

import os, subprocess, sys, time, concurrent.futures as cf

HERE = os.path.dirname(os.path.abspath(__file__))

ROUTES = [
    '/', '/orbit/', '/spacetrack/', '/spacetrack/signal/',
    '/spacetrack/conjunctions/', '/spacetrack/brief/', '/spacetrack/analytics/',
    '/starlink/', '/constellations/', '/about/', '/wiki/',
]

args = sys.argv[1:]
jobs = 4
if '--jobs' in args:
    i = args.index('--jobs')
    jobs = int(args[i + 1])
    del args[i:i + 2]
base = args[0] if args else 'https://orbitalrelay.space'


def run(route):
    t0 = time.time()
    proc = subprocess.run(
        [sys.executable, os.path.join(HERE, 'test_live_visual.py'), base, route],
        capture_output=True, text=True, timeout=900,
    )
    return route, proc.returncode, proc.stdout, proc.stderr, time.time() - t0


def main():
    print(f'Running {len(ROUTES)} routes at concurrency {jobs} against {base}\n')
    t0 = time.time()
    failures, summary = [], []

    with cf.ThreadPoolExecutor(max_workers=jobs) as ex:
        futs = {ex.submit(run, r): r for r in ROUTES}
        for fut in cf.as_completed(futs):
            route, code, out, err, dt = fut.result()
            fails = [l for l in out.splitlines() if l.startswith('  FAIL')]
            summary.append((route, code, dt, len(fails)))
            print(f'{"OK  " if code == 0 else "FAIL"}  {route:<34} {dt:6.1f}s  '
                  f'{len(fails)} failing checks')
            for l in dict.fromkeys(fails):
                print(f'        {l.strip()}')
            if code != 0:
                failures.append((route, out, err))

    print(f'\n{"=" * 66}')
    print(f'{len(ROUTES)} routes in {time.time() - t0:.1f}s wall '
          f'(sum of parts: {sum(s[2] for s in summary):.1f}s)')
    bad = [s for s in summary if s[1] != 0]
    print(f'{len(ROUTES) - len(bad)}/{len(ROUTES)} routes clean')
    if failures:
        print('\nFull output for failing routes:\n')
        for route, out, err in failures:
            print(f'----- {route} -----')
            print(out[-4000:])
            if err.strip():
                print('STDERR:', err[-1500:])
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
