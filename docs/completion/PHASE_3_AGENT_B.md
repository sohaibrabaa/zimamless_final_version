# Phase 3 Completion Report — Agent B

**Phase:** 3 — Buyers, Documents, Invoices (A) ∥ Invoice Wizard (B)
**Agent:** B (frontend)
**Sessions spent:** 1 (planned range: 5–7 days)
**Dates:** 2026-07-23 → 2026-07-23
**Phase file:** `docs/plan/phases/PHASE_3_BUYERS_DOCUMENTS_INVOICES.md`

## 1. Delivered vs. planned

| Planned item (phase file, Agent B tasks) | Status | Notes |
|---|---|---|
| Step 1 — Buyer: search → candidate list → **explicit selection, never pre-selected even at 100% match** → contact form; SUSPENDED/STRUCK_OFF blocked with clear reason; manual-review path surfaced | ✅ done | `components/invoices/BuyerStep.tsx`. The never-auto-select rule is a named function (`initialBuyerSelection`) that always returns null, so it is a thing a test asserts rather than an absence a later edit could fill in. Candidates render in API order — no client sort, because any sort is a ranking. |
| Step 2 — Invoice: e-invoice upload → OCR pre-fill → extracted-vs-entered comparison with mismatch highlighting; corrections **recorded alongside, not replacing**; QR status incl. `UNPARSED` → manual-review note | ✅ done | `ExtractionComparison.tsx` + `lib/invoices/extraction.ts`. Pre-fill never overwrites a typed value; an empty field is not a mismatch. `UNPARSED` QR fields are not trusted for pre-fill at all (ZM-DOC-010). |
| Step 3 — Documents: additional uploads per policy (PO, delivery note, statement) | ✅ done | `DocumentUpload.tsx`. **None is required** — see Deviations. |
| Step 4 — Minimum acceptable amount, labelled **minimum NET amount you will receive**, privacy note "banks never see this" | ✅ done | Label and hint both spell out that net means after every deduction. The privacy note sits on the entry screen and again on the detail screen, not in help text elsewhere. |
| Step 5 — Declarations: all eight, all required, template version shown | ✅ done | `lib/invoices/declarations.ts`. `buildDeclarationBody` throws rather than sending `false` — the contract types each as `enum: [true]`, so there is no shape for a declined declaration and coercing one would record an affirmation the supplier did not make. |
| Step 6 — Review & submit; duplicate-fingerprint 409 as a clear blocked screen with review reference | ✅ done | `DuplicateBlockedNotice.tsx`. Says *blocked*, not rejected — the draft survives — and shows the review reference, falling back to the correlation id when the server sends none (Q-11). |
| Supplier transaction list + detail (states through `ELIGIBLE`); verification results panel | ✅ done | `app/[locale]/supplier/invoices/{page,new/page,[id]/page}.tsx` + `VerificationPanel.tsx`. All eight §8.5 checks in table order. |

**All four screens in scope delivered** (six-step wizard · transaction list/detail · verification panel · duplicate-blocked screen).

The Phase 2 `FinancingGate` was wired against a `ComingSoonPage` placeholder for exactly this route; all three invoice routes now sit behind it, so ZM-SON-011 was enforced from the moment the screens existed rather than retrofitted.

## 2. Endpoints / screens

All 15 Phase 3 endpoints remain `mock`. Agent A's Phase 3 half had not been announced when this session ran, and A's standing instruction is that nothing flips until a **deployed public URL** exists — still outstanding since Phase 1. Every entry in `endpoint-status.ts` and `ENDPOINT_STATUS.md` now names its consuming screen, so each future flip has a specific same-day smoke target.

| Screen | Status | Verified how |
|---|---|---|
| Wizard step 1 — buyer search/select/contact | mock (`/buyers/search`, `/buyers/resolve`, `PUT …/buyer`) | Never-auto-select and the block/review split covered by 8 tests |
| Wizard step 2 — e-invoice upload, pre-fill, comparison | mock (`/documents/upload-url`, `/documents/{id}/extraction`, `PUT …/invoice`) | Extraction independence covered by 9 tests incl. the seeded mismatch |
| Wizard step 3 — supporting documents | mock (`/documents/upload-url`) | MIME/size rejection covered by test; `next build` |
| Wizard step 4 — minimum net amount | mock (`PUT …/minimum-amount`) | ≤ outstanding and > 0 covered by test |
| Wizard step 5 — eight declarations | mock (`POST …/declarations`) | All-eight-required covered by 3 tests incl. the per-declaration sweep |
| Wizard step 6 — review & submit | mock (`POST …/submit`) | Full submit sequence + duplicate block covered by store tests |
| Duplicate-blocked screen | mock | 409 parsing covered by 3 tests, incl. that a *different* 409 is not rendered as a duplicate |
| Transaction list | mock (`GET /transactions`) | Org scoping covered by test; route 200s in both locales |
| Transaction detail + verification panel | mock (`GET /transactions/{id}`, `…/verification`) | Check ordering and tone covered by tests |

Two mock handlers exist with no consuming screen, noted rather than left to look consumed: `GET /buyers/{id}` (screens read the buyer off the transaction) and `GET /documents/{id}/download-url` (needs Q-12's document list before anything can link to it).

## 3. Tests added

| Test / suite | Covers | Status |
|---|---|---|
| `lib/invoices/invoice-domain.spec.ts` (30 tests) | **ZM-BUY-009 never-auto-select, including the single 100%-name-match case the requirement names**; the block/manual-review split (SUSPENDED+STRUCK_OFF blocked, UNDER_LIQUIDATION and UNKNOWN reviewed) and that no blocked status is ever `danger`/`warning`; **ZM-DOC-006 extraction/correction independence** — a correction does not mutate the extraction, pre-fill never overwrites, both machine readings survive comparison; ZM-DOC-010 UNPARSED QR not trusted for pre-fill; ZM-INV-004 all-eight declarations with a per-declaration sweep and the refusal to coerce; **ZM-VER-001 duplicate 409 parsing**, incl. that a different 409 is not a duplicate; ZM-VER-002 check-result tone; hard rule 8 `OVERDUE_UNCONFIRMED` | ✅ |
| `lib/mocks/transaction-store.spec.ts` (20 tests) | The checkpoint sequence end to end: search → resolve → upload → extract → correct → floor → declare → submit → `ELIGIBLE`; **fingerprint uniqueness — the same invoice from a second supplier is blocked, and the fingerprints of two suppliers' identical invoices are asserted equal** (if the supplier were part of the key that equality would be false and the whole rule would silently never fire); server-side recomputation of `outstandingAmount`; floor validation; verification results derived from the transaction rather than canned; org scoping | ✅ |
| `npm run check:i18n -w web` | Locale parity — 453 keys in both, up from 274 | ✅ |

**91/91 vitest passing** (50 new; 41 pre-existing all still green). `tsc --noEmit`, `eslint` and `next build` clean in `web` and root-wide across all three workspaces.

The phase file's definition of done names three tests specifically — extraction raw/corrected independence, fingerprint uniqueness, and buyer-never-auto-select (100% name match still returns candidates only). **All three exist and are green**, the first two in the store suite and the third in the domain suite.

**Invariants:** none of INV-1..13 are frontend-owned at Phase 3. INV-8 (the supplier floor never reaching a bank) has a frontend-visible edge, and the mock now strips `minimumAcceptableAmount` from bank-facing `GET /transactions/{id}` responses so no screen can be built against a payload that always carries it — but the real boundary is A's API and D-02's RLS, and this is a third layer, not the guarantee.

## 4. Deviations and carry-overs

- **No supporting document is required in step 3.** ZM-DOC-002 makes PO / delivery note / statement mandatory-or-conditional **per bank or platform policy** (`CONFIGURABLE`), and V3 exposes no endpoint to read that policy — there is no `GET /admin/document-policy` in the contract or the overlay. Requiring one client-side would block a supplier on a rule the server does not enforce. The e-invoice is mandatory (ZM-DOC-001) and is step 2's subject.
- **The byte upload to the signed URL is deliberately not simulated.** `POST /documents/upload-url` is mocked and returns a mock-host URL that no request is sent to. A mock that appeared to store a file would hide the one thing the live swap has to prove; the comment in `DocumentUpload.tsx` says so at the call site.
- **Invoice fixture identities are local placeholders, prefixed `MOCK-`.** Buyers, suppliers and banks were all copyable from `GOV_DUMMY_DATA.md` and the seed SQL, and are copied. Invoices were not: §8 of that file lists "which of the 12 invoices sits in which of the 11 scenarios" as an open item owned by the Phase 9 Seed-Data Specification. Rather than invent values that read as authoritative — the defect the Phase 1 *and* Phase 2 audits each found — every invoice fixture is visibly marked as a placeholder and flagged in the daily log for reconciliation when A seeds the e-invoice set. This is the one value class in `transaction-store.ts` that has to be reconciled, and it is the direct analogue of Phase 2's `ORG_JORDAN_VALLEY_PENDING_SEED`.
- **Extraction is fetched on demand, not polled.** Extraction is asynchronous server-side, so step 2 offers an explicit "check for results" button. A background poll that silently overwrote a form the supplier was typing into would be worse than a button they press when ready.
- **The transaction detail screen renders documents only when the payload carries them** (Q-12). No empty-list state is shown, because "no documents" and "the API does not tell us about documents" are different facts and only one of them is true.

## 5. Open questions raised

Three, all filed to `OPEN_QUESTIONS.md` this session, all **OPEN**:

| Ref | Subject | Blocking? |
|---|---|---|
| Q-11 | The duplicate 409's review reference has no declared key, but the phase file requires the blocked screen to show one | Not blocking — adapter accepts four key spellings and degrades visibly |
| Q-12 | No way to list a transaction's documents, so the detail screen and Phase 5's underwriting view have nothing to enumerate | Not blocking now; **blocking at Phase 5** |
| Q-13 | No declaration template version, though ZM-INV-004 requires the version to be recorded | Not blocking — provisional `"1.0"` shipped, but see §6 |

Same judgement call as Phase 2, and worth restating rather than assuming it carried: hard rule 1 says a contract gap means stopping that thread. None of these is a missing endpoint — every endpoint the phase needs exists and is called as specified. Each is under-specification inside something the contract declares free-form (`Error.details`) or leaves as a bare required string with no catalogue. Each assumption is isolated to exactly one file, and each degrades visibly rather than silently. If the product owner reads that as over-reach, three files change.

## 6. Risks observed

- **Q-13 is the Q-09 failure mode repeating, and Q-09 did materialise.** In Phase 2 I shipped a provisional consent catalogue, A shipped a different one, and the unification session had to reconcile them. `declarationTemplateVersion` is the same shape of value: client-supplied, `required`, no catalogue anywhere in the frozen pack. If A's accepted version differs from `"1.0"`, `POST …/declarations` 422s on the first integration day and step 5 cannot complete. This is the single most likely point of failure at the Phase 3 checkpoint and it is cheap to close now.
- **R-08 (mock/live drift) grows again.** Phase 1 was 4 endpoints, Phase 2 added 12, this phase adds 15 — 31 mocked endpoints against zero live ones, three phases in. The conformance gate compares paths, verbs and success status codes, but not request bodies or enum values, so it would catch none of Q-11's, Q-12's or Q-13's divergences.
- **The mock's verification results are my reading of §8.5, not A's implementation.** They are derived from the transaction rather than canned — correcting the seeded mismatch really does move `OCR_CONSISTENCY` from REVIEW to PASS — which makes the panel honest about the fixture in front of it, but says nothing about whether A's eight `checkType` strings match mine. They are transcriptions of the §8.5 table; a mismatch is cosmetic (an unrecognised type still renders, labelled by its own code) rather than a failure, so this is a note, not a question.
- **The signed-URL authorization drill is only half-demonstrable from my side.** The mock returns 404 for a bank persona requesting a document download, which reproduces the shape — but a mock refusing itself proves nothing. The checkpoint's drill needs A's server and a real bank JWT.

## 7. Handoff notes for Agent A

1. **Match `DECLARATION_TEMPLATE_VERSION = "1.0"` in `apps/web/lib/invoices/declarations.ts`, or tell me what to use.** This is Q-13 and it is the consent-catalogue situation again. If the requirements point at a different version string or different wording, say so in the daily log and I will regenerate — don't accommodate my guess.
2. **Q-11: please send the duplicate 409's review-record identifier as `details.reviewReference`.** ZM-VER-001 opens a review record and the phase file requires the blocked screen to show its reference; the client currently accepts `reviewReference` / `reviewRecordId` / `reviewId` / `caseReference` and shows "Not provided" beside the correlation id when none arrives.
3. **Q-12: `documents[]` on the `Transaction` response** would let the detail screen list attachments and give `GET /documents/{id}/download-url` something to link from. Not blocking this phase; it becomes blocking for your Phase 5 underwriting view, which lists supplier documents by design.
4. **Invoice fixture identities need reconciling.** My mock uses `MOCK-INV-2026-0041` / `MOCK-JO-EINV-88213004` with a deliberate OCR-vs-QR tax discrepancy (`2000.000` vs `2100.000`). When you seed the e-invoice PDFs, tell me the real invoice numbers and which one carries the seeded mismatch, and I will copy them — same as I did for the S1–S5 identities. These are the only invented values in `transaction-store.ts` and they are marked as such.
5. **My fingerprint deliberately excludes the supplier** — buyer establishment number + invoice number + issue date + face value + tax, per D-01 and ZM-VER-001's "platform-wide". A test asserts that two suppliers' identical invoices produce the *same* fingerprint, because if that equality were ever false the duplicate rule would silently never fire on the case the checkpoint is about. Please confirm yours matches.
6. **I reproduced the floor strip in the mock**: `GET /transactions/{id}` omits `minimumAcceptableAmount` for a bank persona. That is UI hygiene so no screen gets built against a payload that always carries it — your API and D-02's RLS remain the real boundary.
7. Ownership held: I touched only `/apps/web/**`, `docs/coordination/{OPEN_QUESTIONS,ENDPOINT_STATUS,DAILY_LOG}.md`, and this report. I did **not** edit `GOV_DUMMY_DATA.md`, anything under `db/`, or any frozen document. Nothing renamed.

## 8. Checkpoint countersignature

- [ ] I have read `PHASE_3_CHECKPOINT.md` and confirm the checkpoint behaviour matches what my half renders.
  **Unchecked — reason:** `PHASE_3_CHECKPOINT.md` does not exist, and neither do the Phase 1 or Phase 2 checkpoints. The API is still not deployed to a public URL, so every endpoint across all three phases remains `mock` and no joint checkpoint has been run. My half is ready to wire the moment the 15 Phase 3 endpoints land; I will run the sequence (search buyer → resolve → upload seeded e-invoice → OCR pre-fill with the mismatch highlighted → correct it → set floor → declare → submit → `ELIGIBLE`, then the duplicate block from the second supplier) and countersign then.

---

# Appendix — for PHASE_3_CHECKPOINT.md only

Not applicable yet. The joint checkpoint requires Agent A's buyer, document and transaction endpoints plus the Python OCR service to be live, which has not happened.

What I can attest to today, against mocks only: the full checkpoint *sequence* is reproduced and green in `lib/mocks/transaction-store.spec.ts` — a buyer is searched and explicitly resolved, a seeded e-invoice produces an OCR/QR pair that disagree, the supplier's correction is compared without disturbing either machine reading, the floor is validated against the outstanding amount, all eight declarations are required, submission reaches `ELIGIBLE` when every check passes, and the same invoice submitted by a second supplier is blocked by fingerprint with a review reference while its draft survives intact.

That is the client-side statement of what the live checkpoint must show. It is **not** evidence the checkpoint passed. Two parts of the drill cannot be demonstrated from my half at all: real OCR running against a real PDF, and the signed-URL authorization refusal — a mock declining to serve itself proves nothing about ZM-DOC-004.
