# Prompt 1 — Consolidate All Branches Into `main`

> Paste into a fresh session with repository access.
> Attach: `02_DATABASE_SCHEMA.sql`, `03_API_CONTRACT.yaml`, `01_ZIMMAMLESS_V3_REQUIREMENTS.md`.

---

You are performing a **controlled consolidation** of the repository `sohaibrabaa/zimamless_final_version` into `main`.

Two AI agent sessions have been building in parallel — one backend (NestJS, Supabase/Postgres, Python ML service), one frontend (Next.js). Their work is spread across multiple branches. Your job is to merge everything into `main` **without breaking the working system**.

This is not a routine merge. Treat it as a migration with rollback points.

## Ground rules

1. **Never force-push `main`.** Never `git push --force` anything shared.
2. **Tag before you start.** Create a rollback tag on the current `main` before the first merge.
3. **Work on an integration branch**, not directly on `main`. Merge into `main` only once the integration branch is green.
4. **Do not resolve a conflict by deleting one side's work.** If you cannot reconcile two implementations, stop and report it.
5. **Two files are frozen contracts:** `db/` schema definitions and the OpenAPI contract. A conflict in either is a **critical signal** that the two agents diverged — never auto-resolve one; report it and wait.
6. **Verify after every merge**, not once at the end. A broken merge four steps back is far harder to unpick.

## Phase 1 — Discovery (do this before touching anything)

Report, don't act:

```bash
git fetch --all --prune
git branch -a
git log --oneline --graph --all --decorate -40
```

For every branch, tell me:

| Branch | Last commit date | Commits ahead of `main` | Commits behind | Which agent / area | Appears stale? |
|---|---|---|---|---|---|

Then for each branch:

```bash
git diff --stat main...<branch>
```

And produce:

- **Ownership map** — which branch owns which directories
- **Overlap map** — every file touched by more than one branch. This is where the pain will be. List it explicitly.
- **Frozen-contract check** — has any branch modified the DB schema or the OpenAPI contract? If more than one has, flag it as **CRITICAL** immediately.
- **Migration collisions** — do two branches contain migrations with the same number, timestamp, or conflicting table changes? Check `db/migrations` carefully.
- **Dead branches** — anything fully merged already, or abandoned.

**Stop here and give me this report before merging anything.** I will confirm the merge order.

## Phase 2 — Proposed merge order

Propose an order and justify it. The default principle:

```
foundation first  →  backend domain  →  frontend  →  docs/scripts/infra
```

Backend foundation (auth, org context, RLS, audit, migrations) merges before anything that depends on it. Frontend merges after the API surface it consumes is in place. Docs and CI last — they conflict least and matter least to the build.

Also state which branches you propose to **skip** (stale, superseded, already merged) and why. Do not delete anything.

## Phase 3 — Execution

For each branch, in the approved order:

```bash
git checkout integration/consolidate
git merge --no-ff <branch>
```

Use `--no-ff` so each merge is a distinct, revertible commit.

**After each merge, run the verification gate:**

```bash
npm ci
npm run build          # or per-workspace build
npm run lint
npm test
```

Plus, specifically:
- Do all DB migrations apply cleanly, in order, on a fresh database?
- Does the backend start?
- Does the frontend build?
- Does the generated API client still match the OpenAPI contract?

If a gate fails, **fix it in that merge commit** before moving to the next branch. Do not stack broken merges.

## Phase 4 — Conflict handling rules

| Conflict type | Rule |
|---|---|
| **DB schema / OpenAPI contract** | **STOP.** Report both versions and the difference. Do not choose. |
| **DB migrations** | Never edit an applied migration. Renumber or add a corrective migration. Verify a fresh database still builds cleanly from zero. |
| **`package-lock.json`** | Take one side, then regenerate with `npm install` and commit the result. Never hand-merge it. |
| **Generated API client** | Regenerate from the contract. Never hand-merge generated code. |
| **i18n message files (`en.json`, `ar.json`)** | Union of both sides. Losing a translation key breaks a screen silently. |
| **Same function implemented twice** | Report it. Do not pick blindly — one may have been the deliberate replacement. |
| **Env / config files** | Union, then verify `.env.example` documents every variable actually read by the code. |
| **CI workflows** | Union of jobs; deduplicate steps. |

## Phase 5 — Post-merge integrity audit

Once everything is on the integration branch, verify the system is still coherent — not just that it compiles.

**Contract integrity**
- Does the live schema match the frozen `02_DATABASE_SCHEMA.sql`? List every drift.
- Does the served OpenAPI spec match `03_API_CONTRACT.yaml`? List every drift — extra endpoints, missing endpoints, changed shapes.

**Wiring**
- Is every implemented endpoint actually routed and reachable?
- Is every endpoint the frontend calls actually implemented? List any the UI calls that don't exist.
- Are there orphaned frontend screens calling nothing, or backend endpoints nobody calls?

**Critical invariants — do these still hold after the merge?**
- Atomic offer acceptance is still a single transaction with a row lock
- `minimumAcceptableAmount` appears in no bank-facing response
- RLS policies are present and enabled on every tenant table
- Money is `numeric(18,3)` everywhere, no float arithmetic reintroduced
- Ledger journals balance; no delete path on audit or financial tables
- `FUNDED` still requires both OTP verification and settlement evidence
- Maker/approver separation still enforced

**Runtime**
- Fresh database + migrations + seed → does the demo data load?
- Can you complete one end-to-end flow: supplier login → invoice submit → list → bank offer → accept → contract → fund → OTP → payout?

## Phase 6 — Land it

Only when the integration branch is fully green:

```bash
git checkout main
git merge --no-ff integration/consolidate
git tag consolidated-v3-$(date +%Y%m%d)
git push origin main --tags
```

Do not delete the source branches. Leave them until after the review in Prompt 2 completes.

## What to give me at the end

1. **Merge log** — every branch merged, in order, with conflicts encountered and how each was resolved
2. **Skipped branches** and why
3. **Drift report** — every place the code diverges from the two frozen contracts
4. **Broken or missing** — anything that doesn't work, isn't wired, or was never built
5. **Lost work check** — explicitly confirm nothing was dropped during conflict resolution, or name what was and why
6. **Rollback instructions** — the exact commands to undo this, if needed

If at any point you are unsure whether a resolution loses someone's work, **stop and ask**. A paused merge costs an hour. A silently dropped module costs the competition.
