# Task 3: The numeral validator

**Depends on:** Task 1 (the test harness).

**Deliverable:** a pure function that rejects any sentence containing a numeral absent from
the input facts — **written before any generator exists, and watched red on a real
fabricated number.**

**Files:**
- Create: `workers/orbit-profiles/src/validate.js`, `workers/orbit-profiles/test/validate.test.mjs`
- Modify: `workers/orbit-profiles/package.json`

**Interfaces:**
- Consumes: nothing. This module is pure — no database, no network, no model.
- Produces: `validateProse`, `extractNumerals`, `factNumerals` — signatures in the index's
  Interface Summary.

---

## The rule, and why it is stricter than it looks

Reject any sentence containing a numeral absent from the input facts — **including a
correct one the model derived.** From the output alone, a correct derivation is
indistinguishable from an invention. A model that writes "orbits roughly 16 times a day"
from a 92-minute period has done arithmetic we cannot verify at scale, and a model that
writes "carries 6 instruments" from facts listing none has invented. The output looks
identical.

This is the same discipline as `checkNarrative()` in `workers/orbit-ingest/src/brief.js` —
**read it before writing this.** Rather than porting it: that function is tuned for one
daily paragraph against a fixed fact object, this one runs ~3k times against heterogeneous
per-object facts. Take the rule and the reasoning; write the implementation for this shape.

**Smaller models drift numbers more readily**, which is what makes this load-bearing rather
than defensive. The spec commits to a 20B model for Tier 3, so this validator is the thing
standing between that choice and a database of confident fabrications.

## Design constraints

- **Pure.** No I/O of any kind. It must be constructible in a unit test with two plain
  arguments — that is what makes it cheap to prove.
- **Sentence-granular rejection.** One bad sentence must not discard a good paragraph;
  `rejected` returns the offending sentences verbatim so the caller can log what was
  actually said. `ok === true` iff `rejected` is empty.
- **Normalisation is where the bugs live.** `6,161` and `6161` are the same number;
  `1998-067A` contains digits that are not a claim; `92.68` and `92.680` agree. Decide the
  normalisation deliberately and pin each decision with a test — this is the part a later
  session will be tempted to "simplify".
- Years and COSPAR designators appear in both facts and prose constantly. Whatever rule you
  pick for them, it must not become a hole wide enough to pass an invented mass through.

## Steps

- [ ] **Step 1: Write the failing test first.** This ordering is mandated by the spec and
      by `CLAUDE.md` ("write the guardrail before the fix and watch it go red on the real
      bug"). The suite must pin, at minimum:

  - **The headline case:** facts giving a 6,161 kg launch mass; prose claiming
    *"a launch mass of 6,500 kg"*. Expect rejection naming `6500`.
  - **The uncomfortable case:** facts giving a 92.68-minute period; prose claiming
    *"orbits about 16 times a day"*. `16` is arithmetically correct and **must still be
    rejected** — this test is the one that documents the rule's whole point. Say so in a
    comment on the test.
  - **The pass case:** prose using only numerals present in the facts, including one
    written with a thousands separator when the fact has none.
  - **Mixed:** a two-sentence input where one sentence is clean and one is not — assert
    exactly one entry in `rejected`, and that it is the right one.
  - **No numerals at all:** purely qualitative prose passes.
  - Whatever you decided for years and COSPAR designators, pinned explicitly.

- [ ] **Step 2: Run it and watch it go red on the fabricated 6,500 kg.**

Run: `node --no-warnings workers/orbit-profiles/test/validate.test.mjs`
Expected: FAIL — the module does not exist yet. **Do not proceed until you have seen this
output.** The spec asks for the validator to be watched red on a real fabricated number
specifically so nobody later trusts a guard that was never exercised.

- [ ] **Step 3: Implement `src/validate.js`.** Under ~60 lines per function; the
      normalisation belongs in `extractNumerals`/`factNumerals`, not inlined into
      `validateProse`.

- [ ] **Step 4: Run it.** Expect PASS on every case, the derived `16` included.

- [ ] **Step 5: Add the suite, run `npm test`, commit.**

```bash
git commit -m "feat(profiles): numeral validator — rejects unsupported numbers, derived ones included"
```

**Done when:** the derived-numeral test passes (i.e. the derivation is rejected), and you
have personally seen the suite fail before it passed.
