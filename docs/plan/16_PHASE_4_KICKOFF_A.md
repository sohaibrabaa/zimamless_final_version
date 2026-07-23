# Phase 4 Kickoff — Agent A (Backend)

> Paste everything below the line into a fresh session in the **main
> checkout**. Attach nothing — every path below is in the repo.

---

You are **Agent A**, the backend engineer for **Zimmamless V3**. Phases 0–3
are complete, audited, unified on `main`, and a post-merge fix session has
reconciled the two halves' Phase 3 assumptions.

## Step 0 — confirm where you are

```bash
git rev-parse --show-toplevel
```
If the path ends in `.claude/worktrees/frontend`, you are in Agent B's
worktree — **stop and say so; touch nothing.** Otherwise:
```bash
git checkout main && git pull && git checkout -b a/phase4
```
(If `a/phase4` exists, check it out.) Confirm a clean `git status` — and if
it is NOT clean, commit or stash **before** any new work: your Phase 3
journey suite was found uncommitted after the session ended and had to be
rescued by the audit.

## Read first, in this exact order

1. `docs/plan/07_KICKOFF_AGENT_A.md` — standing brief; all hard rules apply.
2. `docs/coordination/DAILY_LOG.md` — the Phase 3 unification/fix entries
   first, then Agent B's. Answer any `NEEDS FROM A` items before new work.
3. `docs/completion/PHASE_3_AGENT_A.md` (with the audit's strikethrough
   corrections) and `PHASE_3_AGENT_B.md` — §7 of each binds you.
4. `docs/plan/phases/PHASE_4_RISK_ML.md` — your authority this phase.
5. `docs/coordination/OPEN_QUESTIONS.md` — Q-11/Q-12/Q-13 are closed with
   rulings; Q-01..Q-04 remain open. **Q-03 (Arabic digit set) is needed
   before Phase 6 templates — flag it to the product owner again.**

## Standing facts you must not relearn the hard way

- **Deployment is still the gate** unless the daily log announces a URL. If
  a hosting account exists, deploy FIRST (`render.yaml`, runbook §2) — note
  the deploy now also needs the **ML service** (uvicorn, port from env) and
  the Supabase Storage bucket env vars. Smoke, write the three outstanding
  checkpoint reports, tag, announce.
- **Python works on this machine via `py` (3.13.3)**, venv at
  `services/ml/.venv`. The Phase 0 "not installed" note was wrong — do not
  resurrect it. Phase 4's model/training/inference lives in `/services/ml`
  next to the OCR code; keep the no-credentials/no-database rule there.
- **The fingerprint is v2 and excludes the supplier** (cross-supplier
  double-financing must collide — the Phase 3 audit's critical finding).
  Never reintroduce the supplier into the key.
- The eight `checkType` strings (`COMPLETENESS, DUPLICATE, ELIGIBILITY,
  FILE_INTEGRITY, IDENTITY_MATCH, LOGIC, OCR_CONSISTENCY, QR_CONSISTENCY`)
  are now shared with B's panel — renaming any is a breaking change.
- Catalogues are validated server-side and shared: reason codes, consents,
  and now `DECLARATION_TEMPLATE_VERSIONS = {'1.0'}`. Extend files, never
  accept free strings. Phase 4 adds risk reason codes — put them in the
  same catalogue pattern from day one so B can copy them.
- **INV-9 is this phase's soul**: `sourceAvailable=false` must never reduce
  any score component, only `dataAvailabilityPct`. The paired-fixture test
  (identical facts ± availability) is a Definition-of-Done item, not
  optional. Wire it into the journey/integration gates, which are now real:
  `npm run test:integration -w @zimmamless/api`.
- Dates are `::text` strings end to end — a Postgres `date` must never
  become a JS `Date` (the Phase 3 day-early defect). Risk calculation
  touching issue/due dates inherits this rule.
- Money remains string-in/string-out, 3-dp.
- Transactions carry `documents[]` (Q-12 ruling) — keep it in the describe
  payload as you extend it with `risk`.

End the session with `docs/completion/PHASE_4_AGENT_A.md` and a daily-log
entry. **Commit everything, check `git status` is clean**, push `a/phase4`.
