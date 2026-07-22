# Phase 2 Kickoff — Agent A (Backend)

> Paste everything below the line into a fresh session opened on branch
> `a/phase2` in the main checkout. Attach nothing — the session has
> repository access and every path below is in the repo.

---

You are **Agent A**, the backend engineer for **Zimmamless V3**. Agent B is
building the frontend in parallel in a separate worktree. Phases 0 and 1 are
complete, merged to `main`, and independently audited.

## Step 0 — confirm where you are, before anything else

Two agents run against this repository at once, in two different working
trees. Being in the wrong one means both of you write to the same files.

Run this first:

```bash
git rev-parse --show-toplevel
```

- If the path **ends in `.claude/worktrees/frontend`**, you are in Agent B's
  worktree. **Stop.** Tell the operator you are in the wrong window and do
  nothing else — do not switch branches, do not edit files.
- Otherwise you are in the main checkout, which is yours. Continue:

```bash
git checkout main && git pull && git checkout -b a/phase2
```

If `a/phase2` already exists, check it out instead of creating it. Confirm
with `git status` that the tree is clean before you start work.

## Read first, in this exact order

1. `docs/plan/07_KICKOFF_AGENT_A.md` — your standing brief. Everything in it
   still applies: scope, the ten hard rules, coordination protocol, and the
   completion-report gate. Read its "Read first" list and follow it.
2. `docs/coordination/DAILY_LOG.md` — **the `2026-07-23` unification entry
   first.** It is the diff between the Phase 1 you remember and the `main`
   you now have. Then Agent B's entries.
3. `docs/completion/PHASE_1_AGENT_A.md` and `PHASE_1_AGENT_B.md` — what each
   half actually delivered, including the carry-overs now landing on you.
4. `docs/plan/phases/PHASE_2_ONBOARDING_GOVERNMENT.md` — **your day-to-day
   authority for this phase.**
5. `docs/coordination/OPEN_QUESTIONS.md` — Q-01 through Q-04. Q-04 is yours.

## What changed under you while you were away

A single unification session fixed audit findings across both halves. In
your tree:

- **`TIME_PROVIDER` is now bound with `useExisting`, not `useClass`.** It was
  constructing a second `SystemTimeProvider` with its own cache, and boot was
  priming the instance nothing injects.
- **Org-context-exempt *mutations* now resolve an actor organization.**
  `PATCH /auth/language` without `X-Organization-Id` was writing audit rows
  with `actor_org_id` NULL, against hard rule 6. The guard adopts a sole
  membership and refuses multi-org users with
  `ORGANIZATION_CONTEXT_REQUIRED`. Exempt **GET**s are unchanged — `/auth/me`
  still works before any organization is known. Keep that distinction when
  you add exempt routes this phase (`/onboarding/register` is one).
- **`ErrorCode.FORBIDDEN` exists** for 403s that are not context or role
  refusals. The filter's fallback no longer mislabels them.
- **`Money.multiply()` rejects fractional JS numbers**; safe integers only.
  Pass rates as strings or `Decimal`. This will bite in Phase 2 only if you
  compute anything rate-shaped — pass strings.
- **`db/tools/verify.mjs`** derives its expected migration list from
  `db/migrations/` (the literal had stopped covering `0004`) and no longer
  silently disables TLS verification: set `PGSSLROOTCERT` to verify for real,
  or pass `--insecure-tls` to acknowledge the warning.
- **The RLS persona suite throws instead of skipping when `DATABASE_URL` is
  missing under CI.** If you add integration suites, copy that guard.
- **The conformance gate now compares success status codes**, not just paths
  and verbs — the check that would have caught your 201-vs-200. It still does
  not compare response *bodies*; see Q-04.
- **`apps/web` is a workspace member.** Root `npm run lint|typecheck|test`
  covers all three workspaces, so a root-level break is now yours to notice.
  The API keeps port 3000; the web app moved to 3001.
- **`.gitattributes` pins `eol=lf`.** The frozen-schema drift check compared
  bytes and reported false drift on Windows checkouts.

Two corrections to your Phase 1 report were made by the audit, one of which
was itself wrong and has been reverted: your "62 tables, 62 RLS-enabled"
figure was **correct** — `verify.mjs` checks a `>= 61` floor and the database
reports 62 of 62. The genuine correction stands: a **missing**
`X-Organization-Id` returns `ORGANIZATION_CONTEXT_REQUIRED`, while a
malformed uuid and a non-member org both return
`ORGANIZATION_CONTEXT_INVALID`. Only that second pair is deliberately
indistinguishable. Your handoff note said all three were identical; Agent B
was told the corrected version.

## Before Phase 2 feature work — the carried-over blocker

**The API has never been deployed.** Phase 1's exit condition and Phase 2's
stated dependency are both "auth/context live on a deployed stack", and
neither has happened. Unless the product owner has already run it:

1. Deploy per `docs/ops/DEPLOY_RUNBOOK.md`, **correcting the runbook as you
   go** — it is marked never-executed, which makes it a plan, not a procedure.
2. Run the Phase 1 checkpoint through Agent B's UI against that URL, write
   `docs/completion/PHASE_1_CHECKPOINT.md`, and tag `phase-1-checkpoint`.
3. Announce the URL in `DAILY_LOG.md` so B can flip `ENDPOINT_STATUS.md`.

Do not start Phase 2 endpoints before this. Three of the five defects you
found in Phase 1 were Supabase-specific and invisible without the live
project; the same will be true of deployment, and meeting all of it during
Phase 9 demo prep is the failure mode your own report warned about.

## Then: Phase 2

Work the task list in `PHASE_2_ONBOARDING_GOVERNMENT.md`. Three things in it
deserve emphasis because they are where this phase goes wrong:

- **`sourceAvailable=false` is structurally distinct from an adverse result**,
  end to end — hard rule 7. `90000001` (unavailable) and `90000002`
  (not found) in `docs/specs/GOV_DUMMY_DATA.md` are the paired fixture that
  proves it; INV-9's test is built on that pair.
- **Elapsed SLA time must be reconstructible from `sla_clock_events`**, not
  stored as a running total (ZM-SON-008). Business-time arithmetic over
  holiday spans and pause/resume needs unit tests this phase, not Phase 9.
- **`docs/specs/GOV_DUMMY_DATA.md` freezes when Phase 2 starts.** Agent B's
  fixtures now mirror your seed exactly, and a test in `apps/web` reads
  `db/seed/0100_seed_dev.sql` and fails if any fixture identity drifts from
  it. Adding identities is fine; renaming or renumbering breaks B's build —
  announce any addition in the daily log.

Everything else — hard rules, coordination protocol, the completion-report
gate, the order of authority for ambiguities — is unchanged from your
standing brief. End the session with `docs/completion/PHASE_2_AGENT_A.md`.
