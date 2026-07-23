# Open Questions (escalation queue — append-only)

Ambiguities the frozen documents don't resolve, awaiting product-owner ruling. Order of authority first: `03_API_CONTRACT.yaml` → `02_DATABASE_SCHEMA.sql` → `01_..REQUIREMENTS.md` → product owner.

Format:

```
## Q-<seq> — <short title>
Raised by: Agent A|B, <date>, blocking: <phase/task or "not blocking">
Question: <what is ambiguous, with document references>
Options considered: <1..n>
Recommendation: <the agent's preferred answer>
Needed by: <date/phase>
Status: OPEN | RULED (see DECISIONS.md D-ref)
```

Rules: raising a question means you STOP that thread and switch tasks — never work around it. Rulings land in `DECISIONS.md`; update the Status line here to point at them.

---

## Q-01 / D-15 — `citext` is used by the frozen schema but never enabled; the file does not execute
Raised by: Agent A, 2026-07-22, blocking: Phase 1 migration 0001 (worked around additively — see below)
Question: `docs/02_DATABASE_SCHEMA.sql` declares three columns as `citext` (`users.email` L112, `organizations.contact_email` L133, `supplier_buyer_relationships.contact_email` L318) but its extension block (L14-15) creates only `uuid-ossp` and `pgcrypto`. `citext` is **not** enabled by default on Supabase, so the frozen file aborts at its first `CREATE TABLE` with `ERROR: type "citext" does not exist`. This is the same class of defect as D-01 — the schema does not load as written — but Master Plan Part 7 did not catch it and no ruling covers it.
Options considered:
1. Add `CREATE EXTENSION IF NOT EXISTS citext;` to a **prerequisite migration `0000`** that runs before `0001`. Frozen file untouched; `0001` stays byte-faithful; purely additive (no column, constraint, or response shape altered), which the pack permits without a ruling.
2. Amend the frozen file's extension block (L14-15) to include `citext` and regenerate `0001`. Cleanest to read, but edits a frozen file — needs a ruling and a schema version bump.
3. Change the three columns to `text` with a lower-case functional unique index. Rejected: alters frozen column types and case-insensitive comparison semantics platform-wide.
Recommendation: **Option 1**, already implemented as `db/migrations/0000_prerequisites.sql` on the grounds that it is additive and therefore pre-authorised. Ratify it as a ruling (or direct me to Option 2) so the disposition is recorded rather than inferred. Work was not blocked and no frozen file was touched.
Needed by: before the hosted migration run is treated as final (cheap to switch either way).
Status: OPEN

## Q-02 — RLS coverage in the frozen schema is 8 tables of 59, with zero GRANTs
Raised by: Agent A, 2026-07-22, blocking: not blocking (Phase 1 task, additive)
Question: The frozen schema enables RLS on 8 tables, writes 2 policies, and issues no `GRANT`/`REVOKE` at all. On hosted Supabase the default privileges grant `anon`/`authenticated` full table access, so the **51 tables with no RLS are readable and writable by any authenticated user** through the Supabase client API — including `users` (emails, phone numbers), `bank_policy_filters`, `bank_eligibility`, `funding_otps` (`otp_hash`), `accepted_offer_snapshots` (competitor amounts), `commission_calculations`, `ledger_entries`, and `audit_logs`. Separately, 6 tables have RLS **enabled with no policy** (`invoices`, `listings`, `documents`, `settlements`, `buyer_payments`, `supplier_buyer_relationships`), making them deny-all. D-02 closes one column on one table while this is open. The schema anticipates the gap ("Every tenant table gets RLS. Pattern shown; apply to all.") and Phase 1 assigns me the completion, so this is a **notice, not a request** — but it is a materially larger hole than Part 7 implies and the product owner should know it exists.
Options considered: n/a — completing the policy set is an assigned Phase 1 task and is additive.
Recommendation: No ruling needed. Implemented in `db/migrations/0003_rls_policies.sql`: deny-by-default posture (revoke all writes and `anon` reads across `public`), per-table SELECT policies for every tenant table, column-level revokes on `funding_otps.otp_hash` and `buyer_payments.bank_internal_notes` (ZM-PMT-018) following the D-02 pattern, and a coverage checklist in `docs/specs/ARCHITECTURE.md` enforced by a CI test that fails when a new table appears without a policy entry.
Needed by: n/a
Status: OPEN (informational)

## Q-03 — Which digit set does Arabic use for money amounts?
Raised by: Phase 1 unification session, 2026-07-23, blocking: not blocking (current behaviour preserved)
Question: `ZM-I18N-004` requires dates, numbers, and currency to be "localized", and mandates JOD with three decimal places — but it does not say whether the Arabic locale renders amounts in Western digits (1,250.000) or Arabic-Indic digits (١٬٢٥٠٫٠٠٠). `apps/web/lib/money.ts` currently formats with `en-US` grouping in both locales. That was not a decision so much as a leftover: the code contained a dead ternary (`numeralLocale === "ar-JO" ? "en-US" : "en-US"`) whose two branches were identical, so the Arabic branch had never actually been reachable.
Options considered:
1. Western digits in both locales (current behaviour). Consistent with IBANs, establishment numbers and invoice references, which are Latin-numeric everywhere in the product; avoids bidi complications when an amount sits inside Arabic prose (ZM-I18N-006).
2. Arabic-Indic digits when `locale === "ar"`. More faithfully "localized", but changes every amount on every Arabic screen and in generated Arabic documents, and interacts with the contract's canonical-English rule (ZM-I18N-003b).
Recommendation: **Option 1**, i.e. ratify what ships today, on the grounds that money strings are compared against contract and ledger values that are Latin-numeric everywhere else. The dead branch has been removed and the choice is now stated explicitly in `lib/money.ts` with a pointer here. Cheap to reverse — one `Intl.NumberFormat` locale argument — until Arabic contract/notification templates are written in Phase 6+.
Needed by: before Arabic document templates are authored (Phase 6), after which the choice is baked into rendered PDFs.
Status: RULED (see DECISIONS.md D-17 — Western digits in both locales, 2026-07-23)

## Q-04 — `POST /auth/context` returns a response body the contract does not declare
Raised by: Phase 1 unification session, 2026-07-23, blocking: not blocking
Question: The frozen contract declares `POST /auth/context` → `200 { description: Context switched }` with **no content**. The implementation (`apps/api/src/modules/auth/auth.controller.ts`) returns `{ organizationId }`. Because the contract declares no schema, `openapi-typescript` generates `content?: never`, so Agent B's typed client cannot read the field without casting past its own types — the body is invisible to the consumer it was presumably added for. This is undeclared-but-harmless drift rather than a defect: nothing breaks, but the two documents disagree, and the new status-code check in the conformance gate does not compare response *bodies*.
Options considered:
1. Drop the body; return an empty 200. Matches the contract exactly, costs nothing — the client already re-reads context from `/auth/me`, and the accepted id is the id it just sent.
2. Amend the overlay to declare the body. Makes the field usable and typed, but is a contract amendment needing a ruling for a field with no established consumer.
3. Leave as is. Rejected: an undeclared body is exactly the silent divergence the conformance gate exists to prevent, and it teaches that the contract is approximate.
Recommendation: **Option 1** unless a consumer for the field is identified. The web client has been written not to depend on it either way (`SessionProvider.switchOrganization` uses the requested id), so this can be settled without blocking anyone. Worth noting the gate compares paths, verbs, and now success status codes — but not response schemas; extending it to bodies is the durable fix and is a candidate for Phase 5, when payloads start carrying money.
Needed by: before Phase 5, when response-shape drift starts to matter financially.
Status: OPEN

## Q-05 — `SupplierApplication.governmentData` has no per-field provenance shape
Raised by: Agent B, 2026-07-23, blocking: not blocking (Phase 2 renders defensively — see below)
Question: `03_API_CONTRACT.yaml` L1375–1378 types `governmentData` as `type: object, additionalProperties: true` — free-form. But `ZM-GOV-002` requires every field to carry `value`, `source`, `retrievedAt`, `verificationStatus`, `evidenceRef`, `sourceReference`, and the brief (§5 "Government fields") and `PHASE_2` both require B to render each field read-only **with a source badge (CCD/ISTD/GAM) and retrieval date**. A free-form object does not tell B where in the payload the source/timestamp for a given field lives, so two independent implementations will disagree.
Options considered:
1. Contract stays free-form; A and B agree a normalized shape in the daily log (not binding, drifts).
2. Overlay amendment types `governmentData` as `{ [fieldName]: { value, source, retrievedAt, verificationStatus, evidenceRef?, sourceReference? } }` — a direct encoding of ZM-GOV-002, additive only (the base schema already permits it since `additionalProperties: true`).
3. Drop provenance from the application payload and have the UI join `GET /government/requests/{id}` per source — needs a request-id list on the application, which the contract also does not provide (see Q-08).
Recommendation: **Option 2.** It is additive (any object satisfying it already satisfies the frozen schema), it is a literal transcription of ZM-GOV-002, and it is the only option that makes the source badge deterministic.
Interim behaviour (does not pre-empt the ruling): B parses `governmentData` through a single adapter, `apps/web/lib/onboarding/government.ts`, which accepts the Option-2 shape and degrades to a value-only, badge-less render for anything else. If the ruling differs, exactly one file changes.
Needed by: Phase 2 integration checkpoint
Status: **RESOLVED** (Phase 2 unification session, 2026-07-23). The server shape is the answer: one entry per field, `{value, sourceKind, source, retrievedAt}`, `sourceKind ∈ GOVERNMENT | SELF_DECLARED | DERIVED`. The client adapter (`apps/web/lib/onboarding/government.ts`) now reads exactly this; the mock store emits it.

## Q-06 — No structured catalogue for `decisionReasonCode`
Raised by: Agent B, 2026-07-23, blocking: not blocking (reviewer form ships with a documented provisional list)
Question: `POST /onboarding/applications/{id}/decide` takes `reasonCode: { type: string }` with no enum, and `SupplierApplication.decisionReasonCode` is likewise a bare string. `ZM-SON-012` enumerates six hard-rejection conditions and `ZM-SON-013` adds sole-proprietorship ineligibility, but no codes are defined anywhere in the frozen pack. The reviewer decision form (Phase 2, B) has to render a fixed picker, and the supplier-facing rejection screen has to map a code to a localized, non-pejorative explanation — both need the same catalogue as A's validation.
Options considered:
1. Free text — rejected: `ZM-SON-013` requires a *recorded* structured reason and the supplier message must be localizable, which free text is not.
2. Fix the catalogue in `DECISIONS.md` (7 rejection codes from ZM-SON-012/013 + conditional-approval and information-required codes) and have both agents key off it.
3. Add `GET /admin/reason-codes` — new endpoint, and B is not permitted to invent one.
Recommendation: **Option 2** — a decisions-log catalogue, no contract change needed since the field is already `string`.
Interim behaviour: B ships the provisional list in `apps/web/lib/onboarding/reason-codes.ts`, derived verbatim from ZM-SON-012/013, with EN+AR supplier-facing copy. A's accepted values must match or the decide call will 422 at integration.
Needed by: Phase 2 integration checkpoint
Status: **RESOLVED** (Phase 2 unification session, 2026-07-23). Unified catalogue in `apps/api/src/modules/onboarding/decision-catalogue.ts`, mirrored by `apps/web/lib/onboarding/reason-codes.ts`: 13 reviewer-selectable codes plus 7 automated codes the hard-rejection rules emit. The server now validates reviewer-supplied codes against the reviewer set (422 otherwise); automated codes are not reviewer-suppliable.

## Q-07 — `slaPaused` carries no pause reason, so the required "paused with reason" UI has no source
Raised by: Agent B, 2026-07-23, blocking: not blocking (reason is inferred from `status`)
Question: `ZM-SON-009` requires the supplier to see remaining SLA time **and current state at all times**; `PHASE_2_ONBOARDING_GOVERNMENT.md` (B tasks) requires "paused state **with reason**", and specifically that `GOVERNMENT_SERVICE_UNAVAILABLE` renders as paused-not-adverse. `SupplierApplication` provides `slaPaused: boolean` and `slaRemainingBusinessSeconds` but no reason field, while `ZM-SON-008` says every pause/resume is recorded with timestamp, reason, and actor server-side. The reason exists in `sla_clock_events` and is not exposed.
Options considered:
1. Infer the reason from `status` — `INFORMATION_REQUIRED` → awaiting your response, `GOVERNMENT_SERVICE_UNAVAILABLE` → source did not answer. Works for the two states §5.5 marks as pausing, but silently mislabels any future pause reason.
2. Additive optional field `slaPausedReason: string` (+ optional `slaPausedAt`) on `SupplierApplication`.
Recommendation: **Option 2**, with Option 1 as the fallback render when the field is absent.
Interim behaviour: B implements Option 1 keyed off `status` and reads `slaPausedReason` when present, so no change is needed if the field lands.
Needed by: Phase 2 integration checkpoint
Status: **RESOLVED** (Phase 2 unification session, 2026-07-23). The server sends `slaPausedReason ∈ INFORMATION_REQUESTED | GOVERNMENT_SERVICE_UNAVAILABLE`; the client maps both (and falls back to status inference for older payloads).

## Q-08 — No way to list the government lookups belonging to an application
Raised by: Agent B, 2026-07-23, blocking: not blocking (per-source panel driven from `governmentData`)
Question: `GET /government/requests/{id}` fetches one lookup by id, and `POST /government/lookup` returns one. Nothing returns the set of lookups performed for an application, so the supplier/reviewer per-source panel (CCD / ISTD / GAM, each with its own `sourceAvailable`, `status`, `retrievedAt`, `validUntil` — required by `ZM-GOV-003` and by the phase-2 failure drill where GAM is injected unavailable) has no id to fetch. The application payload does not include the request ids either.
Options considered:
1. Additive `governmentRequests: GovernmentRequest[]` on `SupplierApplication` (or on the `GET .../applications/{id}` response only).
2. Additive `GET /onboarding/applications/{id}/government-requests`.
3. Derive per-source availability from `governmentData` alone — loses `sourceAvailable` for a source that returned nothing at all, which is exactly the `ZM-GOV-008` "source did not answer" signal that must not read as adverse.
Recommendation: **Option 1** — one round trip, and it keeps the reviewer detail screen a single GET.
Interim behaviour: B's `GovernmentSourcePanel` reads `application.governmentRequests` when present and otherwise reconstructs one row per source seen in `governmentData`, rendering unseen sources as a neutral "not yet retrieved" — never as adverse. Option 3's weakness is therefore visible in the UI, not hidden.
Needed by: Phase 2 integration checkpoint (the GAM-unavailable failure drill cannot be demonstrated without it)
Status: **RESOLVED** (Phase 2 unification session, 2026-07-23). The application detail body now carries `governmentRequests[]` (id, source, status, sourceAvailable, retrievedAt, validUntil) — latest request per source — additively inside the object the overlay already extends. The per-source panel and the ISTD failure drill read it. Related: the outage-recovery path is now reachable — a successful POST /government/lookup for a paused application re-runs verification and resumes the clock.

## Q-09 — Consent types and versions are supplied by the client with no catalogue
Raised by: Agent B, 2026-07-23, blocking: not blocking (provisional catalogue in the wizard)
Question: `POST /onboarding/applications/{id}/consents` requires `consentType`, `consentVersion`, `granted` per item, but nothing tells the client which consents are required, what their current versions are, or what text to display. §5.2 names four categories ("lookup and sharing authorization; terms; privacy; declarations") without codes or versions. Submitting an unrecognised `consentType`/`consentVersion` will fail validation server-side; `ZM-SON-012` also makes "refusal of essential consents" a hard rejection, so the client must know which ones are essential.
Options considered:
1. Catalogue fixed in `DECISIONS.md` (codes + current version + EN/AR copy + essential flag), both agents key off it.
2. Additive `GET /onboarding/consent-types`.
Recommendation: **Option 1** for the competition build — the set is static and versioned by document revision, not by runtime state.
Interim behaviour: `apps/web/lib/onboarding/consents.ts` holds the provisional four codes at version `1.0`, all flagged essential per ZM-SON-012, with EN+AR copy. A's accepted set must match.
Needed by: Phase 2 integration checkpoint
Status: **RESOLVED** (Phase 2 unification session, 2026-07-23). The client four are canonical: GOVERNMENT_LOOKUP_AUTHORIZATION, BANK_DISCLOSURE_AUTHORIZATION, TERMS_OF_SERVICE, PRIVACY_POLICY, version "1.0". Server-side whitelist on …/consents; …/submit refuses with CONSENTS_REQUIRED until all four are granted; seeds updated to the same vocabulary.

## Q-10 — No frozen identity or injection key for a sole proprietorship, which ZM-SON-013 requires
Raised by: Agent B, 2026-07-23, blocking: not blocking (local placeholder key, see below)
Question: `ZM-SON-013` makes sole proprietorships ineligible in V3 and requires a clear, non-pejorative ineligibility message plus a recorded attempt — so the ineligibility screen is a Phase 2 deliverable and a demo scenario. But `docs/specs/GOV_DUMMY_DATA.md` contains no sole-proprietorship supplier (§2 lists three, all companies) and no failure-injection key that produces one (§5's five keys cover UNAVAILABLE / NOT_FOUND / PARTIAL / ERROR / slow — all orthogonal to entity type). There is therefore no shared input that makes either agent's stack produce the one case the requirement is about.
Options considered:
1. Add a fourth supplier to §2 — e.g. S4, an `20000104` sole proprietorship, seeded like the others. Most faithful: entity type is a property of a business, not a fault injection.
2. Add a sixth failure-injection key to §5 (e.g. `90000006` → CCD returns `companyType: SOLE_PROPRIETORSHIP`). Cheaper, and keeps the ineligible case out of the seeded supplier set where it might be mistaken for a usable supplier.
3. Leave it untestable end to end. Rejected: ZM-SON-013 is a MUST with a required user-facing message, and it is one of the phase-2 screens.
Recommendation: **Option 2**, on the grounds that §5 already exists precisely for "inputs that make the adapter behave a specific way", and a sole proprietorship is never going to be a working supplier in V3.
Note: GOV_DUMMY_DATA.md says adding is fine and only renaming/renumbering breaks the other agent — so this is an addition request, not an amendment.
Interim behaviour: `apps/web/lib/mocks/onboarding-store.ts` uses `90000006` for this case, named `SOLE_PROPRIETORSHIP_KEY_PENDING_RULING` and commented as a local extension rather than a shared convention. If A picks a different key or seeds S4 instead, one constant changes.
Needed by: Phase 2 integration checkpoint (the ineligibility screen cannot otherwise be demonstrated against live data)
Status: **RESOLVED** (Phase 2, Agent A + unification session). The answer is identity **S4 20000104 — Hani Auto Parts Establishment** (GOV_DUMMY_DATA.md §2), not a 9000000x injection key. The mock store now uses S4; the 90000006 placeholder is deleted.

## Q-11 — The duplicate-fingerprint 409 carries no declared review reference
Raised by: Agent B, 2026-07-23, blocking: not blocking (adapter reads `details`, degrades visibly)
Question: `ZM-VER-001` says a fingerprint collision **blocks submission and opens a review record**, and `PHASE_3_BUYERS_DOCUMENTS_INVOICES.md` (B tasks) requires the duplicate-blocked screen to render "a clear blocked screen **with review reference**". `POST /transactions/{id}/submit` declares `409 Duplicate invoice fingerprint detected` carrying the standard `Error` envelope — so the status and the code are reliable, but `Error.details` is `additionalProperties: true` and no key is named. The client therefore has no defined place to read the review record's identifier from, and two independent implementations will pick different key names.
Options considered:
1. Overlay amendment declaring `details: { reviewReference: string }` on that one response. Additive (any object satisfying it already satisfies the frozen schema) and it is the only option that makes the reference deterministic.
2. Agree a key in the daily log. Works, drifts — this is exactly the Q-05/Q-06 shape, and both of those ended up needing a written resolution anyway.
3. Do not show a reference; tell the supplier to quote the correlation id instead. Weaker: the correlation id identifies *the request that was refused*, not the review record a human has to find, and support would have to reverse-map it.
Recommendation: **Option 1**, with `reviewReference` as the key name.
Interim behaviour: `apps/web/lib/invoices/duplicate.ts` accepts `reviewReference`, `reviewRecordId`, `reviewId` or `caseReference`, and when none is present renders "Not provided" beside the correlation id rather than an empty field or a fabricated value. One file changes when this is ruled.
Needed by: Phase 3 integration checkpoint (the duplicate drill is in the checkpoint definition)
Status: **RESOLVED** (Phase 3 unification session). Agent A already sends `details.reviewReference` — B's primary accepted spelling — confirmed live by the journey suite's duplicate tests. `reviewReference` is the contract-de-facto key; B's tolerant adapter may keep its other spellings as a defensive fallback but no longer needs to.

## Q-12 — No way to list the documents attached to a transaction
Raised by: Agent B, 2026-07-23, blocking: not blocking (wizard tracks its own uploads)
Question: `POST /documents/upload-url` returns a `documentId`, and `GET /documents/{id}/download-url` and `/documents/{id}/extraction` both take one — but nothing returns the **set** of documents belonging to a transaction. `Transaction` carries `invoice` and `buyer` and no document array, and there is no `GET /transactions/{id}/documents`. So the wizard can track the ids it just created in its own state, but the transaction **detail** screen — reloaded later, or opened by a reviewer or a bank underwriter in Phase 5 — has no way to know which documents exist, and the ZM-DOC-004 signed-URL download path therefore has nothing to link to.
Options considered:
1. Additive `documents: Document[]` on the `Transaction` response (id, documentType, fileName, mimeType, sizeBytes, uploadedAt) — one round trip, and it keeps the detail screen a single GET. `ZM-DOC-003` already requires every one of those fields to be stored.
2. Additive `GET /transactions/{id}/documents`.
3. Leave it. Rejected: the bank underwriting view in Phase 5 lists supplier documents by design, so this becomes blocking then rather than now.
Recommendation: **Option 1**, mirroring how Q-08 was resolved for `governmentRequests`.
Interim behaviour: `TransactionView` in `apps/web/lib/invoices/useTransactions.ts` widens the generated type with an optional `documents[]` and every screen omits the section when it is absent — never showing an empty list as if the transaction had no documents.
Needed by: Phase 5 (bank underwriting view); useful at the Phase 3 checkpoint
Status: **RESOLVED** (Phase 3 unification session), on Option 1's terms but noting the contract already had this shape: the marketplace listing schema declares `documents: [{id, documentType}]`, so this is an additive field on the transaction detail mirroring an existing shape rather than an invented one. `TransactionsService.describe()` now returns `documents: [{id, documentType, fileName, uploadedAt}]` for SUPPLIER and PLATFORM audiences (banks get documents via the Phase 5 listing instead). The supplier transaction detail lists them with a per-document signed-download link, requested on click.

## Q-13 — No declaration template version, though the requirement says the version is recorded
Raised by: Agent B, 2026-07-23, blocking: not blocking (provisional version shipped)
Question: `ZM-INV-004` requires the eight supplier declarations to be affirmed "**with the declaration text version recorded**", and `LT-04`'s technical assumption is explicit that "declaration text is a versioned template; the accepted version is stored per submission". `DeclarationInput.declarationTemplateVersion` is accordingly `required` — but nothing in the frozen pack says what the current version string is, or where the eight texts live. The client has to send *some* version, and if it does not match what Agent A's half accepts, `POST /transactions/{id}/declarations` fails validation on the first integration day. This is the same failure mode as the consent catalogue (Q-09), which did materialise as a real cross-half divergence and needed a resolution.
Options considered:
1. Fix the version and the eight texts in `DECISIONS.md`, as Q-09's consent catalogue was fixed. The set is static and versioned by document revision, not by runtime state.
2. Additive `GET /transactions/declaration-template`. More faithful if the text is ever edited without a deploy, but no consumer needs that in V3.
3. Let the client send anything and have the server store it verbatim. Rejected: then the recorded version means nothing, which defeats the point of recording it.
Recommendation: **Option 1**, ratifying `"1.0"` and the transcription below unless the wording should differ.
Interim behaviour: `apps/web/lib/invoices/declarations.ts` holds `DECLARATION_TEMPLATE_VERSION = "1.0"` and the eight texts transcribed from ZM-INV-004's bullets, EN + AR. **Agent A's accepted version must match this or the declarations call 422s at integration.**
Needed by: Phase 3 integration checkpoint
Status: **RESOLVED** (Phase 3 unification session), on Option 1's terms: `"1.0"` is ratified as the accepted version, confirming B's transcription needed no change. Before this session A's service accepted **any** non-empty string — the exact Q-09 failure mode repeating, as B's §6 risk note predicted. `apps/api/src/modules/transactions/declaration-catalogue.ts` now holds `DECLARATION_TEMPLATE_VERSIONS = {'1.0'}` and `recordDeclarations` 422s on anything outside it, naming the accepted set in the refusal.

## Q-14 — `Offer` has no field naming the maker who created it
Raised by: Agent B, 2026-07-23, blocking: not blocking (approval queue and self-approval UI degrade to "unknown creator" if unresolved, not to a wrong answer)
Question: `ZM-OFR-016` requires maker/approver separation, and the phase file's B tasks require the approval queue to show "creator" and to block self-approval **in the UI as well as the server**. The `Offer` schema (§ generated schema.d.ts `components.schemas.Offer`) has no `createdByUserId` or equivalent — an approver's screen has nothing declared to compare against the logged-in user's id before the server call even happens, so the UI-side guard (a courtesy layer in front of the real server check, per `ZM-ROL-002`'s "DB CHECK is the backstop") cannot be built against the contract as written.
Options considered:
1. Additive `createdByUserId`/`createdByUserName` (and `approvedByUserId`/`approvedAt` once approved) on `Offer`, visible only on the two bank-scoped reads (`GET /offers`, `GET /offers/{id}`) — never on `BankListingView.myOffer` or the supplier-facing `/listings/{id}/offers`, where a bank's internal staffing is not the other party's business.
2. Leave it; rely solely on the server's 403. Rejected: the phase file explicitly asks for the UI-side block, and a maker who can attempt (and only then learn it failed) is a worse approval-queue experience than one who never sees an approve button on their own offer.
3. A separate `GET /offers/{id}/creator` lookup. Rejected: a second round trip for one field the list view already needs to render "created by ...".
Recommendation: **Option 1**.
Interim behaviour: `apps/web/lib/mocks/marketplace-store.ts` carries `createdByUserId`/`createdByUserName` on the raw offer record and includes them on `GET /offers` and `GET /offers/{id}` responses only (both bank-scoped to the offer's own organization); `lib/marketplace/useOffers.ts` widens the generated `Offer` type locally to read them. The approval queue hides the approve action (not just disables it) when `createdByUserId` matches the signed-in user, and the mock store's `approveOffer` independently rejects the same case server-side — so the interim behaviour already matches what Option 1 would ratify.
Needed by: Phase 5 integration checkpoint (the maker's self-approval attempt is a named checkpoint step)
Status: OPEN

## Q-15 — `AcceptedOfferSnapshot`/`Contract` don't carry a full money/conditions breakdown, though ZM-SEL-007 requires "every money component"
Raised by: Agent B, 2026-07-23, blocking: not blocking (acceptance modal reads the full breakdown from the offer already on screen; the post-accept success/timeline screens degrade to the declared subset)
Question: `ZM-SEL-007` requires the `AcceptedOfferSnapshot` to freeze, immutably, "every money component" and "all accepted conditions." The declared `AcceptedOfferSnapshot` schema carries only `grossFundingAmount`/`platformCommissionAmount`/`listingFeeAmount`/`netSupplierPayout` — `bankDiscountAmount`, `bankFeesAmount`, and `otherDeductionsAmount` are absent, so a reload of the post-acceptance screen (rather than the same session that just fetched the offer) cannot reconstruct the full breakdown the requirement asks to freeze. Separately, `conditionsSnapshot` is typed `Record<string, never>[]` — an array of objects with no declared properties at all, which is stricter than free-form: nothing satisfies that type except `{}`, so the conditions checklist screen has no declared field to read a condition's type, title, mandatory flag, or fulfilment status from.
Options considered:
1. Additive `bankDiscountAmount`/`bankFeesAmount`/`otherDeductionsAmount`/`expectedPayoutDate`/`validUntil` on `AcceptedOfferSnapshot`, and replace `conditionsSnapshot: Record<string, never>[]` with an array shaped like `OfferCondition[]` (a shape the contract already declares elsewhere). Mirrors how Q-12's `documents[]` was resolved — additive fields, no shape invented from nothing.
2. Leave it; have the conditions checklist and post-acceptance screens re-fetch `GET /listings/{id}/offers` for the full breakdown instead of trusting the snapshot. Rejected: `ZM-SEL-008` requires the snapshot to stay correct "even if the source `BankOffer` record is later modified or superseded" — re-reading the live offer defeats that guarantee the moment a revision happens after acceptance (which shouldn't be possible post-lock, but the snapshot is supposed to be the thing that doesn't depend on that invariant holding elsewhere).
3. A separate `GET /transactions/{id}/accepted-offer` with a fuller shape. Rejected: two round trips for data `AcceptedOfferSnapshot` already exists to carry.
Recommendation: **Option 1**.
Interim behaviour: `apps/web/lib/mocks/marketplace-store.ts` freezes all six money components plus real conditions on the internal snapshot record; `apps/web/lib/contracts/useContracts.ts` widens the generated `AcceptedOfferSnapshot`/`Contract` types locally to read them. The acceptance confirmation modal (pre-accept) already has the full breakdown from the offer on screen regardless of this gap; only a screen reloaded after the fact depends on the widened type.
Needed by: Phase 6 conditions checklist and contract review screens; the post-acceptance success screen's full breakdown
Status: OPEN

## Q-16 — ZM-FND-012 requires an "administrative task"; neither the schema nor the contract declares one
Raised by: Agent A, 2026-07-23, blocking: not blocking (escalation is delivered and audited; only its *presentation* to an operator degrades)
Question: `ZM-FND-012` says a stalled funding confirmation "**MUST NOT** stall silently. Escalation creates an administrative task with full context," and AS-04 fixes the recipient as Operations Admin. There is no task, queue, or work-item table anywhere in the frozen schema's 59 tables, and no endpoint in `03_API_CONTRACT.yaml` or the v3.1.0 overlay that would list one — the overlay's `/cases` is explicitly scoped to `FRAUD | DISPUTE | WITHDRAWAL | RECOURSE`, none of which a stalled confirmation is. So "administrative task" has no declared home: a task has an assignee, a status, and a resolution, and a notification has none of those.
Options considered:
1. Deliver the escalation through `notifications` (a row per active `PLATFORM_OPS_ADMIN`, carrying full context in the body) plus an audit entry. The overlay already declares `GET /notifications` and `POST /notifications/{id}/read`, so an operator genuinely sees it and can mark it handled. Costs: no assignment, and "read" is a weaker signal than "resolved".
2. Additive `admin_tasks` table with an additive `GET /admin/tasks`. Truest to the requirement's wording. Rejected for now: it invents a table *and* an endpoint shape from nothing, and an escalation an operator cannot see because no screen reads the new table is worse than one delivered through the mechanism that already has a screen.
3. Widen the overlay's `CaseType` enum with a fifth member. Rejected: a stalled confirmation is not a case in the sense the other four are (no counterparty, no adjudication, no resolution decision), and overloading the enum would put it in a list filtered by people looking for disputes.
Recommendation: **Option 1** now, **Option 2** if a task inbox is ratified — the sweep writes the same context either way, so promoting it later is a second write, not a rewrite.
Interim behaviour: `apps/api/src/modules/funding/funding-deadlines.service.ts` escalates via `notifications` with `template_key = 'FUNDING_CONFIRMATION_ESCALATED'` (which doubles as the idempotency key, so a transaction escalates exactly once) plus an `audit_logs` entry whose `new_value` carries transaction id, settlement id, invoice number, supplier org, net payout, `bankMarkedSentAt`, and hours pending. `PLATFORM_SUPER_ADMIN` is deliberately excluded per AS-04, and a deployment with no active Operations Admin logs at ERROR and writes no audit entry rather than silently claiming an escalation occurred.
Needed by: Phase 7 integration checkpoint (AS-04 is a named checkpoint step)
Status: RULED (see DECISIONS.md D-18 — escalation stays on notifications, no admin_tasks table, 2026-07-23)

## Q-17 — ZM-NOT-007 requires a manual call record; no endpoint in the contract or the overlay can create one
Raised by: solo agent, 2026-07-23, blocking: not blocking (every other ZM-NOT-007 field is stored and delivered; only the manual-call branch is unreachable)
Question: `ZM-NOT-007` requires that for every notification the platform store, "where applicable, the manual call record with the recording user and outcome." The frozen schema supports it exactly — `notifications.manual_call_notes` and `notifications.manual_call_by` both exist, and `MANUAL_CALL` is a member of the channel enum. What does not exist is any way to write them: `03_API_CONTRACT.yaml` declares no notification paths at all, and the v3.1.0 overlay declares only `GET /notifications` and `POST /notifications/{id}/read`. So the requirement's storage is fully specified and its input is entirely absent. `NotificationsService.recordManualCall()` is implemented and unit-tested but has no route, which makes ZM-NOT-007 satisfied in the database and unsatisfiable through the API.
Options considered:
1. Additive `POST /notifications/{id}/manual-call` taking `{ notes }`, restricted to platform staff, writing `manual_call_notes`/`manual_call_by` and setting `DELIVERED`. Smallest possible addition, uses the columns exactly as the schema shaped them, and the service method already exists.
2. Widen `POST /notifications/{id}/read` with an optional `manualCallNotes` body. Rejected: "read" and "I telephoned this supplier and here is what they said" are different assertions by different people, and overloading one route would let a recipient's own inbox action write an operator's call record.
3. Leave it unimplemented and drop the service method. Rejected: the schema author clearly intended the capability, and deleting working code to match a contract omission loses the requirement rather than recording it.
Recommendation: **Option 1**.
Interim behaviour: `NotificationsService.recordManualCall()` is retained, audited, and marked in its doc comment as having no route pending this ruling. It takes the previous notes in `previousValue` on the audit entry, because `manual_call_notes` is a single column and a second operator recording a later call would otherwise overwrite the first one's account of the conversation with no trace — a hard delete of evidence in a system that forbids them (INV-7). No caller exists, so nothing writes it today.
Needed by: Phase 9 if a manual-call demo step is wanted; otherwise the requirement stays partially met and is declared as such in `docs/specs/NOTIFICATIONS.md`.
Status: RULED (see DECISIONS.md D-16 — Option 1 approved 2026-07-23; POST /notifications/{id}/manual-call added to the v3.1.0 overlay and served)

## Q-18 — ZM-REC-018 requires seven verification outcomes before relisting approval, but nothing can record them
Raised by: solo agent, 2026-07-23 (Phase 9), blocking: not blocking (approval works; only the seven-check *enforcement* is absent)
Question: `ZM-REC-018` requires that seven verification outcomes (still unpaid, not financed elsewhere, unchanged, still valid, no fraud indicator, supplier eligible, buyer eligible) be recorded before a receivable returns to the marketplace. The frozen schema carries them: `relisting_requests.verification` is a jsonb object shaped for exactly these seven booleans. What is missing is any way to *write* them. The withdrawal decision inserts the request with `verification = '{}'` (all seven implicitly null); `POST /admin/relisting-requests/{id}/approve` in the frozen contract declares **no request body**; and no other endpoint touches the column. So the approve step cannot enforce "all seven true" without inventing contract surface — a request body the contract does not declare — which the standing constraints forbid. Same class as Q-17 (ZM-NOT-007 had storage and no input).
Options considered:
1. Additive request body on `POST /admin/relisting-requests/{id}/approve` carrying the seven outcomes, recorded onto `verification` and required all-true before the status flips to APPROVED. Faithful to ZM-REC-018; needs a ruling because it adds a body to a frozen-contract endpoint that declares none.
2. A separate additive `PATCH /admin/relisting-requests/{id}` (overlay) to record verification, leaving approve bodyless. Cleaner separation (record, then approve), but two endpoints where the contract implies one decision.
3. Leave approval as a bodyless status transition (current behaviour): approvable only from REQUESTED/UNDER_REVIEW, idempotent, audited with the current (all-null) verification state so the gap is visible in the trail. The seven-check discipline becomes an operational responsibility the audit record exposes rather than a hard gate.
Recommendation: **Option 3** for the demo (it is honest and needs no contract change), **Option 1** if the seven-check gate must be enforced in software — the approve path already writes the audit either way, so promoting it later is a second write, not a rewrite.
Interim behaviour: `AdminService.approveRelisting()` transitions REQUESTED/UNDER_REVIEW → APPROVED, is idempotent, and records both the previous and current `verification` in the audit entry. The doc comment and the endpoint description both name Q-18 so the gap is not silently passed over.
Needed by: Phase 9 relisting demo, if the seven-check gate is wanted on screen.
Status: OPEN
