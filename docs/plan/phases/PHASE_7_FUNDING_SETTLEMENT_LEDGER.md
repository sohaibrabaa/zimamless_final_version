# Phase 7 — Funding, Cross-Party OTP, Settlement, Ledger (A) ∥ Funding UI (B)

**Objective:** funding requires both parties (defining behaviour #5), settlement is money-correct and idempotent, commission is finalized only on completed payout, and every leg is on a balanced double-entry ledger.

## Agent A tasks

- [ ] `mark-sent` (BANK_OPERATIONS, idempotent): records evidence/provider ref, state → `FUNDING_CONFIRMATION_PENDING`; **never sets FUNDED**.
- [ ] OTP generation `POST /transactions/{id}/funding/otp`: plaintext returned **once** to the bank user; hash-only storage; 15 min validity / 5 attempts / 3 resends from `platform_settings`; bound to transaction + issuing user; 429 on resend cap; every event in `funding_otp_events` with actor + IP (ZM-FND-004..009).
- [ ] OTP verification `POST /transactions/{id}/funding/confirm` (supplier): generic failure + `attemptsRemaining` only; rate-limited; `FAILED_MAX_ATTEMPTS` on cap.
- [ ] **`FUNDED` gate (INV-10): OTP `VERIFIED` AND settlement evidence — neither alone suffices** (ZM-FND-003).
- [ ] Stalled-confirmation job: reminders while pending; escalate to Operations Admin task after 24h (ZM-FND-011/012, AS-04).
- [ ] Settlement: dummy `SettlementProvider` adapter with split support (gross in → commission + unpaid listing fee withheld → net payout — ZM-FND-013/014); `settlements` row created from the snapshot with **stable idempotency key = settlement id** (INV-13); `settlement_attempts` log; `PAYOUT_FAILED` → auto-retry with backoff (max 3, AS-03) → `MANUAL_REVIEW`; `POST /settlements/{id}/retry` idempotent.
- [ ] Commission: `CommissionCalculation` prepared at acceptance (`CALCULATED`, tier snapshot per ZM-FEE-012); **`FINALIZED` only on `PAYOUT_COMPLETED`** (INV-5, ZM-FEE-013..015); reversals via compensating records only.
- [ ] Listing-fee deduction: unpaid obligation → `DEDUCTED` in the settlement split.
- [ ] Double-entry ledger postings for every leg (funding received, commission revenue, listing-fee revenue, supplier payout, reversal); journals balance (INV-6) with deferred trigger; append-only enforced; bank-reported buyer collections never enter platform-fund accounts (ZM-FEE-018).
- [ ] `GET /transactions/{id}/settlement`.
- [ ] Tests: INV-5, INV-6, INV-10 matrix, INV-13 concurrent-retry drill, OTP brute-force (6th attempt), OTP expiry, resend cap.

### Endpoints in scope (A)

`/transactions/{id}/funding/mark-sent` · `/transactions/{id}/funding/otp` · `/transactions/{id}/funding/confirm` · `/transactions/{id}/settlement` · `/settlements/{id}/retry`

## Agent B tasks

- [ ] Bank funding screen: prerequisites checklist (contract signed, conditions done) → mark-sent with evidence attach → generate OTP with **display-once, "copy this now" affordance** + expiry countdown + resends remaining.
- [ ] Supplier OTP entry: attempts remaining, generic failure messaging only (no hint of wrong/expired/used), expired/regenerate states.
- [ ] `FUNDING_CONFIRMATION_PENDING` state views both sides; escalation banner after threshold.
- [ ] Settlement status timeline: gross → deductions (commission, listing fee) → net payout; provider reference; `PAYOUT_FAILED`/`RETRYING`/`MANUAL_REVIEW` states with retry visibility (platform view gets the retry action).
- [ ] `FUNDED` celebration/confirmation state with fundedAt.
- [ ] Commission status display (platform view): CALCULATED vs FINALIZED.

### Screens in scope (B)

Bank funding + OTP generation · supplier OTP entry · pending-confirmation states · settlement timeline · payout-failure states.

## Ownership & collision guard

Disjoint trees. OTP plaintext exists only in A's single response and B's single render — B must not persist it to any store (state kept in component memory only).

## Dependencies

Phase 6 checkpoint (a CONTRACTED transaction).

## Integration checkpoint

Live happy path: mark-sent → OTP generated (shown once) → supplier enters it → with settlement evidence present, state flips to `FUNDED`; settlement panel shows the three legs. Failure drill: adapter forced to fail payout → `PAYOUT_FAILED` → auto-retries logged → manual retry succeeds → **ledger shows exactly one payout leg and all journals balance**; commission verifiably `CALCULATED` until completion, `FINALIZED` after. OTP drill: 5 wrong attempts → `FAILED_MAX_ATTEMPTS`, all audited; regenerate works within resend cap.

## Definition of done

Checkpoint met; INV-5/6/10/13 tests green in CI; OTP event audit complete; escalation task creation tested.

## Effort

Agent A: 5–7 days · Agent B: 3–4 days.

## Completion reports

`docs/completion/PHASE_7_AGENT_A.md` · `PHASE_7_AGENT_B.md` · `PHASE_7_CHECKPOINT.md`.
