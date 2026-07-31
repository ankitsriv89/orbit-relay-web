# Plan 24 — Mars Sim Telemetry & Analytics (v1)

**Status:** built (this repo). User-side Cloudflare + Play Console steps pending.
**Date:** 2026-07-20

## Goal
Collect basic, privacy-respecting data to improve the game: **downloads**, coarse
**location (country)**, **key gameplay events**, **device + performance ("how it looks and
plays")**, and **crash data** — for the Mars Sim Android app (Capacitor,
`com.marsapiens.marssim`) and the web build.

## Decisions
- **Distribution:** Google Play is the primary channel. The interim "~20 test phones" need is
  met by the **Play Console Internal Testing track** (invite by link, install from Play,
  auto-updates) — NOT self-hosted APKs. So: no R2 APK, no download page, no update checker.
- **Downloads / installs / crashes / ANRs / device mix / country:** **Google Play Console**
  (free, zero code; Android Vitals for crashes). Works on the internal-test track.
- **Gameplay + device + perf events:** our own **Cloudflare Pages Function + D1**, co-located
  in this repo (chosen over AWS Lambda+DynamoDB for simplicity — one deploy, no separate repo,
  no cross-account CORS/IAM, free per-request country).
- **Location:** country only (Play + `request.cf.country`). No GPS, no location permission.
- **Sentry:** deferred; Android Vitals covers crashes for v1.
- **Consent:** opt-out, on by default, with a MENU toggle + privacy policy.
- **Identity:** a random per-install UUID only. **No hardware / advertising IDs.**

## What was built (this repo)
| File | Purpose |
|---|---|
| `functions/api/telemetry.js` | Pages Function `POST /api/telemetry`. Validates (size/count caps + event-name allowlist), stamps server time + `cf.country`, batch-inserts to D1. Inert-and-drops (204) while `TELEMETRY_DB` is unbound. |
| `d1/telemetry.sql` | D1 `events` table + indexes. |
| `wrangler.toml` | Pages config; D1 binding block (commented until the DB id is filled). |
| `public/mars-colony/js/telemetry.js` | `createTelemetry()` — anon id + consent via `saves.js` Prefs, batched beacon flush (text/plain → no CORS preflight), device/GPU snapshot, per-frame FPS sampler, `session_start`/`session_end`, `context_lost`. No-op while consent off. |
| `public/mars-colony/js/saves.js` | Excludes `mc-anon-id` / `mc-tele-consent` from cloud-save export (device-local). RESET GAME already wipes them via the `mc-*` purge. |
| `public/mars-colony/js/hud.js` | MENU → SIM: `ANALYTICS ON/OFF` toggle + `Privacy & data` link (`onToggleConsent`, `consentOn`, `privacyUrl` options). |
| `public/mars-colony/js/main.js` | Instance in module scope; `app_open` + global `error`/`unhandledrejection` → `js_error` in `boot()`; `webglcontextlost` listener; `site_enter` + `startSession(...)` + per-frame `frame()`; `mission_complete`, `sample_collected`. |
| `public/privacy.html` + `public/privacy.css` | Privacy policy (web link + Play listing URL + in-app link). |

**Event set (allowlisted server-side):** `app_open`, `session_start`, `session_end`,
`site_enter`, `mission_complete`, `sample_collected`, `js_error`, `context_lost`.
`session_start` carries device model/OS/GPU/screen/DPR + quality tier + `loadMs`;
`session_end` carries `durationMs`, `avgFps`, `minFps`, `slowFrames`, `contextLost`.

## Endpoint / origin note
Web build posts same-origin (`/api/telemetry`). The bundled Android app has no server, so it
posts absolutely to `REMOTE_BASE` in `telemetry.js` (default `https://signal-playground-0uj.pages.dev`).
**Point `REMOTE_BASE` at the production domain if a custom one is added** (same for the
privacy link).

## Your one-time setup (I have no Cloudflare/Play account access)
1. **D1:** `wrangler d1 create mars-telemetry` → paste the id into `wrangler.toml` and uncomment
   the `[[d1_databases]]` block (or set the binding in the Pages dashboard). Then
   `wrangler d1 execute mars-telemetry --remote --file d1/telemetry.sql`.
2. **Deploy:** `wrangler pages deploy public --project-name signal-playground` (unchanged).
3. **Privacy policy:** replace `YOUR_CONTACT_EMAIL` in `public/privacy.html`; note the public URL
   (`…/privacy.html`) for the Play listing.
4. **Capacitor app** (`/home/ankit/ai/mars-sim-android`, repo `ankesrtw/mars-sim-android`):
   `sync-www.sh` → `npm run build:release` → signed AAB. No new native SDK.
5. **Play Console:** upload the AAB to the **Internal Testing** track; add ~20 testers; share the
   opt-in link. Complete **Data Safety**: App activity (analytics) + App info & performance
   (crash + diagnostics/device-perf); **Device or other IDs: No**; **no location** (country only,
   derived); not linked to identity; encrypted in transit; add the privacy-policy URL.

## Verification
- **Local:** `wrangler pages dev public` (with a local D1), MENU → ANALYTICS on → play → confirm
  batched `POST /api/telemetry` (204) and rows via
  `wrangler d1 execute mars-telemetry --command "SELECT name,country,platform,count(*) FROM events GROUP BY 1,2,3"`.
  Toggle OFF → no requests; confirm no `mc-anon-id` until consent-on; RESET GAME clears both keys.
- **E2E:** `verify` skill — MENU ANALYTICS toggle flips, privacy link resolves, no console errors.
- **Android:** internal-test build → play → events land with `platform=android`; Play shows the
  install; force a crash → appears in Android Vitals.
