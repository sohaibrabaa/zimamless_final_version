# Agent A — Backend Brief

**Session:** A (backend, data, services)
**Owns:** NestJS API, PostgreSQL/Supabase, Python OCR/ML service, all adapters, jobs, seed data
**Does NOT own:** anything under `/apps/web`

---

## 1. Read first, in this order

1. `01_ZIMMAMLESS_V3_REQUIREMENTS.md` — full product definition
2. `02_DATABASE_SCHEMA.sql` — **frozen**, you implement it exactly
3. `03_API_CONTRACT.yaml` — **frozen**, you implement every endpoint
4. This brief

## 2. Frozen contracts

You may not change `02_DATABASE_SCHEMA.sql` or `03_API_CONTRACT.yaml` without product-owner approval. If you believe one is wrong, **stop and raise it** — do not work around it. Agent B is building against both simultaneously; a silent change breaks their work.

Additive migrations that don't alter existing columns, constraints, or response shapes are permitted. Anything else needs approval.

## 3. Repository layout

```
/apps/api                 NestJS
  /src/modules
    auth/                 Supabase JWT, org context guard
    organizations/        orgs, memberships, roles
    onboarding/           applications, SLA clock, consents
    government/           adapter orchestration, snapshots
    buyers/               resolution, relationships
    documents/            storage, signed URLs
    transactions/         invoices, declarations, states
    verification/         checks, fingerprints, duplicates
    risk/                 scoring, model versions
    marketplace/          listings, eligibility
    offers/               offers, conditions, approval
    selection/            atomic acceptance
    contracts/            templates, generation, signatures
    funding/              OTP, settlement orchestration
    fees/                 commission, listing fees, ledger
    payments/             buyer payments, overdue
    cases/                recourse, disputes, withdrawal, fraud
    notifications/        templating, delivery evidence
    audit/                logs, status history
    admin/                settings, tiers, models
    demo/                 time machine (env-guarded)
  /src/adapters
    government/{ccd,istd,gam,einvoice}/{dummy,production}
    settlement/{dummy,production}
    signature/{dummy,production}
    notification/{dummy,production}
    screening/{dummy,production}
  /src/jobs                maturity, deadlines, escalation, retries
/services/ml               Python FastAPI — OCR, QR, scoring
/db/migrations             SQL migrations
/db/seed                   demo data
```

## 4. Build order

**Phase 1 — Foundation (nothing else can start without this)**
- Supabase Auth integration; JWT validation
- `X-Organization-Id` context guard; multi-org membership; role checks
- RLS helper functions and policies from the schema
- Audit log interceptor writing on every mutation
- Error envelope, correlation IDs, structured logging
- Health endpoint + `/auth/me` so Agent B can unblock immediately

**Phase 2 — Onboarding and government**
- Applications, state machine, SLA clock with pause/resume
- Business calendar (Sun–Thu 08:00–17:00 Asia/Amman, holidays table)
- Government adapter interface + CCD/ISTD/GAM dummies
- Snapshot persistence, 90-day freshness, `sourceAvailable` flag
- Field provenance in `entity_field_values`
- Consents, information requests, decisions

**Phase 3 — Buyers and invoices**
- Buyer search (own → platform → registry), candidate return, no auto-select
- Global buyer dedup on national number; `SupplierBuyerRelationship`
- Document upload/download signed URLs
- OCR + QR extraction via Python service; raw output preserved separately
- Invoice CRUD, fingerprint generation, duplicate detection
- Declarations, verification runs

**Phase 4 — Risk**
- Deterministic rules engine
- Python ML training + inference; versioning; metrics; explainability
- Composite score + five components + `dataAvailabilityPct`
- Rules-only fallback with visible flag
- **Government unavailability must never reduce a score component**

**Phase 5 — Marketplace and offers**
- Listing activation + listing-fee obligation creation
- Bank policy filters; eligibility evaluation with recorded rules
- Offer create/revise/approve/withdraw
- Maker/approver separation enforced in DB and service
- Server-side net-payout recomputation
- **Confidentiality**: floor never leaked, competitor data never returned

**Phase 6 — Selection and contracts**
- Atomic acceptance (see §5)
- `AcceptedOfferSnapshot` with hash
- Contract template engine, per-`transactionType` templates
- Dummy signature provider; verification; `FULLY_SIGNED` transition

**Phase 7 — Funding**
- Mark-sent, OTP generation (hash-only), verification
- OTP: 15 min, 5 attempts, 3 resends, full event audit
- Settlement adapter, idempotency keys, retry with backoff
- **`FUNDED` requires OTP verified AND settlement evidence**
- Commission finalized only on `PAYOUT_COMPLETED`
- Double-entry ledger; balanced journals; compensating reversals only

**Phase 8 — Post-funding and cases**
- Maturity job; `OVERDUE_UNCONFIRMED` → bank confirm → resolve
- Buyer payment recording; partial payment; balance recalculation
- Recourse (bank-only initiation), disputes, withdrawal cases, fraud
- Notifications with full delivery evidence

**Phase 9 — Admin, demo, hardening**
- Settings, commission tiers, risk model versions, audit search
- Seed: 3 banks, 3 suppliers, 6 buyers, 12 invoices, all 11 scenarios
- Demo time machine, server-side env guard
- Test coverage on the invariants below

## 5. Atomic offer acceptance — the highest-risk code in the system

`POST /offers/{id}/accept` must run in ONE database transaction:

```
BEGIN;
  SELECT ... FROM receivable_transactions
    WHERE id = $txId AND locked_at IS NULL
    FOR UPDATE;                       -- row lock, fail fast if taken
  -- re-validate: offer ACTIVE, within validUntil
  -- re-validate: net_supplier_payout >= minimum_acceptable_amount
  -- re-validate: gross <= invoice.outstanding_amount
  UPDATE receivable_transactions SET locked_at = now(), locked_by_offer_id = $offerId, state = 'OFFER_ACCEPTED';
  UPDATE bank_offers SET status = 'SELECTED' WHERE id = $offerId;
  UPDATE bank_offers SET status = 'NOT_SELECTED' WHERE listing_id = $listingId AND id <> $offerId AND status = 'ACTIVE';
  INSERT INTO offer_selections ...;
  INSERT INTO accepted_offer_snapshots ...;
  INSERT INTO audit_logs ...;
COMMIT;
```

Test it under concurrent load. Two simultaneous accepts must produce exactly one winner and one clean 409.

## 6. Invariants — write a test for each

| # | Invariant |
|---|---|
| INV-1 | Acceptance is atomic; concurrent accepts yield one winner |
| INV-2 | `netSupplierPayout >= minimumAcceptableAmount` at accept time |
| INV-3 | `grossFundingAmount <= invoice.outstandingAmount` |
| INV-4 | A transaction locks exactly once; `locked_at` immutable |
| INV-5 | Commission finalized only when settlement is `PAYOUT_COMPLETED` |
| INV-6 | Every ledger journal balances: sum(DEBIT) = sum(CREDIT) |
| INV-7 | No hard delete on financial or audit tables |
| INV-8 | `minimumAcceptableAmount` absent from every bank-facing payload |
| INV-9 | `sourceAvailable=false` never reduces a risk component |
| INV-10 | `FUNDED` requires OTP verified AND settlement evidence |
| INV-11 | Bank A can never read Bank B's offer, via API or direct SQL under RLS |
| INV-12 | Self-approval of an offer is rejected |
| INV-13 | Retried settlement never pays twice |

## 7. Non-negotiables

- Money is `numeric(18,3)`, decimal arithmetic, never float, serialized as a 3-dp string
- Service-role key never leaves the server
- RLS tested independently — write a test that queries as a bank user directly and asserts it cannot see another bank's rows
- Every mutation writes an audit entry with actor user + actor org
- Adapters swap without touching domain logic

## 8. Interface with Agent B

- You publish the OpenAPI spec at `/docs-json`; it must match `03_API_CONTRACT.yaml`
- Deliver Phase 1 + a mock-data server early so Agent B is never blocked
- Any response-shape question: the contract file is the answer, not your implementation
- Post a daily note listing which endpoints moved from mock to real
