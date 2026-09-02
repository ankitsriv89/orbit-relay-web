# Task 7: Images

**Depends on:** Task 6 (the pipeline's fourth stage).

**Deliverable:** public-domain imagery compressed to WebP in R2 with a thumbnail, `images`
rows recording credit and licence, and a typed placeholder wherever there is none.

**Files:**
- Create: `workers/orbit-profiles/src/images.js`, `workers/orbit-profiles/test/images.test.mjs`
- Modify: `workers/orbit-profiles/src/index.js` (wire the stage),
  `workers/orbit-profiles/package.json`

**Interfaces:**
- Consumes: `assertAllowed` (Task 2), the checkpoint helpers (Task 6).
- Produces: `ingestImage` — signature and R2 key shape in the index's Interface Summary.

---

## Licence scope

Imagery comes from NASA / USGS / NOAA only — public domain under 17 U.S.C. §105. The NASA
*logo and insignia* are protected separately, which is not an issue for satellite imagery,
but it is the reason the allowlist entry is specifically `nasa-imagery` and not "NASA".

**Commercial operator press-kit images are editorial-use licensed, and this database is
not editorial use.** Maxar, Planet and SpaceX imagery is excluded — same hard line as
Task 2's source list. `ingestImage` runs the source through `assertAllowed` before it
fetches anything, not after.

## Failure is a normal outcome

Most of the catalogue has no image and never will. Per the spec's error table: **no image
means a typed placeholder, visibly a placeholder — never a broken `<img>`, and never a
generated pseudo-photograph.**

So `ingestImage` returns `null` rather than throwing, on every failure path: fetch failure,
non-image content type, decode failure, disallowed source. A missing image must not fail
the run for the other 27,999 objects. "Typed" means the placeholder knows what the object
*is* — a debris fragment and a payload should not get the same graphic — and Task 9 renders
it; this task only has to not write a bogus row.

## Budget shape

~2k images × ~135 KB ≈ 270 MB against R2's 10 GB. Egress is free, which is why R2 is
correct here rather than serving from D1 or a third party. Class B reads are only reached
on a cache miss, so the `_headers` rule Task 9 adds is what keeps this cheap.

Two objects per image: the full WebP and a thumbnail. The thumbnail is what
`/spacetrack/`'s panel and the encyclopedia index grid load — sizing it for the grid, not
for the detail page, is the difference between a 270 MB and a 2 GB bucket.

## Steps

- [ ] **Step 1: Write the failing test.** With a fake fetch and `fakeR2`, pin:

  - A successful ingest writes exactly two R2 objects at the key shape the Interface
    Summary fixes, and returns their keys plus real dimensions.
  - A disallowed `source_id` returns `null` and **performs no fetch at all** — assert the
    fake fetch was never called. Ordering is the point.
  - A 404, a non-image content type, and a fetch that throws each return `null` and write
    nothing to R2.
  - `credit` and `license` are persisted on the `images` row — an image we cannot attribute
    is one we cannot legally display.
  - `is_primary` is set for the first image of an object and not for subsequent ones.

- [ ] **Step 2: Run it.** Expect failure — module not found.

- [ ] **Step 3: Implement `src/images.js`.**

WebP encoding without adding a dependency is the one genuinely awkward part of this task —
`workers/orbit-profiles` is meant to stay dependency-free like its sibling. Resolve it
before writing code: either the runner is permitted one image dependency (say so in
`package.json`'s description and in the commit message), or the sources are fetched in a
format that needs no re-encoding. **Do not silently add a dependency to a package whose
stated contract is that it has none.**

- [ ] **Step 4: Run it.** Expect PASS.

- [ ] **Step 5: Wire the stage into `src/index.js`** behind its own checkpoint, so images
      restart independently of prose.

- [ ] **Step 6: Add the suite, run `npm test`, commit.**

```bash
git commit -m "feat(profiles): public-domain image ingest to R2 with provenance"
```

**Done when:** a disallowed source is rejected before any network call, every failure path
returns `null` without writing, and `npm test` is green and still offline.
