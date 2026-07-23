# Endpoint Status — mock → live promotion board

Mirror of `apps/web/lib/api/endpoint-status.ts`. Agent A flips **Announced live** when deployed; Agent B flips **B status** to `live` only after a same-day smoke test on the consuming screen. Demo-path endpoints must all be `live` before the Phase 9 rehearsal.

Legend: `mock` = MSW mock · `live` = real API, smoke-passed · `n/a` = not yet generated.

`GET /health` is deliberately **not** on this board. It is served outside the
`/v1` prefix, excluded from the frozen contract and from `/docs-json`, and so
never appears in the generated client — it is infrastructure, not a contract
endpoint, and has no mock→live promotion to track.

| Endpoint | Phase | Announced live (A, date) | B status | Notes |
|---|---|---|---|---|
| GET /auth/me | 1 | — | mock | demo flag (D-10) included |
| POST /auth/context | 1 | — | mock | |
| PATCH /auth/language | 1 | — | mock | |
| POST /onboarding/register * | 2 | — | mock | v3.1.0 · consumed by supplier bootstrap form |
| GET /onboarding/applications-list * | 2 | — | mock | v3.1.0 · supplier onboarding home + reviewer queue |
| POST /onboarding/applications | 2 | — | mock | no screen consumes it — bootstrap (D-04) covers the supplier path |
| GET /onboarding/applications/{id} | 2 | — | mock | reviewer application detail |
| POST …/{id}/submit | 2 | — | mock | wizard step 4 |
| POST …/{id}/bank-account | 2 | — | mock | wizard step 4 |
| POST …/{id}/consents | 2 | — | mock | wizard step 3 · **consent catalogue provisional, see Q-09** |
| GET …/{id}/information-requests | 2 | — | mock | info-request inbox (both portals) |
| POST …/{id}/respond | 2 | — | mock | supplier response form |
| POST …/{id}/decide | 2 | — | mock | reviewer decision form · **reason-code catalogue provisional, see Q-06** |
| POST /government/lookup | 2 | — | mock | handler exists; no screen triggers a manual lookup yet |
| GET /government/requests/{id} | 2 | — | mock | handler exists; source panel reads the list on the application instead (Q-08) |
| GET /buyers/search | 3 | — | mock | wizard step 1 · returns `{candidates[], requiresManualReview}`; **never a selection** (ZM-BUY-009). `candidates[].matchSource` is `OWN_RELATIONSHIP`/`PLATFORM`/`REGISTRY` |
| POST /buyers/resolve | 3 | — | mock | wizard step 1 · **200**, not 201. `confirmedByUser:true` required. 409 `BUYER_BLOCKED` for SUSPENDED/STRUCK_OFF; UNDER_LIQUIDATION returns 200 with `requiresManualReview:true` (LT-02) |
| GET /buyers/{id} | 3 | — | mock | handler exists; screens read the buyer off the transaction. 404 (not 403) without a relationship; carries **no contact data** (ZM-BUY-008) |
| POST /documents/upload-url | 3 | — | mock | wizard steps 2–3 · **200**, not 201. PUT the file to `uploadUrl` yourself; no finalize call — hashing and OCR run lazily on first extraction read or at submit. Byte upload deliberately skipped under MSW |
| GET /documents/{id}/download-url | 3 | — | mock | no screen consumes it yet (needs the document list, **see Q-12**). Authorization checked **before** any URL is issued (ZM-DOC-004); refusal is 404; URL lives 2 minutes |
| GET /documents/{id}/extraction | 3 | — | mock | wizard step 2 (pre-fill + mismatch table) · first call triggers hashing + OCR (~2–5s). `qr.validationStatus`: `VALID`/`INVALID`/`UNPARSED`/`UNAVAILABLE` — **UNAVAILABLE means no QR on the page**, UNPARSED means one we could not read |
| GET/POST /transactions | 3 | — | mock | supplier transaction list; POST creates the wizard draft — 201, no body. `referenceNumber` is `ZM-<n>` |
| GET /transactions/{id} | 3 | — | mock | transaction detail · body varies by audience: supplier/platform get `minimumAcceptableAmount`, a bank never does (INV-8) |
| PUT …/{id}/invoice | 3 | — | mock | wizard step 2 · `outstandingAmount` recomputed server-side, never accepted. Money is 3-dp strings. Editable in DRAFT / INFORMATION_REQUIRED only (409 otherwise) |
| PUT …/{id}/buyer | 3 | — | mock | wizard step 1 · the buyer must have been resolved by this supplier first, else 422 |
| PUT …/{id}/minimum-amount | 3 | — | mock | wizard step 4 · 422 when above `outstandingAmount`; the error deliberately does **not** echo the floor back |
| POST …/{id}/declarations | 3 | — | mock | wizard step 5 · 201. All eight must be true; a false one is **422** with `details.notAffirmed[]` naming which · **template version provisional, see Q-13** |
| POST …/{id}/submit | 3 | — | mock | wizard step 6 · **200**, not 201. 409 `DUPLICATE_INVOICE` with `details.reviewReference` → blocked screen (ZM-VER-001, Q-11 resolved by that key) |
| GET …/{id}/verification | 3 | — | mock | verification panel · all 8 checks always recorded, passes included. `NOT_APPLICABLE` is not `PASS` |
| GET …/{id}/risk | 4 | — | mock | built. components[] may carry null (render "not scored", not 0); dataAvailabilityPct is a separate NUMBER, style neutrally; mlFallbackReason present only when mlUsed=false · UI: TrustScoreGauge/ComponentBars/FactorList on the supplier transaction detail and the bank underwriting view |
| GET/POST /admin/risk-models | 4 | — | mock | built. platform roles only. POST creates, never edits; activating needs activationReason · UI: handler not implemented — no admin screen this session, not B's Phase 4 scope |
| POST …/{id}/listing | 5 | — | mock | built. 201. Show the fee BEFORE confirming (ZM-FEE-007) — it is incurred at activation whether or not financing succeeds. Returns both deadlines · UI: supplier listing-activation screen, requires a real ELIGIBLE transaction |
| GET …/{id}/listing-current * | 5 | — | mock | v3.1.0 · built. 404 when never listed. offerCount present for supplier/platform only · UI: v3.1.0 · listing-activation + offer comparison screens |
| GET /listings/{id} | 5 | — | mock | built. Same role split as listing-current |
| GET /listings/{id}/offers | 5 | — | mock | built. **role-split**: supplier gets every ACTIVE offer in full; a bank gets its OWN offer or an empty array — never a competitor, never a count (INV-11) · UI: role-split · offer comparison screen (supplier), own-offer check (bank) |
| GET /marketplace/eligible | 5 | — | mock | built. Paginated. Only OPEN_FOR_OFFERS listings this bank was found eligible for; filtered by join, not post-fetch · UI: bank marketplace feed · real per-bank policy-filter eligibility (ZM-MKT-002) |
| GET /marketplace/listings/{id} * | 5 | — | mock | v3.1.0 · built. **403** (not 404) when the bank was evaluated and excluded — it is entitled to know it was. No floor, no offerCount, no competitors · UI: v3.1.0 · bank underwriting view, incl. the Phase 4 risk components |
| GET/POST /banks/policy-filters | 5 | — | mock | built. POST is BANK_ADMIN only; other bank roles may read · UI: policy-filter configuration screen |
| PATCH /banks/policy-filters/{id} * | 5 | — | mock | v3.1.0 · built. Deactivation is `isActive:false`, never a delete — eligibility rows cite the filter that produced them · UI: v3.1.0 |
| POST /listings/{id}/offers/create | 5 | — | mock | built. 201. Do NOT send platformCommissionAmount/listingFeeAmount (400, named). netSupplierPayout optional but compared exactly. 409 if this bank already has a current offer — revise instead. 422 below floor, **generic, no numbers** · UI: offer form · server-computed commission/listing fee, generic floor rejection (ZM-MKT-012) |
| GET /offers * | 5 | — | mock | v3.1.0 · built. Approval queue + my offers; `?status=PENDING_INTERNAL_APPROVAL`. Scoped to the active bank org in SQL · UI: v3.1.0 · my offers + approval queue |
| GET/PATCH /offers/{id} | 5 | — | mock | built. PATCH creates a NEW version and moves the old one to REVISED; lineage kept. Another bank's offer is a 404, not a 403 · UI: offer status detail · revision creates a new version, prior retained immutably |
| POST /offers/{id}/approve | 5 | — | mock | built. **200**, not 201. 403 SELF_APPROVAL_FORBIDDEN if the approver created it (INV-12) — block it in the UI too, but the server is the authority · UI: approval queue · SELF_APPROVAL_FORBIDDEN enforced server-side |
| POST /offers/{id}/withdraw | 5 | — | mock | built. **200**. Pre-acceptance only, no penalty, audited. After acceptance it is 409 — that is the Phase 8 withdrawal-case route · UI: my offers · pre-acceptance, no penalty |
| POST /offers/{id}/accept | 6 | — | mock | DEMO-CRITICAL · built. **200, no request body.** Returns the AcceptedOfferSnapshot, not the offer. A replay returns the SAME snapshot with 200 — safe to retry. Second offer on a locked transaction is 409 TRANSACTION_ALREADY_LOCKED. Irreversible: a database trigger refuses to clear the lock · UI: DEMO-CRITICAL · acceptance modal, atomic-in-memory + idempotency-key replay-safe (ZM-SEL-001..008) |
| POST /listings/{id}/reject-all | 6 | — | mock | built. **200**. Transaction returns to ELIGIBLE and may be relisted; the listing is CANCELLED. Banks are told only that they were not selected · UI: reject-all flow on the offer comparison screen |
| POST/GET …/{id}/contract | 6 | — | mock | built. POST is **201**; 409 if already generated (never regenerates a signable document); **422 with `details.findings[]`** when the ZM-CON-006 checks fail — render the whole list as a checklist. GET is visible to both parties only · UI: contract review screens (both portals) · generation gated by ZM-CON-006 |
| POST /contracts/{id}/sign | 6 | — | mock | built. **200**. Body `{accepted:true}`; `false` is 422, not a no-op. 403 for a non-signatory. A signature counts only at `status:'VERIFIED'` — `SIGNED` is an intermediate. Contract reaches FULLY_SIGNED and the transaction CONTRACTED when all are verified · UI: click-to-accept signing · FULLY_SIGNED only once both sides sign |
| GET …/{id}/conditions | 6 | — | mock | built. Conditions on the ACCEPTED offer only; an empty array before acceptance, not a 404 · UI: conditions checklist |
| POST /conditions/{id}/fulfil | 6 | — | mock | built. **200**. Supplier records fulfilment with `documentIds` (must already be attached to the transaction); only the BANK may send `waiverReason`, and a blank one is 422. CONDITIONS_PENDING is derived — it clears itself · UI: conditions checklist · fulfil action |
| POST …/{id}/funding/mark-sent | 7 | — | mock | |
| POST …/{id}/funding/otp | 7 | — | mock | |
| POST …/{id}/funding/confirm | 7 | — | mock | |
| GET …/{id}/settlement | 7 | — | mock | |
| POST /settlements/{id}/retry | 7 | — | mock | |
| GET/POST …/{id}/payments | 8 | — | mock | |
| POST …/{id}/confirm-status | 8 | — | mock | |
| POST …/{id}/close | 8 | — | mock | |
| POST …/{id}/recourse · GET/status/repay /recourse/{id} | 8 | — | mock | partly v3.1.0 |
| POST …/{id}/disputes · resolve * | 8 | — | mock | |
| POST /offers/{id}/withdrawal-case · decide * | 8 | — | mock | |
| POST …/{id}/fraud-review · decide * | 8 | — | mock | |
| GET /cases * | 8 | — | mock | v3.1.0 |
| POST …/{id}/relist-request * | 8 | — | mock | v3.1.0 |
| POST …/{id}/cancel * | 8 | — | mock | v3.1.0 |
| GET /notifications · POST read * | 8 | — | mock | v3.1.0 |
| GET/PATCH /admin/settings | 9 | — | mock | |
| GET/POST /admin/commission-tiers | 9 | — | mock | |
| GET /admin/audit-logs | 9 | — | mock | |
| GET /admin/relisting-requests · approve | 9 | — | mock | partly v3.1.0 |
| POST /demo/time-travel | 9 | — | mock | DEMO-CRITICAL |
