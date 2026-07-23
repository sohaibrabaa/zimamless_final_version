# Phase 6 Completion Report — Agent B

Scope: `docs/plan/phases/PHASE_6_SELECTION_CONTRACTS.md`, Agent B tasks. As
with Phase 5, no dedicated Phase 6 kickoff document existed — the phase's
own master plan file was used directly as the scope reference.

Branched from `origin/main` at `76d10bf` (the frozen Phase 3 unification
baseline; `b/phase5`'s work — building on `b6e6e18` — is carried forward via
this session continuing on the same worktree/branch history). Agent A had
not started Phase 6 at the start of this session.

## 1. Delivered vs. planned

All six screens the phase file names for B:

- **Acceptance confirmation modal + result**, on the offer comparison
  screen: spells out atomic-and-irreversible in plain language, shows the
  full breakdown one last time (the same figures already on the offer
  card — nothing recomputed), and a success screen reading the returned
  `AcceptedOfferSnapshot`.
- **Reject-all flow**, on the same screen: a second confirmation modal,
  explains the invoice returns to `ELIGIBLE`.
- **Post-acceptance transaction timeline** (`OFFER_ACCEPTED` →
  `CONDITIONS_PENDING` → `CONTRACTED`), on the supplier's transaction
  detail page.
- **Conditions checklist**: every condition on the accepted offer's frozen
  snapshot, per-condition status, a fulfil action with a notes field
  (`POST /conditions/{id}/fulfil`).
- **Contract review screen**: rendered terms from the snapshot, template
  version, the canonical-language note (EN governs — ZM-I18N-003b), on both
  the supplier's and the bank's own routes.
- **Click-to-accept signing**: an authorized signatory sees a sign button;
  anyone else sees status only — enforced client-side for UX and
  independently server-side (`FORBIDDEN` if attempted anyway). Per-party
  signature status; `FULLY_SIGNED` only once both sides have signed.
- **Bank result screens**: `SELECTED`/`NOT_SELECTED` on the existing
  Phase 5 offer-status page (`Offer` never carries competitor data at the
  type level, so "zero competitor info" was already structural — this
  session added the explanatory copy and a contract link for `SELECTED`).

### Domain/store layer built to support all of the above

- `lib/contracts/contract-domain.ts` — `preContractCheckFailures` (ZM-CON-006's
  four checks), `allMandatoryConditionsResolved`, `isFullySigned`
  (ZM-CON-010/012), and `contentHash` (a small deterministic non-cryptographic
  hash — `ZM-CON-005`/`ZM-SEL-007` ask for *a* content hash, not a specific
  algorithm, and `crypto.subtle.digest` is async where every other hash-like
  id in this codebase is synchronous).
- `lib/mocks/marketplace-store.ts` (extended) — `acceptOffer`: every
  observable invariant §12.1 lists, enforced in-memory (a mock cannot
  reproduce `SELECT … FOR UPDATE`, but the transaction's `lockedAt` check
  happens first and is checked against the *transaction*, so a second
  acceptance attempt on any offer on the same listing is impossible once
  the first lands); an idempotency-key cache so a replay returns the exact
  original result rather than re-executing; every other active/pending
  offer marked `NOT_SELECTED` in the same call; an immutable snapshot
  written before the function returns. `rejectAllOffers` returns the
  transaction to `ELIGIBLE`.
- `lib/mocks/contract-store.ts` (new) — `generateContract` (gated by the
  four ZM-CON-006 checks, idempotent — a second call returns the existing
  contract), a real per-`transactionType` template engine rendering EN + AR
  text from the frozen snapshot only, `signContract` (one signature per
  side, `FULLY_SIGNED` + transaction → `CONTRACTED` only once both sides
  have signed), `fulfilCondition`.

## 2. Endpoints / screens

| Endpoint | Screen(s) |
|---|---|
| `POST /offers/{id}/accept` | Acceptance modal + result |
| `POST /listings/{id}/reject-all` | Reject-all flow |
| `POST /transactions/{id}/contract` | Contract review screen (generate) |
| `GET /transactions/{id}/contract` | Contract review screens (both portals) |
| `POST /contracts/{id}/sign` | Click-to-accept signing (both portals) |
| `GET /transactions/{id}/conditions` | Conditions checklist |
| `POST /conditions/{id}/fulfil` | Conditions checklist (fulfil action) |

All seven stay `mock` — the API remains undeployed (six sessions on the
same carry-over).

## 3. Tests added

- `lib/contracts/contract-domain.spec.ts` (14) — every ZM-CON-006 check in
  isolation and combined, `isFullySigned`'s exact boundary (one signature
  per side is enough; neither side alone is), `contentHash` determinism.
- `lib/mocks/marketplace-store.ts`'s spec (+15, now 27 total) — locks the
  transaction and writes a snapshot; every other active/pending offer on
  the listing loses in the same call (including one still
  `PENDING_INTERNAL_APPROVAL`, never approved); a second acceptance attempt
  after a lock returns `ALREADY_LOCKED`; **an idempotency-key replay
  returns the exact original result** (asserted by deep equality, and that
  exactly one snapshot exists after the replay); refuses a non-`ACTIVE`
  offer; refuses an organization that does not own the listing;
  `rejectAllOffers` moves offers to `NOT_SELECTED` and the transaction back
  to `ELIGIBLE`, refusing a non-owning organization.
- `lib/mocks/contract-store.spec.ts` (11, new) — generation refused before
  acceptance and while a mandatory condition is unresolved, succeeds once
  fulfilled, is idempotent; **signing only reaches `FULLY_SIGNED` (and only
  then moves the transaction to `CONTRACTED`) once both a supplier and a
  bank signature exist** — this test caught a real bug (see §4); a second
  signature from the same side is refused; `accepted: false` records
  nothing.

Total: 25 new (187 web tests, up from 154; 254 API tests unchanged).

## 4. A real defect found by testing rather than by reading

`signContract` set `contract.status = "FULLY_SIGNED"` on the second
signature but never called `setTransactionState(..., "CONTRACTED")` — the
transaction stayed `OFFER_ACCEPTED` forever, silently. The
`FULLY_SIGNED`-triggers-`CONTRACTED` test failed immediately
(`expected 'OFFER_ACCEPTED' to be 'CONTRACTED'`), and the fix was one line.
Notable only because it is exactly the kind of defect that "looks right"
in a code read — the contract status update was correct and easy to eyeball
as done; the transaction-state side effect one branch later was the part
that was actually missing.

## 5. Deviations and design decisions

1. **No listing kickoff document existed**, same situation as Phase 5 —
   the master plan file was the scope reference.
2. **Acceptance atomicity is enforced in-memory, not via a real database
   transaction.** The mock cannot reproduce `SELECT … FOR UPDATE`; instead
   the lock check happens first, against the transaction's `lockedAt`
   field, before any other work — the *observable* guarantee (a second
   acceptance is impossible, no partial state is visible) holds even
   though the underlying mechanism is single-threaded JS rather than a
   real row lock. Documented plainly in `acceptOffer`'s own comment rather
   than left to look more authoritative than it is.
3. **Idempotency is a client-generated key stored in a `useRef`, reused
   across retries of the same acceptance attempt** (`useOfferAcceptance` in
   `lib/contracts/useAcceptance.ts`), regenerated only when the confirmation
   modal is reopened for a different offer or after a successful accept.
4. **Reject-all sets the listing to `CANCELLED`, not a dedicated
   "rejected" status** — the `ListingStatus` enum the contract declares has
   no such value; `CANCELLED` is the closest fit for "this round is over,
   no one was selected."
5. **The demo commission/contract templates are plain text, not a real
   document-rendering pipeline.** `renderContractBody` produces structured
   plain text with the merge fields the requirement names (parties,
   transaction type, recourse, money components) — real templating,
   contract-per-transaction-type with a fallback, EN + AR — but not styled
   or exported to any file format. Nothing about the demo depends on the
   output being anything but readable text.
6. **The bank cannot generate a contract from its own screen** — generation
   depends on the supplier-side transaction's own state (bank account
   verification, declaration reconfirmation), so a bank arriving at
   `/bank/offers/{id}/contract` before the supplier has generated one sees
   "not yet generated" with no generate button, rather than a control that
   would suggest the bank controls that step.
7. **No waive action** exists on the conditions checklist. `ZM-CON-006`
   names "fulfilled or explicitly waived with a record" as both acceptable,
   but the contract declares only a `fulfil` endpoint, no `waive` one.
   Not filed as a gap (see Q-15's scope, which covers what *was* filed) —
   plausibly a platform/bank-side decision rather than a supplier
   self-service action, so its absence from this one screen may be
   intentional rather than an oversight.

## 6. Open questions raised

**Q-15** (filed this session) — `AcceptedOfferSnapshot` is missing half its
money components (`bankDiscountAmount`/`bankFeesAmount`/
`otherDeductionsAmount`) against ZM-SEL-007's "every money component," and
`conditionsSnapshot` is typed `Record<string, never>[]` — an array of
objects with no declared properties at all. Not blocking: the mock's
internal record carries the full breakdown and real conditions; the client
widens the generated type to read them (same pattern as Q-14), and also
uses the same mechanism to carry the rendered contract text
(`bodyEn`/`bodyAr`) and which side each signature belongs to
(`organizationType`) past the declared `Contract` shape. Full reasoning in
`docs/coordination/OPEN_QUESTIONS.md`.

## 7. Risks observed

1. **The acceptance/contract/signing pipeline has never run against
   concurrent requests** — by construction, since it is single-threaded
   mock JS. The phase file's concurrency test harness (20 iterations of
   parallel accepts) is explicitly Agent A's task against a real database;
   nothing here demonstrates or protects against that class of bug.
2. **`AcceptedOfferSnapshotRecord` and `ContractRecord` are plain in-memory
   arrays with no persistence** — a page reload during development loses
   all accepted offers and contracts (same limitation every mock store in
   this codebase has, but worth restating here since Phase 6 is the
   highest-risk code in the system per the phase file's own framing).
3. **The demo commission rate and contract templates are Phase 5/6
   stand-ins** (see also the Phase 5 report's risk #3) — nothing about
   their specific values should survive contact with Agent A's real
   commission tiers or a real template-management system.

## 8. Handoff notes for Agent A

1. **Nothing blocking.** `lib/mocks/marketplace-store.ts`'s `acceptOffer`
   and `lib/mocks/contract-store.ts` are stand-ins only. The properties
   worth preserving exactly: idempotency-key replay must return the
   original result, not re-execute; every other active/pending offer on
   the listing must flip to `NOT_SELECTED` in the same operation that
   selects the winner; `FULLY_SIGNED` (and the transaction's move to
   `CONTRACTED`) must require both a supplier and a bank signature, never
   one alone.
2. **Q-15**: `AcceptedOfferSnapshot`/`Contract` need the full money
   breakdown, a real conditions shape, and — if a rendered document isn't
   served via a signed-URL pattern like Phase 3's documents — something
   for the client to read the contract text from.
3. **Reject-all's listing status** (`CANCELLED`, deviation 4 above) is a
   guess at the closest fit in the declared `ListingStatus` enum — confirm
   whether your real engine uses the same value or a dedicated one.
4. **AS-01's acceptance role gate** is enforced in the mock against
   `SUPPLIER_OWNER` specifically (the only seeded role matching
   "Owner/Admin" — there is no seeded `SUPPLIER_ADMIN`). If your real
   role set differs, the mock's `hasAcceptanceRole` in `handlers.ts` is the
   one place to reconcile.

## 9. Checkpoint countersignature

Not run. The joint Phase 6 integration checkpoint (accept the *lower* of
two offers, the concurrency harness, both signatories signing) requires a
deployed API, unchanged since Phase 1.

## 10. Next session's first task

Per the established per-phase pattern, the next session begins with
whatever kickoff document (or, absent one as in Phases 5 and 6, master
plan file) covers Phase 7 — Funding, Cross-Party OTP, and Settlement.
