# Task 10: The inline `/spacetrack/` panel

**Depends on:** Task 8 (`/api/profile/<norad>`). Independent of Task 9, except for the
outbound link.

**Deliverable:** selecting an object on `/spacetrack/` opens a condensed profile alongside
the existing dossier, with a link out to the full encyclopedia entry.

**Files:**
- Create: `public/shared/profile-panel.js`
- Modify: `public/shared/dossier.js`, `public/spacetrack/spacetrack.css`,
  `public/spacetrack/index.html`
- Modify: `tests/e2e/test_objects.py` (or a sibling) for the panel's behaviour

**Interfaces:**
- Consumes: `/api/profile/<norad>` (Task 8).
- Produces: `createProfilePanel` — signature in the index's Interface Summary.

---

## One database, one API, two presentations

The panel is **the profile minus the long-form sections. It is not a second data path.** It
reads the same endpoint Task 9's detail page reads. If you find yourself adding a
panel-specific endpoint or a second query shape, stop — that is the thing this design
explicitly forbids.

## Where it mounts

`public/shared/dossier.js` already owns the inspector panel for both `/spacetrack/` and
`/spacetrack/conjunctions/`. Read its header first: it exists because catalog.js and
conjunctions.js had ~95 lines of it verbatim and had **already diverged**, so behaviours
there are unconditional rather than gated. Respect that — the profile panel is likewise
unconditional for every caller, not a flag one page sets.

**Do not add a fourth copy of HUD/nav code.** There are already three (`orbital-relay.js`,
`shared/hud.js`, and a partial in `analytics.js`), and `/orbit/` is the correct side of
that divergence. The panel reuses `wireHudToggle`/`expandHud` from `/shared/hud.js` the way
the dossier already does.

`profile-panel.js` lives in `public/shared/` and is imported root-absolute
(`/shared/profile-panel.js`), matching how `dossier.js` imports its own dependencies.

## Failure is the common case

Most objects have no profile — the panel must be *absent*, not *empty*, and never an error.
Specifically:

- `profile: null`, a 404, or a fetch failure ⇒ the panel does not render. The dossier
  continues to work exactly as it does today. A user selecting a debris fragment should see
  no change from current behaviour.
- The panel never blocks the dossier's own render. The dossier already awaits
  `/api/object/<norad>`; the profile fetch must not serialise behind it in a way that
  delays the position readout.
- No image ⇒ the typed placeholder from Task 7's contract, never a broken `<img>`.

## What it shows

Condensed: thumbnail, official name, mission summary, and the handful of key facts —
**each with its source**, because rendering *launch mass: 6,161 kg (NSSDCA)* is the whole
point of the provenance sidecar. Then the link out to `/objects/<norad>/`.

`operator` stays badged as derived wherever it appears — it is our inference from
`OBJECT_NAME`, not a Space-Track field.

**No `insertAdjacentHTML` with API-derived content.** Build nodes and set `textContent`.
The existing dossier's `setText` pattern is right there.

## Mobile

`/spacetrack/` is a globe page over a full-screen WebGL canvas, which makes two things
matter more than usual:

- **`backdrop-filter` is halved on mobile** (`--hud-blur`). A 16px blur over that canvas is
  one of the most expensive things a phone GPU can do — use the token, do not hardcode.
- Read `orbit.css:1-31` before touching fixed chrome. The comment explains why the HUD
  stack *adds* safe-area insets rather than wrapping offsets in `max()`. That reasoning is
  load-bearing; do not "simplify" it.

`spacetrack.css` has **no `:root`** and inherits tokens from `orbit.css` by hand-written
`<link>` order — **do not reorder those tags.**

Landscape phone matters here: people rotate globe pages. 1133×744 is in the viewport table
for that reason.

## Steps

- [ ] **Step 1: Write the failing e2e test.** Pin:

  - Selecting an object with a profile opens the panel with its facts and at least one
    visible source attribution.
  - Selecting an object **without** a profile leaves the dossier working and shows no
    panel — assert the dossier's own fields still populate.
  - The link out points at `/objects/<norad>/`.
  - No horizontal page scroll at 390×844 and 1133×744 with the panel open.
  - Touch targets in the panel are ≥ 44px.

- [ ] **Step 2: Run it.** Expect failure.

- [ ] **Step 3: Implement `public/shared/profile-panel.js`.**

- [ ] **Step 4: Mount it from `dossier.js`** and add the markup hook to
      `public/spacetrack/index.html` plus styles in `spacetrack.css`.

- [ ] **Step 5: Verify locally.**

```bash
npm test
npm run dev
```

Open `/spacetrack/`, select an object with a profile and one without. **Console clean both
times.** Check 390px and landscape before running the suite.

- [ ] **Step 6: Run the e2e suite.** Expect PASS.

- [ ] **Step 7: Commit, push, confirm the deploy.**

```bash
git commit -m "feat(spacetrack): inline profile panel on object selection"
git push
gh api repos/ankitsriv89/orbit-relay-web/commits/$(git rev-parse HEAD)/check-runs \
  --jq '.check_runs[] | "\(.name): \(.conclusion)"'
```

**Done when:** an object without a profile is indistinguishable from today's behaviour, an
object with one shows sourced facts, and the mobile viewports pass with the panel open.

---

## After this task

The plan is complete. Two follow-ups the spec names but defers — do not start either
without being asked:

- **The daily delta.** New NORAD IDs get Tier 2 immediately and queue for Tier 3, hooked to
  the existing SATCAT ingest. **No new scheduled workflow** — it piggybacks the existing
  daily run. The orbital timeline needs no work at all: `events` already updates daily.
- **Tier 4 enrichment** — the human-triggered web-search pass for the few hundred notable
  objects where Tier 1 is thin, stored in a separate column and styled visibly differently.

Also worth doing at some point, noted in the spec's housekeeping and unrelated to this
work: `media-mirror/` and `media-manifest.txt` no longer exist, but stale references remain
in `.gitignore:17-18`, `AGENTS.md:27` and `CLAUDE.md:160`.
