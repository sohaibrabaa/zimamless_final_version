# Phase 8 — Post-Funding, Cases, Notifications (A) ∥ Post-Funding + Case UI (B)

**Objective:** the lifecycle after money moves: maturity monitoring, the unconfirmed-overdue discipline, buyer payments, recourse, disputes, withdrawal, fraud, and evidence-grade notifications including the buyer notification.

## Agent A tasks

- [ ] Maturity job on `TimeProvider`: reminders at 30/14/7 days + due date (`maturity_reminder_days`).
- [ ] Due date passes without full payment → **`OVERDUE_UNCONFIRMED`, never straight to `OVERDUE`** (ZM-PMT-008); bank prompted to confirm; `POST /transactions/{id}/confirm-status` resolves to PAID / PARTIALLY_PAID / OVERDUE (ZM-PMT-010). Absence of a report is never default (ZM-PMT-011).
- [ ] Buyer payments `POST /transactions/{id}/payments` (idempotent): amount/date/reference/evidence + `bankInternalNotes` (bank-only); reconciliation → derived outstanding balance per PA-06 (invoice row frozen; balance = snapshot outstanding − Σ payments); partial → `PARTIALLY_PAID`; full → `PAID` → close `PAID_IN_FULL`; overdue-day counter.
- [ ] Supplier payment view excludes `bankInternalNotes` + evidence (ZM-PMT-018) — allow-list serializer + test.
- [ ] `POST /transactions/{id}/close` with mandatory `closureReason` (OTHER requires notes); post-closure immutability (ZM-PMT-020).
- [ ] Recourse: **bank-only initiation** (platform admin 403 — ZM-REC-001/003); reason codes + requested amount + evidence; workflow `RECOURSE_INITIATED → SUPPLIER_NOTIFIED → PAYMENT_PENDING → SETTLED | DISPUTED | LEGAL_ESCALATION`; repayments via the settlement architecture (`/recourse/{id}/repay`, idempotent); **no automatic commission refund** (ZM-REC-009/010); v3.1.0 `GET /recourse/{id}`, `POST /recourse/{id}/status`.
- [ ] Disputes: open (`/transactions/{id}/disputes`) → **automated state changes pause while open** (ZM-REC-013 — jobs skip disputed transactions, test-asserted); v3.1.0 `POST /disputes/{id}/resolve`.
- [ ] Withdrawal cases (`/offers/{id}/withdrawal-case`): reason codes; **penalty calculated per configurable policy, recorded, never auto-deducted** (ZM-REC-016, LT-12); v3.1.0 `POST /withdrawal-cases/{id}/decide` (penalty + relisting eligibility); relisting flow — `POST /transactions/{id}/relist-request` (D-03) → manual review with ZM-REC-018 verification checks → `/admin/relisting-requests` list + approve.
- [ ] Fraud: `POST /transactions/{id}/fraud-review` freezes the transaction, halts funding, notifies Compliance (ZM-FRD-001); indicators; suspected-not-confirmed framing (ZM-FRD-004); v3.1.0 `POST /fraud-cases/{id}/decide` (CLEARED/RESTRICTED/SUSPENDED/BLACKLISTED/REPORTED).
- [ ] v3.1.0 case surface: `GET /cases?type=&status=` role-scoped + get-by-id for each case type (D-09); `case_evidence` attach.
- [ ] Supplier cancellation `POST /transactions/{id}/cancel` per §16.8 stage rules (D-12).
- [ ] Notification engine: versioned bilingual templates (`notification_templates`), EMAIL + WHATSAPP dummy adapters, IN_PLATFORM, manual-call recording; full delivery evidence immutable (ZM-NOT-007/008); the ZM-NOT-009 event catalogue wired across all prior phases' events; `DO_NOT_CONTACT` suppression (ZM-BUY-014); **buyer notification** after confirmation — operational wording, bank identity, invoice ref, delivery evidence (ZM-NOT-003..006, LT-14); write `docs/specs/NOTIFICATIONS.md`.
- [ ] v3.1.0 inbox: `GET /notifications`, `POST /notifications/{id}/read` (D-11).

### Endpoints in scope (A)

`/transactions/{id}/payments` GET/POST · `…/confirm-status` · `…/close` · `…/recourse` · `/recourse/{id}` GET*/`…/repay`/`…/status`* · `…/disputes` + `/disputes/{id}/resolve`* · `/offers/{id}/withdrawal-case` + `/withdrawal-cases/{id}/decide`* · `…/fraud-review` + `/fraud-cases/{id}/decide`* · `/cases`* · `…/relist-request`* · `…/cancel`* · `/notifications`* + `…/read`* · `/admin/relisting-requests`* (list)  (* = v3.1.0)

## Agent B tasks

- [ ] Payment timeline: payments list, outstanding balance, due date, overdue days; **`OVERDUE_UNCONFIRMED` phrased "awaiting bank confirmation" — never "defaulted"** (both languages asserted).
- [ ] Bank: report-payment form (with bank-only notes field flagged as never shown to supplier), confirm-status form, close-transaction flow.
- [ ] Bank recourse: initiate (reason, amount, evidence), case detail, status progression.
- [ ] Supplier recourse response: view case, repay, provide evidence, dispute.
- [ ] Dispute views (raise + track); automation-paused indicator.
- [ ] Bank withdrawal-case creation; platform withdrawal-case review + decide (penalty, relisting eligibility).
- [ ] Supplier relist-request flow; platform relisting review queue.
- [ ] Fraud: report entry points (supplier/bank "report a concern"), platform fraud-case queue + detail + decision; frozen-transaction banner.
- [ ] Platform case-management hub (`/cases`): fraud, disputes, withdrawal, recourse tabs.
- [ ] Notification inbox (in-platform channel) + unread badge; notification-driven deep links.

### Screens in scope (B)

Payment timeline · bank payment/confirm/close forms · recourse (bank + supplier) · disputes · withdrawal + relisting · fraud queue/detail · case hub · notification inbox.

## Ownership & collision guard

Disjoint trees. Case screens are role-scoped by the API; B must not reuse platform-role case components with bank/supplier data fetches.

## Dependencies

Phase 7 checkpoint (a FUNDED transaction) · rulings D-03/D-09/D-11/D-12.

## Integration checkpoint

Live (seeded dates near maturity; time machine arrives Phase 9): funded transaction passes due date → `OVERDUE_UNCONFIRMED` shown as awaiting confirmation → bank confirms `OVERDUE` → bank initiates recourse → supplier repays → `SETTLED` → closed `RECOURSE_SETTLED`. Partial payment recalculates balance. Dispute pauses automation (maturity job skips it, test-asserted). Buyer notification stored with full delivery evidence. Supplier payment view verifiably excludes bank notes.

## Definition of done

Checkpoint met; INV-7 no-hard-delete suite green; supplier-exclusion serializer test green; notification catalogue coverage test (every ZM-NOT-009 event has a template in both languages).

## Effort

Agent A: 6–8 days · Agent B: 5–7 days.

## Completion reports

`docs/completion/PHASE_8_AGENT_A.md` · `PHASE_8_AGENT_B.md` · `PHASE_8_CHECKPOINT.md`.
