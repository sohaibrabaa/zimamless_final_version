# Phase 5 — Marketplace + Offers (A) ∥ Marketplace/Offer UI (B)

**Objective:** the confidential marketplace works end to end: listing activation with the fee, policy-filtered eligibility with recorded rules, maker/approver offers with server-computed money, and a supplier comparison screen that leaks nothing to anyone. This phase carries three of the five defining behaviours (no auction, secret floor, confidential offers).

## Agent A tasks

- [ ] Listing activation `POST /transactions/{id}/listing`: only from `ELIGIBLE`; creates **listing-fee obligation** + ledger receivable (ZM-FEE-001..005, LT-07 assumption); evaluates eligibility for **every** active bank with the specific rules recorded (`bank_eligibility.rules_applied` — ZM-MKT-003); notifies eligible banks; opens window; state → `OPEN_FOR_OFFERS`.
- [ ] Deadline jobs on `TimeProvider`: auto-close at `offerSubmissionDeadline` (no offers/revisions/withdrawals after — ZM-MKT-009); selection reminders at 50%/15% (AS-02); selection-deadline lapse → offers `EXPIRED`, listing closed, transaction back to `ELIGIBLE`.
- [ ] Policy filters: GET/POST + v3.1.0 `PATCH /banks/policy-filters/{id}` (edit/deactivate — D-12).
- [ ] Offers: create (BANK_OFFER_MAKER) / revise (new version, lineage kept) / withdraw (pre-acceptance, no penalty, audited); one current offer per bank per listing (schema index); submission window enforced.
- [ ] Server-side money: recompute `netSupplierPayout` from components, reject mismatch; inject `platformCommissionAmount` (from active tier on gross — ZM-FEE-011) and `listingFeeAmount` (unpaid portion) server-side; validate gross ≤ outstanding, net > 0.
- [ ] Floor check on create/revise: net < floor → 422 `OFFER_BELOW_SUPPLIER_REQUIREMENT`, **generic message, zero numeric detail** (ZM-MKT-012 design note).
- [ ] Maker/approver: `PENDING_INTERNAL_APPROVAL → ACTIVE` only by a different user with the approver role; self-approval 403 `SELF_APPROVAL_FORBIDDEN` at service layer (DB CHECK is the backstop) (ZM-ROL-001/002, ZM-OFR-016).
- [ ] **Confidentiality serializers (allow-lists only):** `/listings/{id}/offers` role-split — supplier: all ACTIVE offers full; bank: own offer only; `offerCount` supplier-only; `BankListingView` excludes floor/offerCount/competitors; sentinel-scan test wired (Test Strategy 5.4).
- [ ] v3.1.0: `GET /offers?status=` (approval queue + my offers — D-08) · `GET /marketplace/listings/{id}` (bank single view — D-07) · `GET /transactions/{id}/listing-current` (D-06, overlay path).
- [ ] RLS additions verified for `bank_offers`, `bank_eligibility`, `bank_policy_filters`, `listings` under the persona suite.
- [ ] Seed: a listing with two approvable draft offers for the checkpoint.

### Endpoints in scope (A)

`/transactions/{id}/listing` POST · `/transactions/{id}/listing-current` GET* · `/listings/{id}` · `/listings/{id}/offers` · `/marketplace/eligible` · `/marketplace/listings/{id}`* · `/banks/policy-filters` GET/POST/PATCH* · `/listings/{id}/offers/create` · `/offers` GET* · `/offers/{id}` GET/PATCH · `/offers/{id}/approve` · `/offers/{id}/withdraw`  (* = v3.1.0)

## Agent B tasks

- [ ] Supplier listing-activation screen: **fee shown before confirmation** with amount and the "applies whether or not financing succeeds" warning (ZM-FEE-007); deadlines shown after activation.
- [ ] Bank marketplace feed (`/marketplace/eligible`) with pagination.
- [ ] Bank underwriting view (`/marketplace/listings/{id}`): supplier + buyer verified identity, invoice data, documents, Trust Score block (Phase 4 components), data availability separate, decision-support disclaimer, double-financing platform-control disclaimer (ZM-CON-018).
- [ ] Offer creation form: gross + bank deductions inputs; commission + listing fee **server-computed read-only**; net previewed live but always reconciled to the server figure; conditions builder (type, title, description, mandatory flag); validity picker; below-floor 422 rendered generically.
- [ ] Approval queue (`GET /offers?status=PENDING_INTERNAL_APPROVAL`): creator shown; self-approval blocked in UI as well as server; approve/reject actions.
- [ ] "My offers" list with status + version lineage.
- [ ] Policy-filter configuration screen (create/edit/deactivate).
- [ ] **Supplier offer comparison — the most important screen in the product:** full per-offer breakdown (gross, each deduction, net), **net payout as the visual anchor**; transaction type + recourse type prominent with plain-language explanations; conditions listed with mandatory flags; countdown to selection deadline; **no default sort by amount, no "best"/"recommended" marking anywhere**.
- [ ] Bank offer-status views (ACTIVE / later NOT_SELECTED) showing zero competitor information.

### Screens in scope (B)

Listing activation · marketplace feed · underwriting view · offer form · approval queue · my offers · policy filters · **offer comparison** · offer status.

## Ownership & collision guard

Disjoint trees. The comparison screen consumes only supplier-role responses; the underwriting view only bank-role responses — B must not share a data-fetch layer between the two portals for offer data (prevents accidental floor/competitor bleed via a shared cache).

## Dependencies

Phase 4 (risk shown to banks) · v3.1.0 endpoints D-06/07/08/12 · Phase 2/3 (active supplier, eligible invoice).

## Integration checkpoint

Live on deployed stack: supplier activates listing (fee obligation visible) → bank A maker creates offer → **maker's self-approval attempt rejected** → approver approves → bank B creates + approves a second offer → supplier sees both fully → **bank A's session shows only its own offer and no competitor count — verified three ways: UI, raw API response diff, direct SQL under bank A's JWT (RLS)** → a deliberately below-floor offer is rejected with the generic code and the response is byte-scanned for the sentinel floor value.

## Definition of done

Checkpoint met; INV-8 sentinel + serializer allow-list tests in CI; INV-11 RLS additions green; INV-12 test green; eligibility `rules_applied` queryable and shown to admin.

## Effort

Agent A: 6–8 days · Agent B: 6–8 days.

## Completion reports

`docs/completion/PHASE_5_AGENT_A.md` · `PHASE_5_AGENT_B.md` · `PHASE_5_CHECKPOINT.md`.
