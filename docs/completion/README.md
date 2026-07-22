# Completion Reports — Protocol

Every finished phase produces completion reports in this folder. **A phase is not closed until its reports exist.** This is how the product owner verifies progress without reading code, and how each agent proves its half before moving on.

## Who writes what

| File | Written by | When |
|---|---|---|
| `PHASE_<n>_AGENT_A.md` | Agent A | When A finishes its Phase n scope — **before A starts Phase n+1 work** |
| `PHASE_<n>_AGENT_B.md` | Agent B | When B finishes its Phase n scope — **before B starts Phase n+1 work** |
| `PHASE_<n>_CHECKPOINT.md` | Whichever agent runs the joint integration checkpoint (usually A), countersigned by the other agent inside its own report | The session the checkpoint passes |
| `PROJECT_CLOSEOUT.md` | Joint (A drafts, B appends) | End of Phase 9 |

**One file per agent per phase — the two sessions never write to the same file.** Reports are append-only after first commit: corrections are added as dated addendum sections, never by rewriting history.

## Rules

1. Use the template: [`_TEMPLATE_COMPLETION_REPORT.md`](_TEMPLATE_COMPLETION_REPORT.md). Every section filled; "N/A" is acceptable only with a reason.
2. **Honest status only.** "Done" means implemented, tested, and (for endpoints/screens) live-verified. Anything less goes under *Deviations & carry-overs* — a carried-over item is normal; a hidden one is a protocol violation.
3. The checkpoint report must contain **evidence**, not claims: the commands or clicks executed, the observable results, test-suite names and their pass counts, and the git tag (`phase-N-checkpoint`).
4. Phase closure = both agent reports + checkpoint report present **and** the product owner acknowledges with a `PHASE_<n> CLOSED` line in `docs/coordination/DECISIONS.md`.
5. Because A and B may be in different phase numbers at the same time (B builds ahead on mocks), reports are filed per agent when *that agent's* scope is done. The checkpoint report can only exist once both halves are live — if B finished on mocks earlier, B's report says so and the checkpoint report closes the loop when A catches up.
6. Carry-over items must reappear in the next phase's report (either as done or carried again with a reason). Nothing silently disappears.

## Current status board

Keep this table updated (append a row edit as a new commit; the table is the one exception to append-only):

| Phase | Agent A report | Agent B report | Checkpoint | PO closed |
|---|---|---|---|---|
| 0 | — | n/a | n/a | — |
| 1 | — | — | — | — |
| 2 | — | — | — | — |
| 3 | — | — | — | — |
| 4 | — | — | — | — |
| 5 | — | — | — | — |
| 6 | — | — | — | — |
| 7 | — | — | — | — |
| 8 | — | — | — | — |
| 9 | — | — | — | — |
