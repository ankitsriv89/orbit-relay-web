# Task 4: COSPAR matching

**Depends on:** Task 1 (the test harness).

**Deliverable:** the catalogue↔source join, keyed on COSPAR ID and never on name, with the
"ISS (NAUKA)" / "ISS DEB" trap covered by a fixture.

**Files:**
- Create: `workers/orbit-profiles/src/match.js`, `workers/orbit-profiles/test/match.test.mjs`,
  `workers/orbit-profiles/fixtures/sample_nssdca.json`, `workers/orbit-profiles/fixtures/sample_gcat.tsv`
- Modify: `workers/orbit-profiles/package.json`

**Interfaces:**
- Consumes: nothing at runtime — pure functions over rows the caller supplies.
- Produces: `normalizeCospar`, `matchByCospar` — signatures in the index's Interface
  Summary.

---

## The trap this task exists to avoid

**Match on COSPAR ID (`OBJECT_ID`), never on name.** Names change, and a substring test
matches things it should not: `"ISS (NAUKA)"` and `"ISS DEB"` both contain `"ISS"`. This is
audit finding M-19, documented at `functions/api/object/[norad].js:11-13` — read that
comment.

Getting this wrong does not produce an error. It produces a debris fragment carrying the
International Space Station's mission description, in a database whose entire value
proposition is that its facts are sourced. Silent wrong attribution is the worst failure
mode this system has.

## Format notes

- **COSPAR appears in at least three spellings** across the catalogue and the two sources:
  the canonical `1998-067A`, the compact `98067A`, and padded variants. `normalizeCospar`
  returns the canonical form or `null` — and `null` must mean *not a designator*, not
  *empty string*, so callers can tell "absent" from "malformed".
  The two-digit-year expansion has a pivot (57 → 1957, not 2057); pick it deliberately and
  pin it — the catalogue starts at Sputnik.
- **NSSDCA is keyed by COSPAR**, which is what makes it the primary descriptive source.
- **GCAT (McDowell) is CC-BY**; attribution is an `<a>` tag, satisfied by the
  `attribution_text` already in `SOURCES`.

## Fixtures

Build the two fixtures by hand, small and readable, following the pattern in
`workers/orbit-ingest/fixtures/` (real-shaped rows, not synthetic placeholders). They must
between them contain:

- ISS Zarya (NORAD 25544, `1998-067A`) with a real NSSDCA-shaped description.
- At least one `1998-067`-family debris object with a **different** suffix — the object
  that must *not* inherit Zarya's profile.
- One object whose COSPAR is written in the compact form, so normalisation is exercised by
  the join and not only by its own unit test.
- One source row matching no catalogue object, and one catalogue object matching no source
  row — both unmatched directions are return values, not errors.

`npm test` stays offline: fixtures only, no network.

## Steps

- [ ] **Step 1: Write the fixtures.**

- [ ] **Step 2: Write the failing test.** Pin, at minimum:

  - **The trap, stated as the trap:** given a catalogue containing both ISS Zarya and an
    `1998-067`-family debris object, and a source row for `1998-067A`, the profile attaches
    to 25544 **only**. Assert the debris NORAD is in `unmatchedNorad`. Comment it with the
    M-19 reference so the next reader knows what it is defending.
  - `normalizeCospar` round-trips all three spellings to the canonical form, and returns
    `null` for a name string like `"ISS (NAUKA)"`.
  - The year pivot, both sides of it.
  - Both unmatched directions are returned, and `matched` is keyed by NORAD.

- [ ] **Step 3: Run it.** Expect failure — module not found.

- [ ] **Step 4: Implement `src/match.js`.** `matchByCospar` builds one index and does a
      single pass — it runs over ~28k × 2 sources, so an inner scan is a real cost, not a
      style point.

- [ ] **Step 5: Run it.** Expect PASS.

- [ ] **Step 6: Add the suite, run `npm test`, commit.**

```bash
git commit -m "feat(profiles): COSPAR matching, never by name (M-19)"
```

**Done when:** the debris object provably does not inherit Zarya's profile, and `npm test`
is green.
