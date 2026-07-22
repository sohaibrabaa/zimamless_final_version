# Phase 0 — Rulings, Scaffold, and Ground Rules

**Objective:** remove the known landmines before either agent writes feature code. No feature work happens in Phase 0.

**Participants:** product owner (rulings) + Agent A (scaffold). Agent B reads the pack; no code.

## Product owner must rule (in `docs/coordination/DECISIONS.md`)

| Ruling | Blocks | Reference |
|---|---|---|
| D-01 fingerprint-index fix (schema does not load as written) | Agent A session 1 | Master Plan Part 7 |
| D-02 RLS column revoke on `minimum_acceptable_amount` | Agent A session 1 | Part 7 |
| D-03..D-12 → approve API amendment **v3.1.0** + migration **0002** (additive) | Phase 2 start | Part 7 |
| D-13 ratify PA-06 (post-funding balance derived from `buyer_payments`) | Phase 8 latest, cheap now | Part 7 |
| PA-01..PA-09 assumptions (accept or override) | Phase noted per item | Master Plan Part 0 |

## Agent A tasks

- [ ] Monorepo scaffold: `/apps/api` (NestJS), `/services/ml` (FastAPI), `/db/migrations`, `/db/seed`, `/apps/web` placeholder directory (owned by B from Phase 1).
- [ ] CI: lint + typecheck + unit tests per workspace on every PR; protected `main`.
- [ ] Supabase project created (hosted) + Supabase CLI local stack working.
- [ ] `.env` conventions + `docs/specs/ENVIRONMENTS.md` started (service-role key server-only).
- [ ] Draft `docs/specs/GOV_DUMMY_DATA.md` identity list (establishment numbers for 3 suppliers, 6 buyers, failure-injection keys) so B's mocks and A's dummies share identities from day one.

## Agent B tasks

- [ ] Read: `00_START_HERE.md`, `01_..REQUIREMENTS.md`, `03_API_CONTRACT.yaml`, its brief, Master Plan, this folder. No code until Phase 1.

## Coordination artifacts created in this phase

- `docs/coordination/DAILY_LOG.md`, `OPEN_QUESTIONS.md`, `DECISIONS.md`, `ENDPOINT_STATUS.md` (stubs exist in repo — verify).
- `docs/completion/` folder with README + template (exists — verify).

## Dependencies

None.

## Integration checkpoint

- `DECISIONS.md` contains rulings for at least D-01 and D-02 (and ideally the v3.1.0 approval).
- Repo on `main` with green CI on the empty scaffold.
- Both kickoff prompts can be pasted without either agent hitting an unresolved blocking defect on day one.

## Definition of done

Checkpoint met; gov dummy identity list drafted; coordination stubs in place.

## Effort

0.5–1 day (mostly the owner's rulings).

## Completion reports

- Agent A → `docs/completion/PHASE_0_AGENT_A.md`
- Product owner (or Agent A on their behalf) records the rulings summary in the same report.
- No Agent B report required for Phase 0.
