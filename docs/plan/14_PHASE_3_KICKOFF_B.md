# Phase 3 Kickoff — Agent B (Frontend)

> Paste everything below the line into a fresh session in the **frontend
> worktree** (`.claude/worktrees/frontend`). Attach nothing.

---

You are **Agent B**, the frontend engineer for **Zimmamless V3**. Phases 0–2
are complete, audited, unified on `main`, and a post-merge fix session has
reconciled both halves' Phase 2 assumptions.

## Step 0 — confirm where you are

```bash
git rev-parse --show-toplevel
```
If the path does **not** end in `.claude/worktrees/frontend`, you are in
Agent A's checkout — **stop and say so; above all run no checkout there.**
Once correct:
```bash
git fetch && git checkout -b b/phase3 origin/main
```
(If `b/phase3` exists, check it out.) Run `npm install` **from the repo
root** — `apps/web` is a workspace member with no lockfile of its own.

## Read first, in this exact order

1. `docs/plan/08_KICKOFF_AGENT_B.md` — your standing brief; all hard rules
   and protocol still apply.
2. `docs/coordination/DAILY_LOG.md` — the Phase 2 unification/fix entries
   first, then Agent A's. They record what changed under you after your last
   session, including the fix session's edits inside `apps/web`.
3. `docs/completion/PHASE_2_AGENT_B.md` and `PHASE_2_AGENT_A.md` — §7 of
   each is the cross-half contract you are now bound by.
4. `docs/plan/phases/PHASE_3_BUYERS_DOCUMENTS_INVOICES.md` — your
   day-to-day authority this phase.
5. `docs/coordination/OPEN_QUESTIONS.md` — Q-05…Q-10 were closed by the fix
   session; read the resolutions before assuming a shape.

## Standing facts you must not relearn the hard way

- **Everything stays `mock` until A announces a deployed URL** in the daily
  log. When it lands, flipping an entry in `lib/api/endpoint-status.ts`
  genuinely routes to the real API via `passthrough()` — flip + same-day
  smoke per entry, exactly as `ENDPOINT_STATUS.md` prescribes.
- **Every fixture identity comes from `docs/specs/GOV_DUMMY_DATA.md` and the
  seed SQL — copied, never invented.** `lib/mocks/data.spec.ts` enforces it
  and it has caught this twice now. Buyers B1–B6 are already seeded and in
  the fixtures; the blocked trio B4–B6 drives this phase's 409 screens.
- After the fix session: `governmentData` reads `sourceKind`, the
  ineligibility screen triggers on the server's real code, consents and
  reason codes are shared validated catalogues, `slaPausedReason` maps A's
  values, mock `decide` enforces live transition rules, and the handlers'
  API_BASE fallback is 3000. Build on those; don't re-derive.
- Money is never a JS number; the floor renders only in supplier/platform
  views; no auction framing; blocked-buyer states render as facts, not
  warnings against the buyer — the same neutral-tone discipline as
  `GOVERNMENT_SERVICE_UNAVAILABLE`.
- Tests are vitest, colocated `*.spec.ts`, run via `npm test -w web` with
  `npm run check:i18n -w web` for locale parity. Add tests as you build.

End the session with `docs/completion/PHASE_3_AGENT_B.md` and a daily-log
entry. Commit on `b/phase3` and push it.
