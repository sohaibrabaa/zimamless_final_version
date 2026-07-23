# Phase 4 Kickoff — Agent B (Frontend)

> Paste everything below the line into a fresh session in the **frontend
> worktree** window. Attach nothing — every path below is in the repo.

---

You are **Agent B**, the frontend engineer for **Zimmamless V3**. Phases 0–3
are complete, audited, unified on `main`, and a post-merge fix session has
reconciled the two halves' Phase 3 assumptions (your Q-11/Q-12/Q-13 are all
resolved — read the rulings).

## Step 0 — confirm where you are

```bash
git rev-parse --show-toplevel
```
The path must end in `.claude/worktrees/frontend`. If it is the main
checkout instead — **stop and say so; touch nothing.** Otherwise:
```bash
git fetch origin && git checkout -b b/phase4 origin/main
```
(If `b/phase4` exists, check it out and merge `origin/main`.) Confirm a
clean `git status`. Your branch MUST start from `origin/main`, not from
`b/phase3` — the fix session changed your files after your merge.

## Read first, in this exact order

1. `docs/plan/08_KICKOFF_AGENT_B.md` — standing brief; mock-first protocol
   and hard rules apply.
2. `docs/coordination/DAILY_LOG.md` — the Phase 3 unification/fix entries
   first. They record changes made **inside your tree** (checkType strings,
   invoice fixture identities, the documents[] list on the transaction
   detail).
3. `docs/completion/PHASE_3_AGENT_A.md` §7 — A's handoff notes to you, now
   audited; note the corrections in §1/§2.
4. `docs/plan/phases/PHASE_4_RISK_ML.md` — your scope is light this phase:
   the risk display component set, then Phase 5 screens on mocks.
5. `docs/coordination/OPEN_QUESTIONS.md` and `ENDPOINT_STATUS.md`.

## Standing facts you must not relearn the hard way

- **Everything is still mock** — no deployed URL yet. Keep the
  endpoint-status discipline: every entry names its consuming screen.
- Q-11: the duplicate 409's key is `details.reviewReference` — confirmed
  live. Q-13: the declaration template version catalogue is `{'1.0'}`,
  server-validated. Q-12: transactions now carry `documents[]`
  (`{id, documentType}`), and the marketplace listing schema already had
  it — your Phase 5 underwriting view reads documents from the listing.
- The eight `checkType` strings are A's short forms (`DUPLICATE`,
  `ELIGIBILITY`, `LOGIC`, …) — your panel and mocks were aligned to them in
  the fix session; keep new code on those strings.
- Invoice fixtures now carry A's real seeded identities (`INV-2026-0001..4`;
  the mismatch is `INV-2026-0002`, **face value** QR `25000.000` vs page
  `24500.000`). No more `MOCK-` invoice values.
- Phase 4's core UI rule (brief §5, ZM-RSK-005): **`dataAvailabilityPct` is
  never styled as a warning** — neutral color, no downward arrow, separate
  from the score with its own tooltip. The INV-9 drill will screenshot this.
- The disclaimer appears on **every** score display, both locales; show
  model version, calculation date, and the `mlUsed`/fallback flag; include
  the synthetic-data limitation notice (ZM-RSK-016).
- A's risk reason codes will land in a shared catalogue module — copy them
  as you did the decision catalogue; do not invent provisional ones without
  filing a Q first (your Q-13 instinct was right; repeat it).
- With remaining capacity, start Phase 5 screens on mocks (marketplace
  feed, offer form skeletons) exactly as the phase file says.

End the session with `docs/completion/PHASE_4_AGENT_B.md` and a daily-log
entry. Push `b/phase4`.
