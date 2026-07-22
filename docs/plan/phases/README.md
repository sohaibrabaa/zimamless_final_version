# Zimmamless V3 — Phase Files (Index)

One file per phase. Each phase file is self-contained: objective, Agent A tasks, Agent B tasks, endpoints and screens in scope, dependencies, integration checkpoint, definition of done, effort, and the completion-report duty.

**Both agents work in parallel from Phase 1 onward.** Collisions are prevented structurally, not by luck — see "How parallel work stays collision-free" below.

| Phase | File | Agent A delivers | Agent B delivers | Checkpoint in one line |
|---|---|---|---|---|
| 0 | [PHASE_0_RULINGS_SCAFFOLD.md](PHASE_0_RULINGS_SCAFFOLD.md) | Repo scaffold, CI, Supabase project | — (reads the pack) | Rulings recorded; green CI on empty scaffold |
| 1 | [PHASE_1_FOUNDATION_SHELL.md](PHASE_1_FOUNDATION_SHELL.md) | Auth, org context, RLS, audit, migrations | Design system, i18n/RTL, codegen+mocks, shells | Login + org switch + language via live API |
| 2 | [PHASE_2_ONBOARDING_GOVERNMENT.md](PHASE_2_ONBOARDING_GOVERNMENT.md) | Applications, SLA clock, gov adapters | Onboarding wizard, SLA tracker, review queue | Register → approve, SLA pause/resume live |
| 3 | [PHASE_3_BUYERS_DOCUMENTS_INVOICES.md](PHASE_3_BUYERS_DOCUMENTS_INVOICES.md) | Buyers, documents, OCR/QR, invoices, checks | Six-step invoice wizard | Invoice reaches ELIGIBLE with real OCR |
| 4 | [PHASE_4_RISK_ML.md](PHASE_4_RISK_ML.md) | Rules engine, ML pipeline, scoring | Trust Score components | Live score; fallback flagged; INV-9 proven |
| 5 | [PHASE_5_MARKETPLACE_OFFERS.md](PHASE_5_MARKETPLACE_OFFERS.md) | Listings, eligibility, offers, confidentiality | Marketplace + offer screens, comparison view | 2 banks offer blind; supplier compares; floor never leaks |
| 6 | [PHASE_6_SELECTION_CONTRACTS.md](PHASE_6_SELECTION_CONTRACTS.md) | Atomic accept, snapshot, contracts, signatures | Acceptance modal, signing screens | Concurrent accepts → 1 winner; FULLY_SIGNED |
| 7 | [PHASE_7_FUNDING_SETTLEMENT_LEDGER.md](PHASE_7_FUNDING_SETTLEMENT_LEDGER.md) | OTP, settlement, commission, ledger | Funding screens, OTP entry, settlement status | FUNDED via cross-party OTP; no double payout |
| 8 | [PHASE_8_POSTFUNDING_CASES_NOTIFICATIONS.md](PHASE_8_POSTFUNDING_CASES_NOTIFICATIONS.md) | Maturity, payments, recourse, cases, notifications | Payment timeline, case management, inbox | Overdue → confirm → recourse → settled |
| 9 | [PHASE_9_ADMIN_SEED_DEMO_HARDENING.md](PHASE_9_ADMIN_SEED_DEMO_HARDENING.md) | Admin, full seed, time machine, invariant suite | Admin screens, Arabic/RTL pass, a11y | Full demo script runs twice, EN + AR |

## How parallel work stays collision-free

1. **Disjoint file ownership.** A owns `/apps/api`, `/services/ml`, `/db`, root config. B owns `/apps/web`. Neither ever edits the other's tree. A git conflict between the agents outside root config is an ownership violation — stop and log it.
2. **The frozen contract is the only interface.** B generates its client and mocks from `03_API_CONTRACT.yaml` (+ approved v3.1.0 overlay), never from A's running code. A's CI diffs its served `/docs-json` against the same file. Both sides converge on the file, not on each other.
3. **Append-only shared docs, separate files per agent.** `docs/coordination/DAILY_LOG.md` is append-only with per-agent entries; completion reports live in per-agent files (`PHASE_<n>_AGENT_A.md` vs `PHASE_<n>_AGENT_B.md`) so the two sessions never write the same file.
4. **Per-endpoint mock→live promotion.** B's screens run on MSW mocks until A announces an endpoint live in the daily log; B flips exactly that endpoint and smoke-tests the same day. No big-bang integration.
5. **Branch naming:** `a/<phase>-<topic>` and `b/<phase>-<topic>`, merged to protected `main` at least daily. Tags `phase-N-checkpoint` at each passed checkpoint.
6. **Phase overlap is allowed and expected.** A and B do not need to be in the same phase number: B may build Phase 5 screens on mocks while A is finishing Phase 3. The *checkpoint* of a phase is the only synchronization point — it requires both halves live.

## Completion reports (mandatory)

When an agent finishes its half of a phase, it writes a completion report to `docs/completion/` **before starting the next phase** — see [docs/completion/README.md](../../completion/README.md) for the protocol and template. A phase is closed only when both agents' reports plus the joint checkpoint record exist and the product owner has acknowledged in `docs/coordination/DECISIONS.md`.
