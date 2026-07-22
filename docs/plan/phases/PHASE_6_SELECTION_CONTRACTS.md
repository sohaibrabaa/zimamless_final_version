# Phase 6 — Selection + Contracts (A) ∥ Acceptance + Signing UI (B)

**Objective:** atomic, irreversible offer acceptance — the highest-risk code in the system — and a generated, signed contract.

## Agent A tasks

- [ ] `POST /offers/{id}/accept` in **one database transaction** exactly per brief §5: `SELECT … FOR UPDATE` on the transaction row where `locked_at IS NULL`; re-validate offer ACTIVE + within `validUntil`; re-validate `netSupplierPayout ≥ minimumAcceptableAmount`; re-validate gross ≤ outstanding and invoice unmodified; set lock + `OFFER_ACCEPTED`; offer → `SELECTED`; all other active offers → `NOT_SELECTED`; insert `offer_selections`, `accepted_offer_snapshots` (all money components, conditions, versions, **content hash**), audit rows. Any failure → full rollback.
- [ ] `locked_at` immutability trigger (INV-4); idempotency-key replay returns the original 200, never re-executes.
- [ ] Acceptance role policy: Supplier Owner/Admin by default (AS-01, configurable).
- [ ] `POST /listings/{id}/reject-all` → offers rejected, transaction back to `ELIGIBLE`.
- [ ] Notifications: selected bank + not-selected banks (no competitive info in either).
- [ ] Concurrency test harness in CI (Test Strategy 5.2): parallel accepts, accept-vs-withdraw, accept-vs-revise, accept-vs-reject-all, accept-vs-window-close.
- [ ] Contract template engine: versioned templates per `transactionType` + default fallback, EN + AR, structured merge fields from snapshot + verified party data (ZM-CON-001..003); seed initial templates.
- [ ] Pre-contract checks (ZM-CON-006): invoice unchanged/valid, mandatory conditions fulfilled or waived-with-record, declarations reconfirmed, bank account verified.
- [ ] `POST /transactions/{id}/contract` (generate; `ContractTermSnapshot` + hash; document stored per PA-09) · GET.
- [ ] Dummy `SignatureProvider`: click-to-accept capturing signer identity, org, capacity, timestamp, IP, device, doc hash (ZM-CON-008); signatory authorization check (`is_authorized_signatory`); `SignatureVerification` → signature counts only after verification (ZM-CON-011); `FULLY_SIGNED` when all required signatures verified → state `CONTRACTED`.
- [ ] Conditions: `GET /transactions/{id}/conditions` · `POST /conditions/{id}/fulfil` (evidence documents, notes); `CONDITIONS_PENDING` state handling.
- [ ] Snapshot immutability test: revising/altering the source offer post-acceptance leaves the snapshot byte-identical.

### Endpoints in scope (A)

`/offers/{id}/accept` · `/listings/{id}/reject-all` · `/transactions/{id}/contract` POST/GET · `/contracts/{id}/sign` · `/transactions/{id}/conditions` · `/conditions/{id}/fulfil`

## Agent B tasks

- [ ] Acceptance confirmation modal: spells out **atomic and irreversible**, shows the full accepted breakdown one last time; success screen on the snapshot response.
- [ ] Reject-all flow with confirmation (returns to ELIGIBLE, explained).
- [ ] Post-acceptance transaction timeline (OFFER_ACCEPTED → CONDITIONS_PENDING → CONTRACTED states).
- [ ] Conditions checklist: per-condition status, fulfil action with document attach, waived-with-reason display.
- [ ] Contract review screen: rendered contract, terms from snapshot, template version, canonical-language note (EN governs — ZM-I18N-003b).
- [ ] Click-to-accept signing for authorized signatories; non-signatory users see status only; per-party signature status; `FULLY_SIGNED` state.
- [ ] Bank side: selected/not-selected result screens (not-selected shows nothing about the winner).

### Screens in scope (B)

Acceptance modal + result · reject-all · conditions checklist · contract review + sign · signature status · bank result screens.

## Ownership & collision guard

Disjoint trees. B renders the contract document served by A; no client-side contract assembly.

## Dependencies

Phase 5 checkpoint (two live approved offers to accept).

## Integration checkpoint

Live: supplier accepts the **lower** of two offers (proving no best-offer logic anywhere) → other bank flips to `NOT_SELECTED` and is notified without learning anything else → **concurrency harness: two parallel accepts on different offers, 20 iterations — every run exactly one 200 + one 409, one SELECTED, one snapshot** → both signatories sign → contract `FULLY_SIGNED` with hash → transaction `CONTRACTED`.

## Definition of done

Checkpoint met; INV-1/2/3/4 tests green in CI; snapshot-immutability test green; idempotent-replay test green.

## Effort

Agent A: 4–6 days · Agent B: 3–4 days.

## Completion reports

`docs/completion/PHASE_6_AGENT_A.md` · `PHASE_6_AGENT_B.md` · `PHASE_6_CHECKPOINT.md`.
