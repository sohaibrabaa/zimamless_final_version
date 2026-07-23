# Post-Review Remediation — Agent A

**Date:** 2026-07-23
**Trigger:** the adversarial architecture review (`docs/08_ARCHITECTURE_REVIEW_PROMPT.md`).
**Scope:** the backend/DB findings that are mine to fix. The two P0s are addressed at the boundary of my ownership (see §6) — they are not backend code defects.

---

## 1. What was fixed

| Review finding | Severity | Status | Where |
|---|---|---|---|
| Idempotency-Key advertised but ignored | P1 | **Fixed** | new `IdempotencyInterceptor` + `0009` table, wired on `/offers/{id}/accept` |
| Uploads validated by MIME claim, not content | P1 | **Fixed** | new `content-sniff.ts`, enforced in `DocumentsService.ensureFinalized` |
| Duplicate bank organizations in hosted DB | P1 | **Tooling ready; apply gated** | `db/tools/dedupe-organizations.mjs` (dry-run clean, `--apply` awaits operator) |
| Contract-doc storage not transactional | P1 | **Mitigated** | best-effort orphan-row cleanup in `ContractsService.generate` |

Every fix is additive to the frozen contract and schema. `db:verify` = 20/20, typecheck clean, lint clean, 393/393 unit, Phase 6 integration green.

---

## 2. Idempotency-Key (P1) — the header now does something

The contract's global rule 4 requires an `Idempotency-Key` on every POST that
moves money or changes financial state, and the OpenAPI marks the parameter
`required: true` on `/offers/{id}/accept`, funding execute/confirm, settlement
retry, buyer-payment and recourse repay. Until now the header was allowed
through CORS and then ignored — advertised but inert, which is exactly the kind
of gap the review is meant to surface.

**Mechanism** (`src/common/idempotency/idempotency.interceptor.ts`, table in
`db/migrations/0009_idempotency_keys.sql`):

- A flagged route (marked `@Idempotent()`) with no header → **400
  `IDEMPOTENCY_KEY_REQUIRED`**.
- The `(organization_id, idempotency_key)` pair is *claimed* with an INSERT
  before the handler runs. The insert winner executes; a concurrent duplicate
  loses the insert, sees the claim still in progress, and is told **409** rather
  than executing a second time.
- On success the response and status are stored on the claim. A later replay of
  the same key returns exactly that, **without re-executing** — no second
  snapshot, no second audit row (the interceptor is registered *before* the
  audit interceptor, so a replay short-circuits outside it).
- A key replayed against a **different** request (method, path, or body hash) →
  **409 `CONFLICT`**. A body's JSON key order does not matter — the fingerprint
  is over a stable stringify.
- A handler that **fails** releases its claim, so a corrected retry may reuse
  the key. Idempotency protects duplicate *success*, not the right to retry a
  failure.

**Why this is a second line, not the only one:** `/offers/{id}/accept` was
already atomic at the row level (INV-1, `SELECT … FOR UPDATE`) and deduped on
the `offer_selections` unique key, so a double-accept never paid twice even
before this. What the header adds is a stable, client-observable "same request →
same response" contract — which is precisely what Agent B's mock already models
and asked for (DAILY_LOG, B's NEEDS #1).

**Scope note:** `/offers/{id}/accept` is the only *built* endpoint the contract
flags. The funding/settlement/payment/recourse endpoints are Phases 7-9 —
unbuilt — and each will carry `@Idempotent()` when it lands. `listings/{id}/
reject-all` is deliberately **not** flagged: it moves no money and the contract
does not require a key there.

**Tests:** three integration cases in `phase6-selection.integration.spec.ts` —
missing-header 400 (and no snapshot written), same-key replay returns a
byte-identical body with exactly one snapshot, reused-key-different-request 409.

---

## 3. Content sniffing (P1) — the declared type is a claim, the bytes are the fact

The browser PUTs straight to Supabase Storage against a signed URL, so at upload
time the API has only the client's declared `mimeType`, and a signed PUT URL
accepts anything. A caller could store an HTML page or a script under an
`application/pdf` label; the bucket's own allow-list matches the same unverified
Content-Type. Bucket download URLs are handed to *other organizations'* browsers
(the bank reading a supplier's document), which makes a stored-script upload a
real scripting vector.

**Fix** (`src/modules/documents/content-sniff.ts`): the API sees the bytes
exactly once — at finalization, when it downloads the object to hash it. That is
where the declared type is now checked against the leading magic bytes of the
four accepted types (PDF `%PDF-`, PNG, JPEG `FF D8 FF`, TIFF both-endian). A file
whose bytes contradict its declared type is refused **422 VALIDATION_FAILED**
before it is hashed, OCR'd, or attached to a transaction. The mismatch is logged
(never the bytes); the supplier's remedy is to re-upload the correct file.

Server-generated contract HTML is unaffected — it is written by the server
through `StorageService.upload`, not the user-upload finalize path, and is the
sole legitimate `text/html` in the bucket.

**Tests:** `content-sniff.spec.ts` (6 cases) — each type recognized, unknown
content rejected, `image/jpg` aliased to `image/jpeg`, and the headline attack
(HTML/script disguised as a PDF) refused.

---

## 4. Duplicate organizations (P1) — tooling ready, apply gated

`uq_org_national_no` is a *partial* unique index over suppliers only, so banks
and the platform org had nothing to conflict with, and the old seed's blind
`ON CONFLICT DO NOTHING` inserted a fresh copy on every run. (The seed is
already fixed — it looks before inserting.) The existing copies must be *merged*,
not blindly deleted: a duplicate may be referenced by memberships, eligibility,
audit rows, offers.

`db/tools/dedupe-organizations.mjs`:
- A duplicate group = rows sharing `(organization_type, national_establishment_no,
  legal_name)` with a non-null establishment number. Oldest row survives.
- Every FK onto `organizations(id)` is discovered from the catalogue (not
  hard-coded) and repointed from duplicate → canonical.
- Unique-constrained tables (`bank_eligibility (listing_id, bank_org_id)`,
  `organization_memberships (user_id, organization_id)`) fall back to a
  row-by-row pass addressed by `ctid`: move what moves, drop what would collide
  as redundant. Membership role grants follow via `ON DELETE CASCADE`.
- Per-group transaction with a savepoint: a surprise leaves that group intact
  and reported, never half-merged. Read-only until `--apply`.

**Dry-run result (clean):** 4 groups — Jordan National Bank, Levant Commercial
Bank, Capital Investment Bank, and the Zimmamless Platform org — each with two
duplicates, referenced **only** by `bank_eligibility` and
`organization_memberships`. No offer, transaction, snapshot, or ledger row
points at any duplicate. Canonical ids are the seeded `0e0000…` ids the
fixtures already use, so nothing downstream changes.

**Why not applied yet:** the merge deletes rows in the hosted database — a
hard-to-reverse action — and the execution sandbox blocked the `--apply`. It
needs an explicit operator go-ahead. The command is
`node db/tools/dedupe-organizations.mjs --apply`.

---

## 5. Contract-doc storage (P1) — orphan cleanup

The contract document (HTML) is written to the bucket *before* the contract-row
transaction, because Postgres cannot roll back a bucket write and an invisible
orphaned object is a better failure than a contract row pointing at a document
that was never stored — the existing, documented trade-off stands. What it did
*not* handle: the `documents` **row** inserted alongside the object also dangled
if the contract insert failed. `ContractsService.generate` now wraps the write
transaction and, on failure, deletes that orphan row (best-effort) before
re-raising. The bucket bytes remain the accepted, invisible orphan.

---

## 6. What is deliberately NOT fixed here — the two P0s

Neither P0 is a backend code defect, and neither is mine to resolve unilaterally:

- **P0-1 — the whole frontend runs on mocks (zero endpoints promoted to live).**
  That is Agent B's `ENDPOINT_STATUS.md` board and `/apps/web`, which I do not
  own or touch. My side of it is ready: the accept→contract→sign path is live
  and now enforces the idempotency the mock already models. Flipping it is a
  frontend action.
- **P0-2 — the demo dead-ends at CONTRACTED because Phases 7-9 are unbuilt.**
  Funding, OTP, settlement, and payout do not exist yet. Behaviour #5 and
  INV-5/10/13 are unenforced *because unbuilt*, not because broken. Building
  three phases is a scope decision, and it is gated on the ledger question I
  flagged in the review (Part 9): the double-entry ledger models a platform cash
  position the platform may never legally hold under ZM-CON-013 (bank→supplier
  direct). That wants a ruling in `DECISIONS.md` before Phase 7 is built on top
  of it.

Both are recorded for direction rather than patched.

---

## 7. Verification

- `apps/api`: `tsc --noEmit` clean; `eslint` clean; `jest` unit **393/393**.
- `content-sniff.spec.ts`: 6/6.
- `phase6-selection.integration.spec.ts`: green against the hosted DB, including
  the three new Idempotency-Key cases.
- `db:migrate`: `0009` applied. `db:verify`: **20/20** (table count 63, RLS
  63/63, the new `idempotency_keys` table covered by RLS + a policy).
- `dedupe-organizations.mjs`: dry-run clean; `--apply` pending operator.
