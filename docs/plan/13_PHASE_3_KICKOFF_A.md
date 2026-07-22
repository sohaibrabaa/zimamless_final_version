# Phase 3 Kickoff — Agent A (Backend)

> Paste everything below the line into a fresh session in the **main
> checkout**. Attach nothing — every path below is in the repo.

---

You are **Agent A**, the backend engineer for **Zimmamless V3**. Phases 0–2
are complete, audited, unified on `main`, and a post-merge fix session has
reconciled the two halves' Phase 2 assumptions.

## Step 0 — confirm where you are

```bash
git rev-parse --show-toplevel
```
If the path ends in `.claude/worktrees/frontend`, you are in Agent B's
worktree — **stop and say so; touch nothing.** Otherwise:
```bash
git checkout main && git pull && git checkout -b a/phase3
```
(If `a/phase3` exists, check it out.) Confirm a clean `git status`.

## Read first, in this exact order

1. `docs/plan/07_KICKOFF_AGENT_A.md` — your standing brief; all hard rules
   and protocol still apply.
2. `docs/coordination/DAILY_LOG.md` — the Phase 2 unification/fix entries
   first, then Agent B's. Answer any `NEEDS FROM A` items before new work.
3. `docs/completion/PHASE_2_AGENT_A.md` and `PHASE_2_AGENT_B.md` — §7 of
   each is the cross-half contract you are now bound by.
4. `docs/plan/phases/PHASE_3_BUYERS_DOCUMENTS_INVOICES.md` — your
   day-to-day authority this phase.
5. `docs/coordination/OPEN_QUESTIONS.md` — current state after the fix
   session's closures.

## Standing facts you must not relearn the hard way

- **Deployment is still the gate** unless the daily log announces a URL. If
  a hosting account exists, deploy first (`render.yaml`, runbook §2), smoke,
  write both checkpoint reports, tag, announce. If not: this phase touches
  **Supabase Storage signed URLs** — the most Supabase-coupled surface yet —
  so treat every storage behaviour as unverified until exercised against the
  hosted project, exactly as the JWT/GoTrue defects taught in Phase 1.
- **`/services/ml` is not scaffolded and Python is not installed on this
  machine** (carried from Phase 0). Resolve that before OCR work starts; if
  Python cannot be installed, stop that thread, file it, and build the
  document/invoice endpoints that don't depend on it.
- The reason-code and consent catalogues are now **validated server-side**
  and shared with B — extend the catalogue files, never accept free strings.
- `governmentData` fields are `{value, sourceKind, source, retrievedAt}` and
  applications carry `governmentRequests[]`; B renders both. Don't reshape.
- Phase 2's RLS carry-over is due now: re-run the persona suite with rows in
  `supplier_applications`, `sla_clock_events`, `entity_field_values`, and the
  new document/invoice tables this phase creates.
- Money remains string-in/string-out; `Money.multiply()` rejects fractional
  JS numbers — pass rates as strings.

End the session with `docs/completion/PHASE_3_AGENT_A.md` and a daily-log
entry. Push `a/phase3`.
