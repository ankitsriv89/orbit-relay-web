# Task 6: Tier 3 prose and the pipeline

**Depends on:** Task 3 (validator), Task 5 (facts + Tier 2 fallback).

**Deliverable:** generated prose for the ~3k objects with substantive Tier 1 facts, every
sentence gated by Task 3's validator, inside a four-stage pipeline that restarts where it
died.

**Files:**
- Create: `workers/orbit-profiles/src/prose-tier3.js`, `src/checkpoint.js`, `src/index.js`,
  `scripts/run-profiles.mjs`, `scripts/env-node.mjs`,
  `test/{prose-tier3,checkpoint,pipeline}.test.mjs`, `.github/workflows/orbit-profiles.yml`
- Modify: `workers/orbit-ingest/scripts/ai-node.mjs` (register the model),
  `workers/orbit-profiles/package.json`

**Interfaces:**
- Consumes: `validateProse` (Task 3), `tier2Prose` + `writeFacts` (Task 5),
  `matchByCospar` (Task 4).
- Produces: `tier3Prose`, `readCheckpoint`, `writeCheckpoint` — signatures in the index's
  Interface Summary.

---

## Reuse the existing AI seam

`workers/orbit-ingest/scripts/ai-node.mjs` already provides exactly the interface needed:
`WorkersAI` and `GroqAI`, both normalised to `run(model, input) → {response}`, selected by
`ORBIT_AI_PROVIDER`, returning `null` when no credential is configured. **Import it; do not
write a second client.** Its header explains why the seam exists — the same reasoning
applies here.

Your change to it is small: register `openai/gpt-oss-20b` as the Tier 3 default. The spec
treats the model as a config value that gets validated on a sample before commitment, so it
must be overridable by `ORBIT_AI_MODEL` and must not be hardcoded at the call site.

`createAI` returning `null` is a **supported state**, matching the daily brief's behaviour:
no credential means the whole catalogue is Tier 2 and the run still succeeds. Pin that.

## Tier 3 is constrained rewriting, not generation

The model is given verified Tier 1 facts and asked to phrase them. It never sources a
number. ~400 input tokens, ~150 output — the prompt is short because the facts are the
prompt.

Non-negotiables for `tier3Prose`:

- **Every returned string has passed `validateProse`.** On rejection, return the Tier 2
  fallback with `tier: 2` and the rejected sentences — never publish unvalidated prose,
  never repair it by retrying until it passes.
- **Never throws.** A 429, a timeout, a malformed response and a `null` client all resolve
  to the Tier 2 fallback. The object stays Tier 2 and requeues.
- **Tier 3 only where Tier 1 is substantive.** Decide "substantive" as an explicit,
  testable predicate over the fact set, not a vibe — and keep it narrow. Cost is not the
  reason: **hallucination surface and review burden are.**

## Resumability

Four stages — match, facts, prose, images — each independently restartable, each
checkpointed by last-completed NORAD. A run that dies at object 14,000 restarts at 14,000.

GitHub caps a single job at 6 hours, and **that is the real reason to chunk, not cost** —
Actions minutes on this public repo are free and unlimited (the spec's measured budget
section). Chunk by NORAD range so a resumed run is a narrower query, not a re-scan.

Checkpoint writes must be **durable before** the work they cover is acknowledged, or a
crash re-does or skips a chunk. Order the write deliberately and pin it with a test.

## Pipeline orchestration

`src/index.js` mirrors `workers/orbit-ingest/src/index.js`'s `step()` pattern — read it.
Per-step failures are captured and the run continues; the report records what failed. Carry
over the reasoning, not the code: a stuck image fetch must not cost the prose that was
already generated.

`scripts/env-node.mjs` is a thin re-export of `orbit-ingest`'s shim rebound to
`PROFILE_DB` — that file's D1/R2 implementations are already tested and must not be
duplicated. `scripts/run-profiles.mjs` follows `run-ingest.mjs`: same exit-code contract
(0 ok, 1 step failed, 2 misconfigured), same `GITHUB_STEP_SUMMARY` table.

## The workflow

`.github/workflows/orbit-profiles.yml` is `workflow_dispatch` only — no schedule. Model it
on `orbit-ingest.yml`, including its `concurrency` group (a second concurrent run would
race the checkpoints) and its untrusted-input handling for dispatch values.

Secrets needed beyond the existing set: `GROQ_API_KEY` (already referenced by
`orbit-ingest.yml`) and a `PROFILE_D1_DATABASE_ID`.

**After v1, only new launches are profiled** — a small daily delta hooked to the existing
SATCAT ingest. **No new scheduled workflow**: it piggybacks the existing daily run. Do not
build that in this task; leave a comment in `src/index.js` naming it as the follow-up so
nobody adds a cron here.

## Steps

- [ ] **Step 1: Write the failing tests.** Pin, at minimum:

  *`prose-tier3.test.mjs`* — with `fakeAI`:
  - A response containing a fabricated numeral returns `tier: 2`, the Tier 2 fallback
    verbatim, and the offending sentence in `rejected`.
  - A clean response returns `tier: 3`.
  - A client that throws a 429 returns the fallback and **does not throw**.
  - A `null` client returns the fallback.
  - The prompt sent to the model contains the facts and does **not** ask for anything the
    facts do not contain.

  *`checkpoint.test.mjs`*
  - Absent checkpoint reads as `0`.
  - Write-then-read round-trips per stage; stages are independent.

  *`pipeline.test.mjs`*
  - A stage that throws does not abort the remaining stages, and the report marks it failed.
  - A resumed run starts from the checkpoint and does not reprocess earlier NORADs.

- [ ] **Step 2: Run them.** Expect failure.

- [ ] **Step 3: Implement** `src/checkpoint.js`, `src/prose-tier3.js`, `src/index.js`, then
      `scripts/env-node.mjs` and `scripts/run-profiles.mjs`. Register the model in
      `ai-node.mjs`.

- [ ] **Step 4: Run them.** Expect PASS. Then `npm test` — the whole suite, still offline.

- [ ] **Step 5: Write `.github/workflows/orbit-profiles.yml`.**

- [ ] **Step 6: Validate the model on a sample before committing to it**, as the spec
      requires. Run one chunk (~50 objects) against the real Groq endpoint and read the
      output. Record in the commit message: how many were rejected by the validator, and
      whether the surviving prose reads as substantive or as filler. **If it reads as
      filler, the model is the variable to change — not the validator.**

- [ ] **Step 7: Commit.**

```bash
git commit -m "feat(profiles): Tier 3 generation behind the validator, resumable 4-stage pipeline"
```

**Done when:** a fabricated numeral provably downgrades to Tier 2, a 429 does not fail the
run, a resumed run skips completed work, and you have read real sampled output.
