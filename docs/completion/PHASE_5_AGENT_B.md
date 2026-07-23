# Phase 5 Completion Report — Agent B

Scope: `docs/plan/phases/PHASE_5_MARKETPLACE_OFFERS.md`, Agent B tasks. No
dedicated Phase 5 kickoff document existed for B at the start of this session
(only the Phase 4 kickoff's addenda, already executed) — the phase's own
master plan file was used as the scope reference, per its "Agent B tasks"
and "Screens in scope (B)" sections.

Branched from `origin/main` at `b6e6e18` (the Phase 4 head-start commit).
Agent A had not started Phase 5 at the start of this session (no daily-log
entry for a session 6, no backend listing/offer service).

## 1. Delivered vs. planned

All nine screens the phase file names for B, plus the domain/store layer
they sit on:

- **Supplier listing-activation screen** (`ListingActivationPanel`, on the
  invoice detail page): fee shown with amount and the "applies whether or
  not financing succeeds" warning, **before** confirmation, in a modal —
  the supplier cannot activate without seeing it. Deadlines render only
  after activation, computed from the ZM-MKT-007 defaults (24h offer
  window, 12h selection window) — never supplier-chosen (ZM-MKT-008).
- **Bank marketplace feed** (`/bank/marketplace`, reused from the Phase 4
  head start): now backed by **real per-bank policy-filter evaluation**
  (ZM-MKT-002) instead of a static two-listing stub.
- **Bank underwriting view** (`/bank/marketplace/[id]`, reused and
  extended): supplier/buyer identity, invoice data, documents, the Phase 4
  risk components, the ZM-CON-018 double-financing disclosure notice — plus
  this session's addition, a `myOffer`-aware action area (create vs. "your
  offer is ...").
- **Offer creation form** (`/bank/marketplace/[id]/offer`): wired to the
  real create endpoint. Gross + bank deductions inputs; a **live client
  preview** of commission/listing fee/net (computed by the same pure
  function the mock "server" uses, so the preview can never disagree with
  what gets persisted); conditions builder; below-floor 422 rendered
  generically, revealing no number.
- **Approval queue** (`/bank/offers`, "Approval queue" tab): creator shown;
  the approve action is **hidden**, not merely disabled, for the offer's
  own creator; approve action wired to the real endpoint, which
  independently rejects self-approval.
- **"My offers"** (`/bank/offers`, "My offers" tab): status + version,
  withdraw action.
- **Policy-filter configuration** (`/bank/settings/policy-filters`):
  create, and activate/deactivate (the v3.1.0 `PATCH` — D-12). Every
  ZM-MKT-001 filter row is a configurable field; two of the ten (sector,
  and the two per-offer-type filters) are configurable but not yet
  evaluated against a listing — see §4.
- **Supplier offer comparison** (`/supplier/invoices/[id]/offers`): full
  per-offer breakdown with net payout as the visual anchor; transaction
  type + recourse type with plain-language explanations on every card;
  conditions with mandatory flags; a live countdown to the selection
  deadline; **no default sort by amount, no "best"/"recommended" marking
  anywhere** — offers render in submission order, and nothing computes a
  ranking.
- **Bank offer-status view** (`/bank/offers/[id]`): a bank's own offer in
  isolation. `Offer` never carries another bank's data at the type level,
  so there is structurally nothing here that could leak a competitor.

### Domain/store layer built to support all of the above

- `lib/marketplace/offer-money.ts` — the §11.2 formula
  (`computeNetSupplierPayout`), a demo commission calculator
  (`computeCommission`, flat 1.5% of gross — a stand-in, documented as
  such, for a real `CommissionTier` lookup that doesn't exist yet), and
  `isBelowFloor`. One implementation, used identically by the client
  preview and the mock's authoritative computation.
- `lib/marketplace/listing-domain.ts` — the ZM-MKT-007 deadline defaults.
- `lib/marketplace/policy-filters.ts` — `evaluateEligibility`, returning
  both the outcome and the specific rules applied (ZM-MKT-003).
- `lib/mocks/marketplace-store.ts` — rewritten from the Phase 4 head
  start's static two-listing stub into a real store: `activateListing`
  requires a genuinely `ELIGIBLE` transaction and evaluates every active
  bank's policy filter; `createOffer`/`reviseOffer`/`withdrawOffer`/
  `approveOffer` implement the offer lifecycle including the floor check
  and self-approval rejection; `listOffersForListing`/`listOffersForBank`
  are the confidentiality allow-list boundary.
- `lib/mocks/policy-filter-store.ts` — per-bank filter CRUD, seeded with
  one real filter each for JNB and LCB so the checkpoint scenario doesn't
  first require a trip through the config screen.

## 2. Endpoints / screens

| Endpoint | Screen(s) |
|---|---|
| `POST /transactions/{id}/listing` | Listing activation |
| `GET /transactions/{id}/listing-current` | Listing activation, offer comparison |
| `GET /listings/{id}` | (supplier `Listing` shape) |
| `GET /listings/{id}/offers` | Offer comparison (supplier), own-offer check (bank) |
| `GET /marketplace/eligible` | Bank marketplace feed |
| `GET /marketplace/listings/{id}` | Bank underwriting view |
| `GET/POST /banks/policy-filters` | Policy-filter configuration |
| `PATCH /banks/policy-filters/{id}` | Policy-filter configuration (activate/deactivate) |
| `POST /listings/{id}/offers/create` | Offer creation form |
| `GET /offers` (status filter) | My offers, approval queue |
| `GET /offers/{id}` | Bank offer-status view |
| `PATCH /offers/{id}` | Offer revision (wired in the store/hook; no dedicated revise screen this session — see §4) |
| `POST /offers/{id}/approve` | Approval queue |
| `POST /offers/{id}/withdraw` | My offers |

All fourteen stay `mock` — the API is still not deployed to a public URL
(five sessions running on the same carry-over).

## 3. Tests added

- `lib/marketplace/offer-money.spec.ts` (9) — the §11.2 formula exactly,
  3-decimal precision, commission as a pure function of gross only,
  `isBelowFloor` boundary.
- `lib/marketplace/policy-filters.spec.ts` (10) — every ZM-MKT-001 rule
  evaluated in isolation, the "no active filter → ineligible" default, and
  that `rulesApplied` is populated (ZM-MKT-003).
- `lib/mocks/marketplace-store.spec.ts` (19) — activation requires
  `ELIGIBLE`; eligibility persisted per bank; **the below-floor rejection's
  return value carries only `{ok, error}` — asserted by key set, proving
  no number can leak through this path**; self-approval rejected server-side
  even though the UI also blocks it; withdraw/revise lifecycle including
  immutable prior versions; three confidentiality tests (a bank sees only
  its own offer on a listing; the supplier sees ACTIVE offers only, never
  PENDING; `listOffersForBank` never crosses banks).

Total: 38 new (154 web tests, up from 116; 254 API tests unchanged).

## 4. Deviations and design decisions

1. **No listing kickoff document existed** — the phase's master plan file
   (`phases/PHASE_5_MARKETPLACE_OFFERS.md`) was used directly as the scope
   reference, since the "Agent B tasks" and "Screens in scope" sections are
   unambiguous and match the pattern every prior phase's kickoff document
   restated from the same source.
2. **Listings are no longer a static fixture.** The Phase 4 head start's
   two hand-authored listings (including the one invented invoice identity
   flagged in that session's handoff) are gone. A listing now only exists
   because a real Phase 3 transaction reached `ELIGIBLE` and a supplier
   activated it — this removes the last invented-identity defect in this
   half's mock data, at the cost of the marketplace being empty until a
   Phase 3 invoice is actually run through to `ELIGIBLE` first (the
   existing `seedDuplicateCounterpart`-style shortcut in
   `transaction-store.ts` gets a supplier to `ELIGIBLE` in one call for
   demo purposes).
3. **Demo commission rate.** `computeCommission` is a flat 1.5% of gross,
   clearly marked as a stand-in in its own comment (ZM-FEE-011 names a
   `CommissionTier` that doesn't exist as a real admin-configurable
   resource yet — that's Phase 9 scope). Nothing about the client depends
   on the specific rate; only the formula shape (a function of gross alone)
   matters and is what's tested.
4. **Two of ZM-MKT-001's ten filter rows are configurable but not
   evaluated.** `sectorsInclude`/`sectorsExclude` has no counterpart
   anywhere in the frozen contract or `GOV_DUMMY_DATA.md` (no sector field
   exists on `Buyer` or the supplier profile), and the two per-offer-type
   filters (`acceptedTransactionTypes`, `acceptedRecourseTypes`) have
   nothing to compare against at listing time — `transactionType` is chosen
   per *offer* (ZM-OFR-010), not known when a listing is evaluated for
   eligibility. Both stay in the `PolicyFilterRecord` shape and the
   configuration screen (the requirement lists them as bank-configurable)
   but contribute no PASS/FAIL rule. Documented in
   `lib/marketplace/policy-filters.ts`'s module comment.
5. **No dedicated offer-revision screen.** `reviseOffer`/`PATCH /offers/{id}`
   is implemented end to end in the store and exposed via
   `lib/marketplace/useOffers.ts`'s `reviseOfferById`, and is covered by a
   store test — but no UI screen calls it this session (a maker who wants
   to change an offer withdraws and creates a new one instead, which the
   "my offers" screen supports). The phase file's screen list does not name
   a separate "revise" screen, so this was judged in-scope-for-the-store,
   not in-scope-for-a-screen.
6. **`ACTIVE_BANK_ORGS` is a fixed pair (JNB, LCB), not a real "active
   bank" registry.** ZM-MKT-005 says "evaluate eligibility for every active
   bank" — there is no admin screen anywhere in this codebase to mark a
   bank active/inactive, so both seeded banks are treated as always active.
   Noted as a limitation, not a filed question, since it is symmetric with
   how Phase 4's risk engine already stands in for a real admin-configured
   resource.
7. **The offer approval queue and "my offers" share one fetch
   (`useBankOffers`, filtered by status)** rather than two independent
   hooks, on the reasoning that the same list with two views is less likely
   to disagree after an approve/withdraw action than two separately-fetched
   views of the same underlying data.

## 5. Open questions raised

**Q-14** — `Offer` has no field naming the maker who created it, though the
phase file requires the approval queue to show "creator" and block
self-approval in the UI as well as the server. Not blocking: the mock
carries `createdByUserId`/`createdByUserName` past the typed response on
the two bank-scoped endpoints that need them (`GET /offers`,
`GET /offers/{id}`), and the interim behaviour is documented as already
matching the recommended resolution. Full reasoning in
`docs/coordination/OPEN_QUESTIONS.md`.

## 6. Risks observed

1. **The marketplace is empty until a real Phase 3 invoice reaches
   `ELIGIBLE`.** This is correct behaviour (no invented listings), but it
   means a fresh demo environment shows nothing on `/bank/marketplace`
   until someone runs a supplier through onboarding → invoice submission →
   `ELIGIBLE` → listing activation. Worth a seed helper (mirroring
   `seedDuplicateCounterpart`) if a checkpoint demo needs to start from a
   populated feed rather than an empty one.
2. **The demo engine's fixed risk baselines** (noted in the Phase 4 report)
   still mean no listing can carry a `CRITICAL` band — a policy filter's
   `maxRiskBand: CRITICAL` is therefore untestable against real mock data
   today; the unit test covers it directly against synthetic facts instead.
3. **`ACTIVE_BANK_ORGS`** (deviation 6 above) will need to become a real
   query once bank activation is a modeled concept — currently a two-entry
   constant in `marketplace-store.ts`.

## 7. Handoff notes for Agent A

1. **Nothing blocking.** `lib/mocks/marketplace-store.ts` is a stand-in for
   your real listing/offer service — none of its internals need to survive
   contact with yours. The properties worth preserving: the floor
   rejection carries zero numeric detail (ZM-MKT-012's design note); a
   bank's `BankListingView` never contains `minimumAcceptableAmount` or
   `offerCount`; self-approval is rejected independently of any UI guard.
2. **Q-14**: an `Offer` response consumed by its own bank needs to name who
   created it, for the approval queue and the UI-side self-approval guard.
   See `docs/coordination/OPEN_QUESTIONS.md`.
3. **Commission formula**: the demo uses a flat 1.5% of `grossFundingAmount`
   with no tier lookup. Your real `CommissionTier` mechanism (ZM-FEE-011)
   can differ freely — nothing on the client asserts the demo rate is
   correct, only that commission is a pure function of gross.
4. **Listing fee**: a fixed `150.000` (`LISTING_FEE_AMOUNT` in
   `lib/marketplace/offer-money.ts`), shown to the supplier before
   activation and carried into every offer's `unpaidListingFeeAmount` as
   permanently unpaid — there is no payment/settlement flow in this phase.
5. **Policy filters**: `ZM-MKT-001`'s sector row and the two per-offer-type
   rows are configurable in the UI but contribute no eligibility rule (see
   §4 item 4) — worth confirming whether your eligibility engine intends to
   evaluate `transactionType`/`recourseType` filters against a *listing* at
   all, given they are chosen per offer, not per listing.

## 8. Checkpoint countersignature

Not run. The joint Phase 5 integration checkpoint (listing activation → two
banks' offers, one self-approval rejected → supplier sees both fully → a
below-floor offer sentinel-scanned) requires a deployed API, unchanged since
Phase 1.

## 9. Next session's first task

Per the phase file, the remaining B-relevant work once A's real backend
exists is wiring these same screens to the live endpoints and running the
integration checkpoint — no new screens are named beyond what this session
delivered. The natural next phase (Phase 6: acceptance, contracting) begins
with its own kickoff, per the established per-phase pattern.
