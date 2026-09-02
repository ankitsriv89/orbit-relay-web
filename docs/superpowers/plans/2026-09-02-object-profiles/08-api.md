# Task 8: The API surface

**Depends on:** Task 5 (rows exist to serve).

**Deliverable:** three endpoints — one new profile read, one faceted index, and a
`profile` key added to the existing dossier — with the existing endpoint provably unchanged
when `PROFILE_DB` is absent.

**Files:**
- Create: `functions/api/_profiles.js`, `functions/api/profile/[norad].js`,
  `functions/api/objects.js`
- Modify: `functions/api/object/[norad].js`
- Create: `workers/orbit-profiles/test/pages-api.test.mjs`
- Modify: `workers/orbit-profiles/package.json`

**Interfaces:**
- Consumes: the schema from Task 1; rows from Task 5.
- Produces: `requireProfileDb`, `profileFor`, and the three response shapes — all in the
  index's Interface Summary.

---

## Use the existing helpers

`functions/api/_catalog.js` provides `json`, `withCitation`, `cached`, `requireDb`,
`clamp`, `safeParse`. **All new endpoints use these.** Two are not optional:

- **`withCitation` carries the legally required `X-Data-Source`.** Every response, no
  exceptions.
- **`cached` is what makes `maxAge` mean anything.** Read its header comment: Cloudflare
  does not edge-cache a Function response merely because it carries a `Cache-Control`
  header — every D1-backed endpoint here once shipped a `maxAge` and none were cached.
  A new endpoint that skips `cached` runs its query on every single request.

`functions/api/search.js` is the model for `objects.js` — it already does faceted filtering
across type · country · regime · era · operator with an index behind each, and its
`buildClause(excludeParam)` cascade is the non-obvious part worth reusing. **Extend that
pattern; do not reinvent it.** Its sort-key whitelist is a security property, not a style
choice: sort keys are the one place a bound parameter cannot be used, so they are never
interpolated from the query string.

## The degradation contract

This is the most important behaviour in the task, and the one most easily broken later:

> **`PROFILE_DB` unbound, or the row missing ⇒ `profile: null`, and `/api/object/<norad>`
> behaves exactly as it does today. Never a 500.**

`profileFor` therefore never throws and never propagates a D1 error — it returns `null`.
That is deliberately unlike `requireDb`, which 503s: the dossier endpoint has a complete,
useful answer without a profile, so a profile failure must be invisible to it. Both are
exported because the two callers need opposite behaviours — `/api/profile/<norad>` *is* the
profile and 503s honestly when it cannot serve one.

Cross-database joins are impossible in D1, so composition happens in the API layer:
`profileFor` joins the existing `Promise.all` in `object/[norad].js`. It must not become a
fourth sequential await — that would add its latency to every dossier open.

`object/[norad].js`'s NORAD validation (`/^\d+$/` on the whole segment, with the comment
explaining why `parseInt` alone is insufficient) is the pattern for both new endpoints.

## Response shapes

Fixed in the index's Interface Summary. Two notes:

- `/api/objects` returns the same envelope as `search.js`, so the frontend patterns
  transfer directly to Task 9.
- `operator_derived: true` ships on every response that exposes `operator` — it is our
  inference from `OBJECT_NAME`, not a Space-Track field, and a filter that looks
  authoritative and is not is worse than one that is absent.

Cache windows: the dossier already uses 300s. Profiles change on a bulk-import cadence,
not a 6-hourly one, so they can hold longer — pick deliberately and comment the reasoning.

## Steps

- [ ] **Step 1: Write the failing tests** in `test/pages-api.test.mjs`, following the
      existing `workers/orbit-ingest/test/pages-api.test.mjs` (it imports the Function
      modules directly and calls `onRequest` with a fake context — no server). Pin:

  - **The degradation contract, three ways:** with `PROFILE_DB` absent entirely, with it
    present but the row missing, and with it present but throwing — `/api/object/<norad>`
    returns 200, `profile: null`, and a body otherwise identical to the no-profile case.
    Assert the status is not 500 in all three.
  - `/api/profile/<norad>` returns 503 when `PROFILE_DB` is unbound, 404 when the row is
    missing, and the `{profile, fields, images}` shape when present.
  - Both new endpoints set `X-Data-Source`.
  - Both reject a non-numeric NORAD segment with 400.
  - `/api/objects` cascades facets like `search.js` — picking a country narrows type and
    operator without collapsing the country list to the one chosen.
  - `/api/objects` rejects an unknown sort key rather than interpolating it.

- [ ] **Step 2: Run them.** Expect failure.

- [ ] **Step 3: Implement** `_profiles.js`, then `profile/[norad].js` and `objects.js`,
      then the one-key addition to `object/[norad].js`.

- [ ] **Step 4: Run them.** Expect PASS. Then `npm test`.

- [ ] **Step 5: Verify against a real local server** — the suite mocks the context, so it
      cannot catch a routing or binding mistake:

```bash
npm run dev
curl -s localhost:8788/api/object/25544 | head -c 400      # profile key present or null
curl -si localhost:8788/api/profile/25544 | grep -i x-data-source
curl -s "localhost:8788/api/objects?country=US&type=PAYLOAD&limit=5"
```

The console must be clean. A dead module fails silently — a 200 with a plausible body is
not proof the new file loaded.

- [ ] **Step 6: Commit.**

```bash
git commit -m "feat(profiles): profile + objects endpoints, dossier gains a null-safe profile key"
```

**Done when:** all three degradation cases return 200 with `profile: null`, and the local
server serves all three endpoints with the citation header.
