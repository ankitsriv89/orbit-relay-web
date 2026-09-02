# Task 5: Facts and Tier 2 prose

**Depends on:** Tasks 2 (allowlist) and 4 (matching).

**Deliverable:** `profiles` + `profile_fields` are written with deterministic conflict
resolution, and every catalogued object has prose — including the ~25k debris objects and
rocket bodies, which get it with no model call at all.

**Files:**
- Create: `workers/orbit-profiles/src/facts.js`, `workers/orbit-profiles/src/prose-tier2.js`,
  `workers/orbit-profiles/test/facts.test.mjs`, `workers/orbit-profiles/test/prose-tier2.test.mjs`
- Modify: `workers/orbit-profiles/package.json`

**Interfaces:**
- Consumes: `assertAllowed` (Task 2); `matchByCospar` output (Task 4).
- Produces: `resolveConflicts`, `writeFacts`, `tier2Prose` — signatures in the index's
  Interface Summary.

---

## Tier 2 is most of the product

~25k of ~28k objects are debris and rocket bodies. They have no mission, and **must never
be described as having one.** Tier 2 covers them deterministically: derived from SATCAT
fields already held, zero hallucination surface, zero cost. The spec's example is the
target register:

> *"SL-4 rocket body from the 2019-047 launch, in a 71.0° orbit at 340 × 355 km."*

Constraints on `tier2Prose`:

- **Deterministic.** Same input always yields the same string, byte for byte. Pin this with
  a test that calls it twice — it is what makes the ~25k rows reproducible and diffable.
- **No model, no network, no clock.** A timestamp inside the prose would make it
  non-deterministic and would be a numeral the validator has no fact for.
- **Type-aware, and conservative.** A debris fragment gets a debris sentence. Never emit a
  purpose, mission or operator claim for a `DEBRIS` or `ROCKET BODY` row, regardless of
  what the name looks like.
- **Degrades on missing fields** — a row with no apogee/perigee still produces a sentence,
  it just says less. Half the catalogue is missing something.

Numbers it emits come from the row and are therefore facts by construction. Keep the
formatting (decimal places, `×` for the altitude pair) consistent with what
`public/shared/dossier.js` already shows, so the two never appear to disagree.

## Conflict resolution

Two sources disagreeing on a fact is expected, not exceptional. **Higher `sources.priority`
wins; the conflict is logged, never silently dropped.** Deterministic, not last-write —
ties break on `source_id` ascending purely so a re-run cannot reorder the output.

`resolveConflicts` returns conflicts as data rather than logging them itself: it stays pure
and the caller decides what to do with them.

## The enforcement point

`writeFacts` calls `assertAllowed` on **every** fact before writing. This is where the
licence allowlist actually bites — Task 2 built the mechanism, this is the call site that
makes it real. A fact from a non-allowlisted source must abort the write loudly, not skip
quietly.

`profile_fields` writes one row per populated field, and the composite primary key from
Task 1 makes a re-run replace rather than duplicate.

## Steps

- [ ] **Step 1: Write the failing tests.** Pin, at minimum:

  *`prose-tier2.test.mjs`*
  - Determinism: two calls on the same row are byte-identical.
  - A `DEBRIS` row and a `ROCKET BODY` row produce prose containing **no** mission or
    purpose language. Assert on absence explicitly — this is the invariant, not a nicety.
  - A row missing apogee/perigee still yields a sentence and does not emit `undefined`,
    `NaN` or a dangling unit.
  - Every numeral in the output appears in the input row. Import `validateProse` from
    Task 3 and run it over the Tier 2 output — **Tier 2 must pass its own validator**, and
    wiring that here proves the two agree before Task 6 depends on it.

  *`facts.test.mjs`*
  - `resolveConflicts` prefers the higher-priority source; the loser appears in
    `conflicts`, not in `fields`.
  - Equal priorities resolve deterministically and identically across repeated calls.
  - `writeFacts` throws when handed a fact whose `source_id` is not allowlisted, and
    **writes nothing** in that case.
  - Against a `fakeDB`: one `profiles` upsert plus one `profile_fields` row per populated
    field, with the right NORAD bound to each.

- [ ] **Step 2: Run both.** Expect failure — modules not found.

- [ ] **Step 3: Implement `src/prose-tier2.js` and `src/facts.js`.**

Watch the complexity gate here: type-branching plus optional-field handling is exactly how
a function reaches 11+. Extract per-type sentence builders named for the type they serve.

- [ ] **Step 4: Run both.** Expect PASS.

- [ ] **Step 5: Add both suites, run `npm test`, commit.**

```bash
git commit -m "feat(profiles): facts with provenance, deterministic Tier 2 prose"
```

**Done when:** Tier 2 output passes Task 3's validator, debris rows provably claim no
mission, and a non-allowlisted source aborts the write.
