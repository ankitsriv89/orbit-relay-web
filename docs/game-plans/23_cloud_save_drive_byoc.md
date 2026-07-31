# 23 — Cloud save (BYOC): Google Drive, restore-anywhere

**Goal:** Let a player sign in and have their Mars Colony progress follow them to any
device. Chosen model = **BYOC (bring-your-own-cloud): the save lives in the user's own
Google Drive**; we store nothing server-side. **v1 = progress only** (photos stay local).

**Decisions locked (2026-07-18):** storage/auth = **Google Drive `appDataFolder` / `drive.file`
(BYOC)**; photos = **excluded from v1**.

---

## The elegant consequence: no backend
Because it's the user's own Drive and their own OAuth token, Google Identity Services
(GIS) hands the **browser** a short-lived access token that calls the Drive REST API
directly. So this feature is **pure frontend**:
- Existing `functions/` (only `functions/api/tle.js` today) is untouched. No KV/D1/R2, no
  Worker, no secrets in CI.
- Only artifact needed is a **public OAuth Client ID** (safe in frontend; no client secret
  in the token model).
- The save data goes **browser → Google Drive directly** — we never receive it. Strong
  privacy story; zero storage liability.

---

## ⚠ Dependency — nudge back into plan 22-A
Merge is **last-write-wins per site** on an `updatedAt` timestamp. The `Save(siteId)`
blobs (plan 22-A) don't stamp one today. **22-A's `saves.js` should write a per-site
`updatedAt` on every set()** now, even before this wave — cheap forward-compat that makes
cloud merge possible. Sequencing: 22-A → 21 → 22 (hub UI) → **23 (this)**, since the
sign-in UI lives on the globe hub.

---

## Scope choice (decide at build)
| Scope | File visibility | Verification | Note |
|---|---|---|---|
| **`drive.file`** (recommended) | file **visible** in user's Drive | **non-sensitive → none** | app sees only files it created; dodges Google's verification gate |
| `drive.appdata` | file **hidden** (per-app folder) | **sensitive → OAuth consent-screen verification** for public launch; testing mode ok for a capped set of listed users | invisible save, but a launch gate |

Recommend **`drive.file`** with a visible `MarsColony-save.json` unless invisibility is
required. (Confirm current Google requirements at build — scope classifications shift.)

---

## Architecture (`cloudsync.js`, new; layered over 22-A `saves.js`)

### Auth (GIS token model — client-side)
- Load `https://accounts.google.com/gsi/client`; `google.accounts.oauth2.initTokenClient({
  client_id, scope: 'https://www.googleapis.com/auth/drive.file', callback })`.
- Sign-in → access token (~1h, no refresh token client-side). On expiry, request a new one
  silently (`prompt: ''`) if the Google session is live, else re-consent. Persist only the
  signed-in *state* + token expiry locally (never the token long-term).

### Storage (Drive REST v3, direct from browser)
One JSON file holding all sites:
```
{ version: 1, updatedAt, sites: { jezero: {...updatedAt}, gale: {...updatedAt} }, prefs?: {...} }
```
- **Find:** `GET files?q=name='MarsColony-save.json'&fields=files(id,modifiedTime)`
  (`drive.file`) / add `spaces=appDataFolder` for the appdata variant.
- **Read:** `GET files/{id}?alt=media`.
- **Create:** multipart `POST upload/drive/v3/files?uploadType=multipart`.
- **Update:** `PATCH upload/drive/v3/files/{id}?uploadType=media`.
- Body mirrors the per-site `Save` blobs (+ optionally the global `Prefs`, tiny — worth
  syncing so keybinds/gear follow the user too).

### Sync model — offline-first, last-write-wins per site
- **localStorage stays the local source of truth.** Logged-out & offline play is unchanged
  from today. Cloud is strictly opt-in and additive.
- **On sign-in / load:** fetch the Drive file; per site, adopt whichever of
  `cloud.sites[id].updatedAt` vs local `updatedAt` is newer; write the merged result to
  both localStorage and Drive.
- **On local change:** stamp `updatedAt = Date.now()`, debounce (~5–10s) a `PATCH`; also
  flush on `visibilitychange → hidden`.
- **Conflict guard (optional robustness):** before PATCH, re-check Drive `modifiedTime`; if
  it advanced since our last read, re-merge first. Per-site granularity already limits the
  blast radius of a true concurrent edit (acceptable for single-player).

### UI (home = the globe hub, plan 22)
- "**Sign in with Google — sync saves**" button + a status chip (signed-out / syncing /
  synced ✓ / offline) + "Sign out." Account-level action belongs on the hub; per-site cards
  already show progress, which now reflects merged state.

---

## Caveats & user-actions
- **User config (one-time):** create a Google Cloud project → OAuth consent screen (add the
  chosen scope) → **OAuth 2.0 Client ID (Web)** with authorized JS origins = the
  signal-playground prod URL + `localhost` for dev. Client ID is public; **no client
  secret**. This is a *your-action* step — I can't provision it.
- **CSP:** allow the GIS script (`accounts.google.com/gsi/client`) and `connect-src`
  `https://www.googleapis.com` + `https://oauth2.googleapis.com`. Add if the playground
  sets a CSP.
- **Google-only / opt-in:** non-Google users stay local-only (fine).
- **Token expiry ~1h:** silent refresh via GIS; occasional re-consent is expected.
- **Photos excluded (v1):** `mc-photos` (base64 JPEGs) stays device-local. A v2 could push
  photos to the user's own Drive too (their quota) — deferred by decision.

---

## Verify
OAuth is **not headless-testable**, so:
- **Unit tests** for the merge logic (last-write-wins per site) against mocked Drive
  responses + mocked token client — the part that can silently lose data.
- **One manual smoke test:** real sign-in on two browsers/devices → progress in device A
  appears in device B; sign-out reverts to local; offline edits reconcile on next sign-in.
- No `functions/` change → no infra/architecture-doc update. Game plan (this, 23); build
  log after push; issues-and-resolutions for any bug.

## Sequencing (vs 21/22)
22-A (saves + **add `updatedAt`**) → 21 (Gale) → 22-B/C (globe hub) → **23 (cloud sync,
sign-in UI on the hub)**. Cloud sync is last: it needs both the namespaced per-site blobs
and the hub's account UI surface.

---

## AS-BUILT (2026-07-19)

Built in four commits; scope = **`drive.file`, progress-only**, per the recommendation.

- **`saves.js`** (`3dbb50e`): the serialise/merge core, all localStorage access kept
  in this module. `exportSite`/`importSite` (photos excluded; import writes verbatim so
  the merge-adopted `updatedAt` is **not** re-stamped), `siteUpdatedAt`, `exportAll`/
  `applyMerged` (the `{version,updatedAt,sites,prefs}` cloud shape), and a **pure**
  `mergeSaves(local, cloud)` — last-write-wins per site, ties keep local, null-safe.
  Unit tests **18/18**.
- **`cloudsync.js`** (`75069ea`): `createCloudSync()` — GIS token model (no client
  secret), lazy GIS-script load, interactive `signIn()` and silent `resume()`, `signOut()`
  (revoke), and `syncNow()` = find `MarsColony-save.json` → read → `mergeSaves` → apply
  local → write merged to Drive. Drive REST v3 find/read/create(multipart)/update(media)
  with a one-shot 401 silent re-auth. Only the signed-in **state** persists, never the
  token.
- **Hub UI** (`f98ef05`): top-right "Sign in with Google" → SYNCING…/SYNCED ✓/OFFLINE chip
  + Sign out; `onSynced` refreshes pin badges + the open card. E2E **11/11**.

**Design note — sync is hub-centric.** The hub is short-lived and OPEN MISSION MAP is a
full reload, so instead of a persistent cross-page sync layer, sync fires when the hub is
alive: on sign-in, on each hub visit (silent re-auth), and on tab-hide. The per-site LWW
merge makes that lossless. A within-play debounced push is deferred to v2.

**Known v1 limitations (no tombstones):** RESET SITE / RESET GAME clear the LOCAL save;
while signed in, the next sync's LWW merge sees the site only in the cloud and **restores
it**. Reset while signed out, or wait for a v2 delete-tombstone. Photos stay local (v1).

### ⚠ YOUR ACTION to activate (I cannot provision it)
Cloud sync ships **inert** — the hub shows no sign-in button until you set a Client ID:
1. Google Cloud console → new project → **OAuth consent screen** (External), add scope
   `.../auth/drive.file`.
2. **Credentials → OAuth 2.0 Client ID → Web application**. Authorized JavaScript origins =
   your prod URL (e.g. `https://signal-playground-0uj.pages.dev`) **and** `http://localhost:8931`
   for local dev. No redirect URI needed (token model), no client secret.
3. Paste the Client ID into `GOOGLE_CLIENT_ID` in `public/mars-colony/js/cloudsync.js`.
4. **Manual smoke test** (OAuth is not headless-testable): sign in on browser A → make
   progress → sign in on browser B → progress appears; sign out reverts to local; offline
   edits reconcile on next sign-in.

No `functions/`/CSP change → no infra/architecture-doc update.

---
Lead Designer and Prompter: Ankit Srivastava
Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
