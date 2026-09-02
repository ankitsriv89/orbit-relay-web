# Task 2: The source allowlist

**Depends on:** Task 1 (the `sources` table).

**Deliverable:** a field carrying a `source_id` that is not on the allowlist cannot be
written to the database, proven by a test that watches the rejection happen.

**Files:**
- Create: `workers/orbit-profiles/src/sources.js`, `workers/orbit-profiles/test/sources.test.mjs`
- Modify: `workers/orbit-profiles/package.json` (add the suite)

**Interfaces:**
- Consumes: the `sources` table from Task 1.
- Produces: `SOURCES`, `assertAllowed`, `isAllowed`, `seedSources` — signatures in the
  index's Interface Summary.

---

## Why this is code and not a policy note

The spec's licensing section is the reason this task exists at all. Facts are not
copyrightable (*Feist v. Rural Telephone*, 1991), but a selection and arrangement of facts
can be — so extracting atomic fields into our own schema is sound, and ingesting another
site's curated structure is not. The line between those two is enforced here or nowhere:
**a source that has not been licence-reviewed must be unable to physically enter the
database.**

The four allowlisted sources and their priorities are in the index's Interface Summary.
Their licences and the reasoning for each are in the spec's licensing table — cite it in a
comment, do not restate it.

**The hard exclusions matter as much as the inclusions.** Gunter's Space Page has no stated
licence (all rights reserved by default) and is one person's life's work; the spec's
position is that *"I only took the facts" is a defence we should not need to make*. ESA
eoPortal, SatNOGS and Wikipedia are CC BY-SA — share-alike would infect our output. Put a
comment in `sources.js` naming the excluded sources, so a future session adding a source
reads why the list is short before lengthening it.

## Design constraints

- `assertAllowed` **throws**; `isAllowed` returns a boolean. Callers that are writing use
  the throwing form — the failure must be loud and must abort the write, not log and
  continue.
- `SOURCES` is a module constant, not a database read. The allowlist is a property of the
  code that was reviewed, not of mutable data; a row deleted from the `sources` table must
  not silently widen what ingest accepts.
- `seedSources` upserts every `SOURCES` entry, so re-running is a no-op rather than a
  duplicate-key error.

## Steps

- [ ] **Step 1: Write the failing test** covering, at minimum:
  - `assertAllowed` throws for an id not in `SOURCES` — use a realistic offender
    (`'gunters-space-page'`), not `'foo'`, so the test documents the actual risk.
  - `assertAllowed` returns without throwing for each of the four allowlisted ids.
  - `seedSources` against a `fakeDB` executes one upsert per `SOURCES` entry and binds the
    priorities the Interface Summary fixes.
  - Every `SOURCES` entry carries a non-empty `license` and `attribution_text` — a source
    with no attribution string is one we cannot legally display.

- [ ] **Step 2: Run it.** Expect failure: module not found.

- [ ] **Step 3: Implement `src/sources.js`.**

- [ ] **Step 4: Run it.** Expect PASS.

- [ ] **Step 5: Add the suite to `workers/orbit-profiles/package.json`, run `npm test`,
      commit.**

```bash
git commit -m "feat(profiles): licence allowlist, enforced at the write path"
```

**Done when:** the allowlist rejects a non-reviewed source in a test, and `npm test` is
green.
