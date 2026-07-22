# Phase <n> Completion Report — Agent <A|B>

**Phase:** <n> — <phase name>
**Agent:** <A backend | B frontend>
**Sessions spent:** <count> (planned range: <from phase file>)
**Dates:** <start> → <end>
**Phase file:** `docs/plan/phases/PHASE_<n>_*.md`

## 1. Delivered vs. planned

Copy the task checklist from the phase file and mark each item:

| Planned item | Status | Notes |
|---|---|---|
| <task> | ✅ done / 🔶 partial / ⛔ carried over | <evidence pointer or reason> |

## 2. Endpoints / screens

**Agent A:** endpoints implemented this phase, each marked `live` (deployed + announced in daily log) or `built-not-deployed` with reason. Confirm `/docs-json` conformance gate green.

**Agent B:** screens completed this phase, each marked `live` (wired to real endpoint, smoke passed) or `mock` (with the endpoint it waits on). Confirm `ENDPOINT_STATUS.md` updated.

| Endpoint / screen | Status | Verified how |
|---|---|---|

## 3. Tests added

| Test / suite | Covers | Status in CI |
|---|---|---|
| <name> | <invariant / requirement id> | ✅ / ❌ |

Invariants (INV-1..13) touched this phase and their test status. Any invariant scheduled for this phase without a green test = the phase is **not** done.

## 4. Deviations and carry-overs

- Deviations from the phase file (what, why, who approved — `DECISIONS.md` reference).
- Items carried to the next phase, each with reason and target phase.
- Prior-phase carry-overs resolved or re-carried.

## 5. Open questions raised

`OPEN_QUESTIONS.md` items filed this phase and their ruling status.

## 6. Risks observed

Anything that changed the Risk Register picture (Master Plan Part 4) — new early-warning signs seen, mitigations exercised.

## 7. Handoff notes for the other agent

What the counterpart needs to know entering the next phase (seed data added, behavioural quirks, timing of async jobs, renamed nothing — confirm).

## 8. Checkpoint countersignature

- [ ] I have read `PHASE_<n>_CHECKPOINT.md` and confirm the checkpoint behaviour matches what my half renders/serves.
  (Leave unchecked with a reason if not yet run — e.g. built ahead on mocks.)

---

# Appendix — for PHASE_<n>_CHECKPOINT.md only

**Checkpoint definition:** copy from the phase file.
**Executed by / date / environment:** <agent, date, deployed|local>
**Evidence:**
- Steps executed (commands, logins, clicks) in order.
- Observed results per step.
- Test suites run + pass counts.
- Git tag: `phase-<n>-checkpoint` @ <commit sha>.
**Result:** PASS / FAIL (if FAIL: what blocked, who owns the fix, retest plan).
