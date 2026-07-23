# Phase 6 Completion Report — Agent A

**Phase:** 6 — Selection + Contracts
**Agent:** A (backend)
**Sessions spent:** 1 (planned range: 4–6 days)
**Dates:** 2026-07-23
**Phase file:** `docs/plan/phases/PHASE_6_SELECTION_CONTRACTS.md`
**Branch:** `a/phase5` (continued; Phase 6 commits sit on top of `25fc693`)

This phase contains **the highest-risk code in the system** — the brief says
so in its own section heading, and it is right. Everything else in Zimmamless
can be retried. Offer acceptance cannot: it is the moment a supplier is bound
to a bank, and a bug here does not produce a wrong number on a screen, it
produces two banks each believing they financed the same receivable.

---

## 1. Delivered vs. planned

| Planned item | Status | Notes |
|---|---|---|
| `POST /offers/{id}/accept` in one transaction, exactly per brief §5 | ✅ done | `acceptance.service.ts`. `SELECT … FOR UPDATE`, re-validation, lock, select, deselect, `offer_selections`, `accepted_offer_snapshots` with content hash, audit — all in one `db.transaction`. §4.1. |
| `locked_at` immutability trigger (INV-4) | ✅ done | Migration `0008`. Refuses re-locking **and** unlocking, and pins `locked_by_offer_id` to the same rule. §4.2. |
| Idempotency-key replay returns the original 200, never re-executes | ✅ done | Implemented from the natural unique key rather than a key store — §4.3, a deliberate design choice with its reasoning. |
| Acceptance role policy: Supplier Owner/Admin by default (AS-01, configurable) | ✅ done | `platform_settings.offer_acceptance_roles`, read at each accept. The route guard admits `SUPPLIER_UPLOADER` so widening the setting is a settings change and nothing else. `db:verify` asserts the key exists. |
| `POST /listings/{id}/reject-all` → offers rejected, transaction back to `ELIGIBLE` | ✅ done | Takes the same row lock, so accept-vs-reject-all cannot both win. |
| Notifications: selected + not-selected, no competitive info in either | ✅ done | Tested by asserting the *absence* of the winning amount, the winner's name, and any count — §3. |
| Concurrency harness in CI (Test Strategy 5.2) | ✅ done | Parallel accepts (8 rounds, configurable), accept-vs-reject-all, accept-vs-withdraw. §4.1, §3. |
| Contract template engine: versioned, per `transactionType` + fallback, EN + AR, structured merge fields | ✅ done | `template-engine.ts` + four seeded templates in migration `0008`. No conditionals, no loops — §4.4. |
| Pre-contract checks (ZM-CON-006) | ✅ done | `pre-contract-checks.ts`, pure, returns **all** findings rather than the first — §4.5. |
| `POST/GET /transactions/{id}/contract` with `ContractTermSnapshot` + hash, document stored per PA-09 | ✅ done | HTML document in the private bucket, SHA-256 over the bytes, terms frozen with their own separate hash. |
| Dummy `SignatureProvider`: click-to-accept, full evidence, signatory authorization check, `SignatureVerification`, `FULLY_SIGNED` → `CONTRACTED` | ✅ done | `signature.provider.ts`. Sign and verify are **separate operations** — §4.6. |
| Conditions: `GET /transactions/{id}/conditions`, `POST /conditions/{id}/fulfil`, `CONDITIONS_PENDING` handling | ✅ done | The state is **derived** from the conditions in both directions — §4.7. |
| Snapshot immutability test | ✅ done | Alters the source offer by direct SQL and asserts the snapshot is byte-identical. |

**Not in my half:** the acceptance modal, conditions checklist, contract
review and signing screens, and the bank result screens are Agent B's.

---

## 2. Endpoints

| Endpoint | Status | Verified how |
|---|---|---|
| `POST /offers/{id}/accept` | **built-not-deployed** | Live: accepts the lower offer, locks, deselects, snapshots, replays, refuses a second acceptance — and the concurrency harness. |
| `POST /listings/{id}/reject-all` | **built-not-deployed** | Live, including the accept-vs-reject-all race. |
| `POST /transactions/{id}/contract` | **built-not-deployed** | Live: generation, the ZM-CON-006 refusal with findings, the second-generation 409. |
| `GET /transactions/{id}/contract` | **built-not-deployed** | Live: both parties see it, a third bank gets 404. |
| `POST /contracts/{id}/sign` | **built-not-deployed** | Live: non-signatory refused, `accepted:false` refused, VERIFIED not merely SIGNED, `FULLY_SIGNED` → `CONTRACTED`, idempotent replay. |
| `GET /transactions/{id}/conditions` | **built-not-deployed** | Live, both parties. |
| `POST /conditions/{id}/fulfil` | **built-not-deployed** | Live: supplier fulfils, bank waives, supplier-waiver refused, blank reason refused. |

`built-not-deployed` for the same reason as Phases 1–5: still no hosting
account, and per the product owner this is a deliberate deferral.

---

## 3. Tests added

| Test / suite | Covers | Status |
|---|---|---|
| `content-hash.spec.ts` | Canonicalization: key-order insensitivity, array order preserved, `undefined` vs `null`, **numbers rejected**, string escaping | ✅ |
| `pre-contract-checks.spec.ts` | Every ZM-CON-006 condition; INV-3 re-checked at contract time; waiver-with-record vs waiver-without; **all findings at once** | ✅ |
| `template-engine.spec.ts` | Merge resolution; **unresolved field throws rather than blanks**; HTML escaping of party and condition text; no control flow | ✅ |
| `signature.provider.spec.ts` | ZM-CON-008 evidence completeness; ZM-CON-011's three checks each failing independently; the ZM-CON-009 seam | ✅ |
| `transaction-state.spec.ts` (+6) | The Phase 6 transitions, and that acceptance cannot be walked back | ✅ |
| `phase6-selection.integration.spec.ts` | The phase file's checkpoint, live | ✅ live |
| ↳ `INV-1 — concurrent acceptance produces exactly one winner` | **The point of the phase.** §4.1 | ✅ |
| ↳ `INV-4 — the lock is immutable in the database` (4 tests) | The trigger, including that it does **not** freeze the whole row | ✅ |
| ↳ `snapshot immutability (ZM-SEL-008)` | Byte-identical after the source offer is altered underneath it | ✅ |
| ↳ `accepts the LOWER of the two offers (ZM-SEL-005/006)` | No best-offer logic anywhere | ✅ |
| ↳ `tells the losing bank nothing but that it was not selected` | Asserts on **absence** | ✅ |

Totals after this phase: **387 API unit** (was 328) · **6 live integration
suites** (Phase 6 adds 33 checks) · 122 ML (unchanged).

---

## 4. Decisions worth the reader's time

### 4.1 The row lock is the design, and the harness is the proof

The tempting implementation checks `locked_at IS NULL` and then updates.
Between those two statements a second request does the same, and both commit.
`SELECT … FOR UPDATE` is not an optimization: it is the only thing that makes
the check and the write one indivisible act.

The shape of the guard matters too. The predicate is `WHERE id = $1`, with
the lock check *after* the row is held — not `WHERE id = $1 AND locked_at IS
NULL`, which returns zero rows for an already-locked transaction and leaves
the service unable to distinguish "already accepted" from "no such
transaction". Those need different answers.

None of that is provable by a single-threaded test. Every other test in this
phase would pass against the broken version. So the harness fires two accepts
on **different offers of the same transaction** without awaiting either,
repeatedly, and then asserts on the *database* rather than only on the HTTP
statuses — because a partial write could still have landed while both
responses looked plausible:

  - exactly one 200 and one 409, and the 409 carries `TRANSACTION_ALREADY_LOCKED`
  - exactly one `SELECTED` offer and one `NOT_SELECTED`
  - exactly one `offer_selections` row and one snapshot
  - and `locked_by_offer_id` points at the offer that actually won

Two more races are covered because they fail differently: accept-vs-reject-all
(both take the same lock; the assertion is that the end state is internally
consistent either way — locked with a snapshot, or `ELIGIBLE` with none,
never both and never neither) and accept-vs-withdraw (the offer ends
`SELECTED` or `WITHDRAWN`, and a snapshot exists only in the first case).

### 4.2 The INV-4 trigger refuses *unlocking*, not just re-locking

The obvious half is stopping a second lock. The half that matters more is
stopping `locked_at` from going back to NULL — because "unlock and re-accept"
is precisely the operation someone will reach for the first time a deal needs
unwinding, and it must not exist. Acceptance is irreversible by design; an
unwind is a withdrawal *case* (Phase 8) that leaves the original record
standing.

`locked_by_offer_id` is bound to the same rule. A lock pointing at a
different offer than the one that took it is the same defect wearing a
different column.

The trigger deliberately does **not** freeze the whole row — Phase 7 has to
advance the state of a locked transaction — and there is a test asserting
exactly that, because a guard that over-reaches gets disabled rather than
fixed.

### 4.3 Idempotency without an idempotency table

The contract declares an `Idempotency-Key` header on `/accept`. The frozen
schema has no key-store table (only `settlements.idempotency_key`, which is
Phase 7's and is a different thing).

Rather than add one, the service derives the replay answer from the natural
unique keys that already exist: `offer_selections` is `UNIQUE (offer_id)` and
`UNIQUE (listing_id)`. A replayed accept of the same offer by the same
supplier returns the original snapshot with 200 and executes nothing; an
accept of a *different* offer on a locked transaction is a 409.

This is stronger than key matching, not a substitute for it. It holds when
the client loses the key, retries from a different process, or never sent one
— and it cannot drift out of sync with the thing it protects, because it *is*
the thing it protects. `/accept` also has no request body, so the "same key,
different body" case that key stores exist to catch does not arise.

The replay is checked twice: once before the transaction (a retry should not
have to contend for a row lock to be told "yes, that already happened") and
once after acquiring the lock, in case the winner committed in between.

### 4.4 A template engine with no control flow

`{{dotted.names}}` and nothing else. No conditionals, no loops, no
expressions, no partials.

A contract is a legal document whose text is agreed in advance. A template
that can branch is a template nobody has fully read. Everything variable about
a Zimmamless contract is a *value*; the one repeating structure — the
conditions — is pre-rendered into a single field by a function in the same
module, so the template still says exactly what it says.

Two rules make it safe for a document someone signs:

  - **An unresolved field is an error, never an empty string.** A contract
    reading "the Supplier,  , hereby assigns" is worse than a failed
    generation, because it looks finished. `render` throws and names every
    missing field at once.
  - **Values are HTML-escaped**, with a one-item allow-list for the
    pre-rendered conditions block. A company legal name containing `&` must
    not alter the document's structure, and a bank-supplied condition title
    must not inject markup into a document the supplier is about to sign.

### 4.5 The pre-contract checks return a list

`preContractFindings` is pure and returns **every** outstanding item, not the
first. A supplier who fixes one thing and is then told about the next is
being drip-fed; one response naming everything is the difference between a
checklist and a guessing game.

Two of the checks are worth naming individually:

  - **A waiver counts only with a recorded reason.** ZM-CON-006 says
    "explicitly waived with a record", and a `WAIVED` row with a null or
    whitespace reason is the exact shape of someone clicking through a
    blocker. It is treated as outstanding.
  - **INV-3 is re-checked here, not trusted from acceptance.** A buyer
    part-payment between acceptance and contracting legitimately reduces
    `outstanding_amount`, and contracting to advance more than the receivable
    can repay is what INV-3 exists to prevent.

What is deliberately *not* checked: whether the listing fee has been paid.
ZM-FEE-002 makes it payable at activation regardless of outcome, and refusing
to contract over an unpaid fee would hold a financing deal hostage to a
25 JOD invoice.

### 4.6 Signing and verifying are two operations

ZM-CON-011 says a signature counts only after verification confirms document
integrity, signer identity and signer authority. Folding verification into
signing would make that requirement structurally unexpressible.

So `sign` records the act, `verify` runs the three checks, and only a
`VERIFIED` row counts toward `FULLY_SIGNED`. With the dummy provider the two
are milliseconds apart; with a real provider verification is asynchronous,
often a callback, and the state machine already has a place to put "signed
but not yet verified". A failed verification is recorded as `FAILED` rather
than discarded — the attempt happened, and the evidence of why it failed is
the point.

Three further details:

  - **The document is re-hashed from storage at signing time**, not read from
    the stored hash column. The entire value of a signature is that it binds
    a person to bytes; reading the bytes is the only way to know what those
    are. If they cannot be read, the service refuses rather than falling back.
  - **Signatory authority is re-checked against the live membership**, so a
    signatory whose authorization was revoked between generation and signing
    cannot sign.
  - **The dummy provider does not fake cryptography.** There is no key, so
    there is no signature — only a recorded act of assent bound to a document
    hash, and the stored evidence blob says so in its own text. Producing a
    plausible-looking token would invite someone to treat it as evidence of
    something it never was.

### 4.7 `CONDITIONS_PENDING` is derived, not set

A transaction is in `CONDITIONS_PENDING` exactly when a mandatory condition
on the accepted offer is unresolved — computed from the conditions on
acceptance and recomputed on every fulfilment or waiver, in both directions.

A workflow flag someone remembers to flip would drift the first time a
condition was resolved by an unexpected path, and then the state would
disagree with the checklist the supplier is looking at. Derived state cannot
do that.

It moves only between `OFFER_ACCEPTED` and `CONDITIONS_PENDING`. A
transaction that has reached `CONTRACTED` is never dragged backwards by a
late condition update — which is a real possibility, since a bank may record
a waiver after the fact for its own records.

### 4.8 Who may waive, and who may fulfil

Fulfilment is evidence the supplier produces, so the supplier records it. A
waiver is the bank giving up its own requirement, so **only the bank may
waive**. A supplier able to waive could contract past every requirement the
bank attached, which would make conditions decorative.

Evidence documents are checked to belong to the transaction. Without that, a
caller could attach any document id they happen to know and have it presented
as evidence on a contract precondition.

---

## 5. Problems found and fixed

### 5.1 A duplicate-organization bug in my own Phase 1 seed

While making the Phase 6 fixtures deterministic I found the hosted database
holds **three copies of each bank organization**.

`db/tools/seed.mjs` inserts organizations with `ON CONFLICT DO NOTHING` and
falls back to a lookup when no row is returned. But `uq_org_national_no` is a
**partial** index covering suppliers only — banks and the platform org have no
unique constraint to conflict with, so the insert never conflicted, always
returned a row, and the fallback lookup was never reached for exactly the org
types that needed it. Every re-run of the seed added another copy.

Fixed by looking before inserting. The duplicates already in the database are
**not** cleaned up by this change and are recorded as follow-up work in the
daily log — they carry memberships, and remapping those is a data migration
rather than a seed fix.

The immediate consequence for tests: `me.body.memberships[0]` is
ordering-dependent and can name a duplicate org. The Phase 6 suite now
selects the membership matching the canonical seeded id explicitly, and says
why in a comment.

### 5.2 Three schema assumptions I wrote before reading

All three were caught by the live suite rather than by review, which is the
argument for the suite:

  - **`invoices` has no `status` column.** Cancellation lives on the
    transaction's state — the same place the fingerprint trigger reads it
    from. I was asking the wrong row.
  - **`invoice_declarations` is one row of booleans per transaction**, not a
    row per declaration key. "Reconfirmed" therefore means the row exists and
    all eight booleans are true; a missing row is **not** treated as
    affirmed, because an absent declaration is the strongest possible reason
    to refuse rather than a default to fall through.
  - **`supplier_bank_accounts` stores `iban_enc bytea`** under
    `pgp_sym_encrypt`, not a plaintext `iban`. The fixture now encrypts with
    the runtime key — the same trap `db/seed/0300` documents for the buyer
    contact column.

### 5.3 Supabase Storage matches the Content-Type header literally

Contract documents are HTML (PA-09). The `documents` bucket's mime allow-list
did not include `text/html`, so I widened it — and kept the *user upload*
allow-list unchanged, deliberately: a supplier-uploaded HTML file would be
stored in a bucket whose download URLs are handed to other organizations'
browsers, which is a scripting vector with no legitimate use in this product.
The server may write HTML there; a request may not. `ensureBucket` now also
reconciles an existing bucket's list, because a bucket created in Phase 1 was
never going to grow a new type on its own.

That still failed. Supabase compares the whole `Content-Type` header against
the allow-list as a **string**, so `text/html; charset=utf-8` is rejected
with `invalid_mime_type` even though `text/html` is permitted. Confirmed by
probing the storage API directly rather than guessing. The upload now sends
the bare type.

### 5.4 I made the signature requirement stricter than the requirement

My first implementation created a signature slot for every authorized
signatory of both parties and then required **all** of them to be verified
before `FULLY_SIGNED`. The comment I wrote defending it argued that this was
what "the data model MUST support multiple required signatories" meant in
practice.

It was wrong, and the live run is what showed it: the seeded Jordan National
Bank has two authorized signatories, so a contract sat at two of three
verified signatures and never completed. ZM-CON-010's actual words are
*"Default signature requirement: **one** authorized supplier signatory and
**one** authorized bank signatory"* — supporting multiple is a capability of
the model, not the default policy.

Requiring all of them would have held every contract hostage to whichever
colleague was on leave, and would have turned a stated default of "one and
one" into "all" without anyone deciding to.

The fix separates two questions that I had conflated: `createSignatureSlots`
decides **who may sign** (every eligible signatory, so the UI can show them
and any of them can act), and `settleContractStatus` decides **when enough
have** (one verified signature per capacity). The unsigned slots stay
`PENDING` rather than being tidied away — that person did not sign, and a
status invented to mean "no longer needed" would be a claim about intent that
nobody made.

There is now a test named for exactly this: *"did not require the bank's
SECOND authorized signatory"*.

### 5.5 The error envelope is flat

My first pass at the integration suite read `res.body.error.code`. The
contract's envelope is `{ code, message, details?, correlationId? }` with no
`error` wrapper — which the exception filter's own header comment states
plainly. Eight assertions were reading `undefined.code` and reporting it as a
failure of the thing under test rather than of the test.

---

## 6. Still blocked

**Deployment**, unchanged and now six phases old, and per the product owner a
deliberate deferral. Everything above ran against the hosted Supabase
database and Storage with the API running locally.

**Q-03 (Arabic digit set)** — now overdue rather than merely pressing. This
phase ships the **first Arabic legal prose in the product**: the AR contract
template, containing amounts and dates, on a document a supplier signs. I
have used Arabic-Indic section numbers (١، ٢، ٣) in the template headings and
Western digits for money, which is the common Jordanian banking convention —
but that is my assumption standing in for a ruling, and it is now baked into
a contract template rather than a UI label.

**Duplicate bank organizations** in the hosted database (§5.1). The seed no
longer creates them; the existing ones need a remap-and-delete pass.

---

## 7. Verification

| Check | Result |
|---|---|
| API unit tests | **387 passed** (22 suites) |
| Phase 6 live integration | **33 passed**, incl. the concurrency harness |
| ML tests | **122 passed** |
| Contract conformance | **50/82 paths, no drift** (was 44/82) |
| `db:verify` | **20/20** (was 17 — three added: AS-01 setting, INV-4 trigger, contract templates) |
| Migration `0008` | applied |
| Typecheck (all workspaces) | clean |
| Lint (all workspaces) | clean |

---

## 8. For Agent B

Handover notes are in `docs/coordination/DAILY_LOG.md` under 2026-07-23
(Phase 6). The short version: acceptance returns the **snapshot**, not the
offer; `/accept` is a **200**, not a 201, and has no request body; a replay
returns the same snapshot rather than an error; the below-floor and
already-locked refusals are both 409-or-422 with stable codes; and the
contract's `documentHash` is over the exact bytes a signatory sees, so if you
render the document yourself rather than serving what the API stored, the
hash on screen stops meaning anything.
