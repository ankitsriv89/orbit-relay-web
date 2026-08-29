---
paths:
  - "tests/e2e/**"
  - "tests/**"
  - "scripts/check/**"
---

# Browser / visual testing on this machine

`tests/e2e/` was originally written against a 2-core Linux sandbox running SwiftShader.
**This machine is different** — Windows, 16 logical cores, a real GPU (Intel UHD +
NVIDIA T1200). The old throttling advice does not apply. What's actually true here,
verified directly:

- **`python3` is not on PATH — use the `py -3` launcher** (Python 3.12). Anywhere docs
  say `python3 -m http.server` or `python3 tests/e2e/test_x.py`, substitute `py -3`.
- **The Python `playwright` package is not preinstalled** — `py -3 -m pip install
  playwright` first (the Node `npx playwright` is a separate install and doesn't satisfy
  the Python `from playwright.sync_api import ...` the tests use). The Chromium *binary*
  is already cached from the Node install and Python `playwright` finds it automatically —
  don't hardcode a path.
- **Never hardcode a browser executable path.** The `test_*.py` files originally baked in
  a Linux path; fixed to resolve via `pw.chromium.executable_path` inside the
  `sync_playwright()` context. Portable across machines/OSes.
- **Headless Chromium defaults to SwiftShader even with a real GPU** — normal Chrome
  sandboxing on Windows. For real GPU-accelerated WebGL (the Cesium globe pages), launch
  with:
  ```python
  browser = pw.chromium.launch(headless=True, args=[
      '--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist',
      '--enable-gpu', '--disable-gpu-sandbox',
  ])
  ```
  Verified this switches the reported renderer to D3D11. Use it for anything where
  rendered pixels matter; either mode is fine for DOM/state-only assertions.
- **`tests/e2e/run_parallel.py`** shards `test_live_visual.py` across worker processes,
  one route per subprocess: `py -3 tests/e2e/run_parallel.py [--jobs N] [base_url]`.
  Concurrency is capped at 4, not core count — the box is I/O/GPU-bound and every worker
  drives its own GPU-accelerated Chromium against the same D3D11 device. Raising `--jobs`
  past 4 makes the globe routes slower and flakier. `npm test` itself (syntax/resolve/
  orbit-ingest) is seconds and offline — this runner is only for the live visual suite.
- **`test_orbit.py` is flaky at its bound and its perf gate crashes on Windows** — both
  pre-existing, don't chase as new regressions:
  - The worker-vs-sync drift check allows `< 1.0 m`; it reads 0.96–1.33 m run to run.
    `test_imagery.py` independently verifies drawn ECEF at ~1.1 m worst case.
  - `perf_gate` prints a `→` and dies with `UnicodeEncodeError` under cp1252 *after* its
    checks pass. Run with `PYTHONIOENCODING=utf-8`.
  - Past that, `perf_gate`'s heap check fails and `spacetrack_gate` throws on a renamed
    debug handle. Confirmed on a clean baseline 2026-08-19 — unrelated to any recent work.
    **`test_imagery.py` is the currently-green e2e gate.**
- **`jq` is not installed.** `.claude/hooks/check-public.sh` pipes through `jq` twice and
  currently **fails silently** (not `set -e`) — the hook is a no-op on this box. Don't
  mistake "no hook feedback" for "clean"; run `npm test` yourself. `winget install
  jqlang.jq` restores it.

## Before you say a change works

1. **`npm test`** — green. Runs `syntax.mjs` (`node --check` every JS), `resolve.mjs`
   (every specifier/URL/`url()` against the real FS), then the ~222-check orbit-ingest suite.
   Offline, seconds.
2. **Load the affected route** under `npm run dev`, console clean. A globe that renders is
   not proof — a dead module fails silently.
3. **Check it at 390px** (mobile is not optional — see the CLAUDE.md mobile section).
4. **`tests/e2e/`** for behavioural changes.

When you add a guardrail, **write it before the fix and watch it go red on the real bug.**
