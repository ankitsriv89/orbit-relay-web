# 19 — Mars Colony as a native Android app (TWA now, Capacitor later)

**Goal:** get mars-colony installable from the Play Store with minimal disruption to the
no-build-step vanilla-JS pattern, while keeping a real path to a fuller native app later.

## Phase 1 — TWA (Trusted Web Activity)

TWA wraps the existing live page (`marsapiens.com/mars-colony`) in a Chrome-custom-tab
shell. Zero changes to game code; the only repo-side work is two static files.

1. **`manifest.json`** for mars-colony — name, icons (192/512), `display: standalone`,
   `start_url: /mars-colony/`, theme/background color. Lives in `src/` next to the page,
   no build step.
2. **`/.well-known/assetlinks.json`** at domain root — static file served via the
   existing S3+CloudFront pipeline (no Terraform change). Content is the SHA-256
   fingerprint of the keystore that signs the Android app — this comes from the
   Android project in step 3, so assetlinks.json is finalized after it.
3. **Android wrapper project** — generated with `bubblewrap init` pointing at the
   manifest URL, then `bubblewrap build` → signed AAB → Play Console upload. This
   project does **not** live in this repo (vanilla-JS, no build step) — it goes in a
   sibling folder, likely near the Flutter app at
   `/home/ankit/ai/marsapiens-app/` (see `CLAUDE.local.md`).

## Phase 2 — full native (later, if TWA is outgrown)

- Migrate the wrapper to **Capacitor**, reusing the same web content as its WebView
  payload — Phase 1 isn't throwaway, it's the manifest/PWA foundation Capacitor needs
  too.
- Capacitor unlocks native APIs (haptics, push, deeper offline bundling) at the cost of
  a real native build pipeline — a bigger lift than TWA.
- Decision to revisit at that point: one Capacitor shell for the whole hub, or one app
  per game.

## As-built — in-repo scaffolding (standalone repo, 2026-07-19)

Built in the **standalone playground** repo (Cloudflare Pages, `public/`), not the
marsapiens `src/`+S3 repo the plan above assumed. Origin is
`https://signal-playground-0uj.pages.dev`. Everything that can ship without the Android
project is done:

| File | Purpose |
|---|---|
| `public/mars-colony/manifest.json` | PWA manifest — `id`/`start_url`/`scope` = `/mars-colony/`, `display: fullscreen` (→ standalone fallback), `orientation: landscape`, brand colors (`theme_color #1d110a`, `background_color #150b07`). |
| `public/mars-colony/icons/icon-192.png`, `icon-512.png` | App icons (`purpose: any`) — Mars planet disc rendered from the USGS Viking globe map with faux-sphere shading + gold brand rim. |
| `public/mars-colony/icons/icon-maskable-512.png` | Maskable icon — same disc scaled into the 80% safe zone on a dark bleed. |
| `public/mars-colony/index.html` | `<head>` wired: `rel="manifest"`, `theme-color`, apple-mobile-web-app + `apple-touch-icon`. |
| `public/.well-known/assetlinks.json` | Digital Asset Links — **placeholder** package_name + fingerprint (finalized after Bubblewrap; see the co-located `README.md`). |
| `public/_headers` | Pins `Content-Type: application/json` on `assetlinks.json`; long-cache on `mars-colony/icons/*`. |
| `public/_redirects` | `/mars-colony` → `/mars-colony/` (301). |

## Remaining — user-side (not in this repo)

1. **Deploy** current `public/` so the manifest + assetlinks are live:
   `npx wrangler pages deploy public --project-name signal-playground`.
2. **`bubblewrap init --manifest https://signal-playground-0uj.pages.dev/mars-colony/manifest.json`**
   in a sibling folder (e.g. near `/home/ankit/ai/marsapiens-app/`). Pick the
   `applicationId` (= the `package_name`).
3. **`bubblewrap build`** → signed AAB; keep the keystore safe.
4. **Finalize `assetlinks.json`**: paste the package name + the keystore SHA-256 **and**
   the Play App Signing SHA-256 (two fingerprints), then redeploy. Full recipe in
   `public/.well-known/README.md`.
5. **Play Console**: create the app, upload the AAB, fill listing, submit.

> The scaffolding ships **inert** for the browser (a manifest just makes the page
> installable) — the TWA only becomes "trusted" (no URL bar) once step 4's real
> fingerprints are live. Plan: launch after Play review + fixes.

## PIVOT — native Capacitor app instead of TWA (2026-07-19)

Decision: ship a **native Capacitor app** (bundled WebView), **not** a TWA. A TWA
needs a live HTTPS origin + Digital Asset Links verification tied to a purchased
domain; a Capacitor app **bundles the game inside the APK** — no domain, no
`assetlinks`, and it runs **fully offline**. The web/TWA scaffolding above is kept
**dormant** (the game is still an installable PWA on the web, and the whole
planetary-sims hub may go on a dedicated web domain later), but the app does not
use `assetlinks.json`.

Umbrella plan (user): native app now → planetary-sims hub on a new web domain
later → the complete project also imported into marsapiens with "Mars Sim" branding.

### Native as-built (2026-07-19)

**In the standalone repo — the offline prerequisite:**
- **Vendored Three.js** at `public/mars-colony/vendor/three/` (`three.module.js` →
  `three.core.js`, + `addons/loaders/GLTFLoader.js`, `addons/utils/{BufferGeometryUtils,
  SkeletonUtils}.js`). `index.html` import map now points local, not jsDelivr.
- **Verified offline**: the Jezero sim boots with all external network blocked —
  zero external requests, `three` REVISION 185 resolves from the vendored file,
  `rover.glb` decodes (29k verts). (`scratchpad/verify_offline2.py`.)

**Capacitor project (outside this repo)** at
`/home/ankit/ai/marsapiens-app/mars-colony-android/` — see its `README.md`:
- Capacitor 8.4.2 (core/cli/android); `appId com.marsapiens.marssim`, name "Mars Sim".
- `sync-www.sh` copies `public/mars-colony/` → `www/` (46 MB, self-contained).
- `android/` Gradle project added; `sensorLandscape` + immersive-fullscreen theme;
  adaptive launcher icons + splash generated from the Mars globe via `@capacitor/assets`.

### Remaining — user-side
1. Build: `npm run build:debug` (debug APK) / `adb install -r …app-debug.apk` to test on device.
2. Release: create an upload keystore, configure signing, `npm run build:release` → AAB.
3. Play Console: create app (`com.marsapiens.marssim`), upload AAB, Play App Signing, submit.
4. Optional polish: `@capacitor/status-bar` for guaranteed status-bar hide; reconcile
   in-game "MARS COLONY" title vs the "Mars Sim" launcher label.

## Status

TWA scaffolding **BUILT then superseded** by the native path (2026-07-19). Native
offline prerequisite (vendored Three) **BUILT + VERIFIED**; Capacitor project
**scaffolded + configured**; APK build + Play = user-side (list above).
