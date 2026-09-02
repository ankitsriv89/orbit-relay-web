# Task 1: Schema and provisioning

**Depends on:** nothing.

**Deliverable:** the `orbit-profiles` D1 database exists with its schema applied, both
bindings are wired, and `npm test` runs an `orbit-profiles` suite that guards the schema
contract — so every later task has somewhere to put tests.

**Files:**
- Create: `d1/profiles.sql`, `workers/orbit-profiles/{package.json,wrangler.toml}`,
  `workers/orbit-profiles/test/{fakes.mjs,schema.test.mjs}`
- Modify: `package.json` (root, `test` script), `wrangler.toml` (root, documentation only)

**Interfaces:**
- Consumes: nothing.
- Produces: the table and column names in the index's Interface Summary. The schema is the
  contract every later task writes to.

---

## Models to follow

Read these and match their conventions rather than inventing new ones:

- `d1/orbit.sql` — the schema file's form: idempotent throughout so it re-runs as a
  migration, header naming the binding and both `wrangler d1 execute` invocations, a
  `-- ── name ───` rule per table, and block comments carrying *why* a table holds what it
  holds rather than restating columns.
- `workers/orbit-ingest/package.json` — `private`, `type: module`, zero dependencies, a
  `test` script chaining `node --no-warnings test/*.test.mjs` with `&&`.
- `workers/orbit-ingest/wrangler.toml` — binding block style and comment density.
- `workers/orbit-ingest/test/{schema.test.mjs,fakes.mjs}` — assertion style (hand-rolled,
  no test framework) and the recording-not-simulating fake DB. `fakes.mjs`'s own header
  explains why recording beats simulating; carry that reasoning, not the prose.

## Tables

Five. Columns are fixed by the index's Interface Summary and the spec's Schema section —
do not add or rename.

`sources` · `profiles` · `profile_fields` · `images` · `ingest_checkpoints`

Three shapes are load-bearing and worth a comment in the file:

- **`sources` is the enforcement mechanism, not a lookup table.** Ingest refuses to write
  any field whose `source_id` is absent from it, so a source that has not been
  licence-reviewed cannot physically enter the database. This is the most important
  invariant here.
- **`profile_fields` needs the composite `PRIMARY KEY (norad, field)`.** Without it a
  re-run duplicates provenance rows instead of replacing them. It is a sidecar rather than
  15 provenance columns on `profiles` for the reason the spec gives.
- **`ingest_checkpoints` is keyed by stage** (`match`/`facts`/`prose`/`images`), holding
  the last completed NORAD. Resumability is a requirement, not a nicety.

Index the five dimensions the encyclopedia filters and orders by — country, launch year,
type, operator, status — plus `profile_fields(norad)` and `images(norad)`.

**One departure from `orbit-catalog` worth stating in a comment:** this database does not
need read-cost optimisation. 28k rows behind indexed filters is noise against 25B row
reads/mo. But that is a property of the paid plan, not of the workload — the query
discipline in `.claude/rules/ingest-d1.md` still applies, and a plan change is not a
licence to reintroduce unindexed `GROUP BY` scans.

## Steps

- [ ] **Step 1: Write `d1/profiles.sql`.**

- [ ] **Step 2: Write `workers/orbit-profiles/package.json` and the failing schema test.**

`test/schema.test.mjs` parses `d1/profiles.sql` as text — no database, no network. It must
pin, at minimum:

- All five tables declared, each `IF NOT EXISTS`.
- `profiles` declares every column the Interface Summary names; `norad` is
  `INTEGER PRIMARY KEY`.
- `profile_fields` carries the composite primary key.
- `sources` declares `priority` — conflict resolution orders by it.
- Every `CREATE INDEX` is `IF NOT EXISTS`, so the file re-runs.

- [ ] **Step 3: Run it. Watch it go red, then green.**

`npm --prefix workers/orbit-profiles test`

If it passes on the first run, break one assertion, re-run to confirm it *can* fail, then
restore. A test that has never been red is not evidence.

- [ ] **Step 4: Write `test/fakes.mjs`** — `fakeDB(respond)`, `fakeR2()`, and
`fakeAI(respond)` returning `{run(model, input)} → {response}`. Task 6 needs the last one
and it belongs with its siblings.

- [ ] **Step 5: Add the suite to the root `test` script.** Run `npm test`; expect green
with the new checks in the output.

- [ ] **Step 6: Write `workers/orbit-profiles/wrangler.toml`.**

Bindings: `PROFILE_DB` → `orbit-profiles` (write side), `ORBIT_R2` → `orbit-data`.
Two things the comments must say, because both are decisions a later reader would
otherwise undo:

- **No `[triggers]` block.** The bulk pass is a GitHub Actions job — 28k objects exceeds
  Worker CPU limits, the same reason `orbit-ingest` runs from Actions.
- **Not folded into `orbit-ingest`**, whose 6-hourly cadence runs against a rate budget
  whose ceiling is account suspension. Separate Workers keep the failure domains apart: a
  stuck enrichment run must not delay a GP delta.

Leave `database_id` a placeholder until the next step.

- [ ] **Step 7: Provision.**

```bash
source ~/.nvm/nvm.sh
wrangler d1 create orbit-profiles          # copy database_id into wrangler.toml
wrangler d1 execute orbit-profiles --remote --file d1/profiles.sql
wrangler d1 execute orbit-profiles --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

Expected from the last command: `images`, `ingest_checkpoints`, `profile_fields`,
`profiles`, `sources`.

- [ ] **Step 8: Wire the read side.**

Add a documented `PROFILE_DB` block to the **root** `wrangler.toml` mirroring the existing
`ORBIT_DB` block. The comment must say it is read-side only, and — per the warning already
in that file — that the binding which actually takes effect is added in the Pages dashboard
(Settings → Functions → Bindings), not here. Then add it there: name `PROFILE_DB`, database
`orbit-profiles`.

- [ ] **Step 9: Commit, push, and confirm the Pages build.**

Editing the root `wrangler.toml` is precisely the change class that silently broke every
Pages build from `28c9b049` while `ci` stayed green, so this check is not optional:

```bash
npm test
git add d1/profiles.sql workers/orbit-profiles/ package.json wrangler.toml
git commit -m "feat(profiles): orbit-profiles D1 schema, worker scaffold, bindings"
git push
gh api repos/ankitsriv89/orbit-relay-web/commits/$(git rev-parse HEAD)/check-runs \
  --jq '.check_runs[] | "\(.name): \(.conclusion)"'
```

Want `Cloudflare Pages: success`. On `failure`, the `wrangler.toml` edit is the cause —
read the build log before changing anything else.

**Done when:** the five tables exist remotely, `npm test` is green including the new suite,
and the Pages check-run reports success.
