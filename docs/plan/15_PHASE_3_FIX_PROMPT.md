# Phase 3 Fix Prompt — unification session

You are a senior software engineer executing the Phase 3 audit's fix list in
the unified `main` checkout. Both agents' Phase 3 branches are already merged
and pushed (`674aca4`); every gate is green on the merged tree. The items
below are the divergences and defects the audit found. Work directly on
`main`, commit in logical chunks, and push when the acceptance gate passes.

Rules unchanged: never edit `docs/02_DATABASE_SCHEMA.sql` or
`docs/03_API_CONTRACT.yaml`; `DAILY_LOG.md` is append-only; the hosted
Supabase project is the live target.

---

## Part 1 — The critical defect

### 1. The fingerprint cannot catch cross-supplier double-financing (ZM-VER-001)

`apps/api/src/modules/transactions/fingerprint.ts` includes
`supplierEstablishmentNumber` in the hash. Consequences, all verified:

- The phase checkpoint — "re-submitting the same invoice from the second
  seeded supplier is blocked by fingerprint" — would **fail** live. A second
  supplier claiming S1's receivable produces a different fingerprint and
  sails through to `ELIGIBLE`. This is the exact fraud (one receivable
  financed twice) the phase names as the platform's most expensive exposure.
- A's own spec contradicts the code: `docs/specs/EINVOICE_QR.md` §7 says the
  seeded pair `INV-2026-0003` (S1 + S2 variants) "must collide on
  fingerprint", while `fingerprint.spec.ts` asserts they do NOT collide.
- The comment in `fingerprint.spec.ts` (lines ~37–40) claims cross-supplier
  double-financing "is caught by the buyer plus invoice-number plus amount
  triple below" — **no such check exists anywhere in the codebase**. The
  comment describes the fix that was never written.
- The journey suite's duplicate test (`phase3-journey.integration.spec.ts`
  §duplicates) resubmits from the *same* supplier persona, so the live run
  never exercised the checkpoint scenario. The report's §1 row claiming the
  cross-supplier pair is covered is therefore falsified.
- Agent B's mock got this right: its fingerprint is buyer + invoice number +
  issue date + face value + tax, with a test asserting two suppliers'
  identical invoices fingerprint **equal**, and B's handoff note 5 explicitly
  asked A to confirm — the question this audit answers with "B was correct."

**Fix:** remove `supplierEstablishmentNumber` from `FingerprintInput` and
`fingerprintSource`. Keep `FINGERPRINT_VERSION` but bump it to `'v2'` — the
hosted database holds v1 fingerprints on submitted rows, and a version bump
plus re-computation of active fingerprints (a one-off SQL/script step against
the hosted DB, or simply re-running submit-time computation for the affected
rows — there are only the live-run residue transactions `ZM-1004`+) keeps the
stored values honest. Same-supplier resubmission remains caught (identical
input → identical hash). Update: `fingerprint.spec.ts` (the seeded-pair
describe block inverts — they now MUST collide; delete the false comment),
`transactions.service.ts` `fingerprintFor` (drop the supplier lookup),
the journey suite (add a cross-supplier duplicate test: petra submits
`INV-2026-0003` after alnoor, expect 409 + review record + no counterparty
leak), and `EINVOICE_QR.md` needs no change — it was already right.

Mark the falsified row in `docs/completion/PHASE_3_AGENT_A.md` §1 and §2
(checks 30/33 were same-supplier only) with visible strikethrough
corrections, as done for Phases 1–2.

## Part 2 — Cross-half reconciliation

### 2. Three of eight `checkType` strings diverge

A emits `DUPLICATE`, `ELIGIBILITY`, `LOGIC`
(`apps/api/src/modules/transactions/verification.ts`); B's mock and labels
use `DUPLICATE_DETECTION`, `PARTY_ELIGIBILITY`, `TRANSACTION_LOGIC`
(`apps/web/lib/mocks/transaction-store.ts`, `VerificationPanel` labels,
message catalogues). The contract types `checkType` as a bare string, so
neither violates it — but live, three of B's eight panel rows would fall back
to raw-code labels. Per the standing convention (live shapes win), align B to
A's three strings: mock store, panel label mapping, i18n keys in both
locales, and the affected specs.

### 3. Invoice fixture identities — adopt A's seeded set

B's placeholders (`MOCK-INV-2026-0041`, `MOCK-JO-EINV-88213004`, tax
mismatch `2000.000` vs `2100.000`) were flagged by B itself for
reconciliation. A's real set is in `docs/specs/EINVOICE_QR.md` §7:

- Happy path: `INV-2026-0001`, `JO-EINV-20000101-0001`, face `12354.000`,
  tax `1704.000`, issue `2026-05-10` (S1 Al-Noor → B1 Amman Retail).
- **The mismatch fixture is `INV-2026-0002`** and the mismatch is on the
  **face value**: QR says `25000.000`, the page prints `24500.000` — not a
  tax mismatch. Rework B's mock extraction fixture and the
  `ExtractionComparison` tests to this identity and this field.
- Duplicate pair: `INV-2026-0003` (S1 and S2 variants).
- Past-due (AS-07): `INV-2026-0004`.

Replace every `MOCK-` invoice identity in `transaction-store.ts` and its
specs with these; drop the `MOCK-` prefix convention for invoices now that
authoritative values exist.

### 4. Q-13 (declaration template version) — close it

B guessed `"1.0"`; A's service accepts **any non-empty string**
(`transactions.service.ts` ~634), which is the Q-09 free-string failure mode
the Phase 2 audit closed for consents and reason codes. The live journey
already submits `'1.0'` successfully, so the values agree today — pin it so
drift breaks loudly: add `DECLARATION_TEMPLATE_VERSIONS = new Set(['1.0'])`
to a shared catalogue module in the API (alongside the Phase 2
decision-catalogue), 422 on anything else, with a service test. Mark Q-13
RESOLVED (accepted version catalogue = `{'1.0'}`, B's constant confirmed).

### 5. Q-11 (duplicate 409 review reference) — close it

A already sends `details.reviewReference` — B's primary accepted spelling.
Nothing to change in either half; B may keep its tolerant adapter. Mark Q-11
RESOLVED naming `details.reviewReference` as the contract-de-facto key.

### 6. Q-12 (listing a transaction's documents) — resolve by addition

The contract's marketplace listing schema **already carries `documents[]`**
(`03_API_CONTRACT.yaml` ~1626: `{id, documentType}`), so Phase 5's
underwriting view is not actually blocked. For the supplier transaction
detail, add the same-shaped `documents[]` array to A's transaction describe
payload (supplier + platform audiences; banks get it via the listing in
Phase 5). An additive response field is not contract drift (the conformance
gate checks paths/verbs/status codes) and mirrors an existing contract
shape rather than inventing one. B then renders the document list on the
transaction detail and wires `GET /documents/{id}/download-url` links from
it (its handler already exists, currently unconsumed). Mark Q-12 RESOLVED
on these terms.

## Part 3 — Smaller items

### 7. Legitimize A's journey-gate leftovers

Commit `674aca4` already added `phase3-journey.integration.spec.ts`, the
`test:integration`/`test:journey` scripts and `@types/supertest` — found
**uncommitted** in A's working tree after its session. Sanity-run
`npm run test:journey -w @zimmamless/api` once against the hosted stack
(start the ML service first: `services/ml/.venv/Scripts/python.exe -m
uvicorn app.main:app --port 8000` from `services/ml`) and record the result
in the daily log. This also closes A's §6 "services proven only by hand"
carry-over — note that in the log entry.

### 8. Cross-check the verification outcome vocabulary

While aligning item 2, confirm B's result values (`PASS` / `MISSING` /
`REVIEW` / `FAIL` / `NOT_APPLICABLE` / `UNPARSED`) match A's emissions
exactly (see `verification.spec.ts`); fix any stragglers in the panel's
tone mapping.

### 9. Docs and process

- Append the unification session to `DAILY_LOG.md` (append-only).
- Mark Q-11, Q-12, Q-13 RESOLVED in `OPEN_QUESTIONS.md` with the rulings
  above. Q-01..Q-04 remain OPEN.
- Correct `PHASE_3_AGENT_A.md` per item 1 (visible strikethrough, never
  silent rewrites). B's report needs no correction — its flagged
  provisionals were real and are now resolved.

## Acceptance gate (all must pass before push)

1. `npm run lint` + `npm run typecheck` — all workspaces.
2. `npm test -w apps/api` — 245+ (new fingerprint/catalogue tests included).
3. `npm test -w web` — 91+ with the re-fixtured mocks.
4. ML suite still green: `services/ml/.venv/Scripts/python.exe -m pytest services/ml/tests -q`.
5. `node db/tools/build-0001.mjs --check` and
   `npm run openapi:emit -w @zimmamless/api && node scripts/contract-conformance.mjs apps/api/openapi.generated.json`.
6. `npm run build -w web`.
7. `npm run check:i18n -w web` — parity holds after the new checkType keys.
8. Journey suite run once live (item 7), including the NEW cross-supplier
   duplicate test proving the re-keyed fingerprint blocks it.
9. `node db/tools/verify.mjs --insecure-tls` — 15/15.
10. Hosted DB: v1 fingerprints on active rows recomputed to v2 (item 1).

Commit in logical chunks on `main` and push.
