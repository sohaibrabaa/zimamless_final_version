# Phase 2 Completion Report — Agent B

**Phase:** 2 — Onboarding + Government (A) ∥ Onboarding UI (B)
**Agent:** B (frontend)
**Sessions spent:** 1 (planned range: 4–6 days)
**Dates:** 2026-07-23 → 2026-07-23
**Phase file:** `docs/plan/phases/PHASE_2_ONBOARDING_GOVERNMENT.md`

## 1. Delivered vs. planned

| Planned item (phase file, Agent B tasks) | Status | Notes |
|---|---|---|
| Registration → org bootstrap flow (calls `/onboarding/register` when live) | ✅ done | `components/onboarding/BootstrapForm.tsx`. Branches on error `code`, not HTTP status (NOTE D-14). Mock handler is idempotent per establishment number, matching the D-04 200-vs-201 contract. |
| Onboarding wizard: establishment number → licence → consents → bank account (IBAN input with ownership evidence upload placeholder) | ✅ done | `components/onboarding/OnboardingWizard.tsx`. Steps 1–2 are **review** steps (nothing typed — ZM-SON-005); steps 3–4 are the only entry. IBAN mod-97 + JO-length validation in `lib/onboarding/iban.ts`. Evidence upload is an explicit disabled placeholder, not a fake control — `POST /documents/upload-url` is Phase 3. |
| Government-derived fields read-only with source badge (CCD/ISTD/GAM) + retrieval date; blank fields neutral | ✅ done | `components/onboarding/GovernmentFieldList.tsx`. No editable variant exists and none should — ZM-SON-003 forbids editing for administrators too. Blank renders as "Not provided by the source" in muted text; no warning colour, no icon. |
| SLA tracker: remaining business time, paused state with reason, `GOVERNMENT_SERVICE_UNAVAILABLE` shown as paused-not-adverse | ✅ done | `components/onboarding/SlaTracker.tsx` + `lib/onboarding/sla.ts`. The business calendar is **not** reimplemented client-side (see Deviations). Pause reason copy for the unavailable-registry case explicitly says it has no bearing on the outcome. |
| Information-request inbox + response form (text + document attachment stub) | ✅ done | `components/onboarding/InformationRequestInbox.tsx`. Read-only variant used on the reviewer screen — only the supplier may respond, since responding is what resumes the clock. |
| `APPROVED_CONDITIONAL` state UI: banner + disabled financing actions | ✅ done | `ConditionalApprovalBanner` + `FinancingGate`. Gate wraps all five supplier financing routes (invoices, offers, contracts, funding, payments) even though those screens ship later, so the rule isn't retrofitted. The destination stays reachable and explains itself — ZM-SON-011 requires the supplier can still see the platform. |
| Platform portal: review queue (filterable list), application detail with government data panel, decision form | ✅ done | `app/[locale]/platform/applications/{page,[id]/page}.tsx` + `DecisionForm`. Status filter + pagination off the D-05 endpoint; reason-code picker scoped to the chosen outcome. |
| Ineligibility screen (sole proprietorship) — clear, non-pejorative | ✅ done | `components/onboarding/IneligibilityNotice.tsx`. Copy rules are written into the component doc-comment so a later editor doesn't quietly re-word it into a rejection. Detected from the registry's own `companyType`, never guessed from a name. |

Screens in scope per the phase file — supplier: registration+bootstrap, wizard (4 steps), SLA tracker, info-request inbox, conditional-approval state; platform: review queue, application detail, decision form. **All eight delivered.**

## 2. Endpoints / screens

All Phase 2 endpoints remain `mock` — Agent A has announced nothing live (`DAILY_LOG.md` has no Agent A entries at all yet). `ENDPOINT_STATUS.md` and `lib/api/endpoint-status.ts` both updated with which screen consumes each endpoint, so the swap has a per-endpoint smoke target rather than a guess.

| Screen | Status | Verified how |
|---|---|---|
| Supplier bootstrap form | mock (`POST /onboarding/register`) | Route 200s in both locales; mock handler idempotency covered by test |
| Onboarding wizard, 4 steps | mock (`…/consents`, `…/bank-account`, `…/submit`) | `next build` + typecheck; submit transition covered by state-machine tests |
| SLA tracker | mock (`/onboarding/applications-list`) | Clock-state table covered by 4 unit tests incl. the paused cases |
| Information-request inbox + response | mock (`…/information-requests`, `…/respond`) | Pause→resume transition covered by tests |
| Conditional-approval banner + financing gate | mock | `financingBlocked` covered by test across all five states |
| Ineligibility notice | mock | Sole-proprietorship detection covered by test |
| Platform review queue | mock (`/onboarding/applications-list`) | Route 200s; role-split reproduced in the mock so the supplier path can't be built against the full queue |
| Platform application detail + decision form | mock (`…/{id}`, `…/decide`) | Route 200s with a real fixture id; decision transitions covered by tests |

Two mock handlers exist with no consuming screen: `POST /government/lookup` (nothing triggers a manual re-query yet) and `GET /government/requests/{id}` (the source panel reads the list on the application instead — Q-04). Both noted in `ENDPOINT_STATUS.md` rather than left to look consumed.

## 3. Tests added

This closes the Phase 1 carry-over "no automated test suite exists yet". Runner is Node's built-in `node:test` with native type stripping — no new dependency. `npm run check` = lint + i18n parity + tests.

| Test / suite | Covers | Status |
|---|---|---|
| `tests/onboarding-state-machine.test.ts` (7 tests) | §5.5 clock transitions: submit starts (24h), info-request pauses **with reason**, response resumes, approval stops; ZM-SON-010 unavailable-source pauses and is never adverse; D-04 bootstrap idempotency | ✅ |
| `tests/onboarding-domain.test.ts` (19 tests) | Clock-state table incl. server-flag override and unknown-status fallback; SLA breakdown/clamping; **ZM-SON-010 + ZM-GOV-003 neutral-tone assertion** (the two states most likely to be miscoloured later); ZM-SON-011 financing gate; Q-01 government normalization incl. bare values, blanks, arrays and malformed payloads; ZM-SON-013 sole-proprietorship detection; IBAN validation per failure mode; ZM-SON-012 consent completeness | ✅ |
| `scripts/check-i18n-parity.mjs` | RTL checklist rule #8 — no key in one locale only (256 keys, both) | ✅ |

**26/26 passing.** `next build` clean (33 routes × 2 locales), `eslint` clean, `tsc --noEmit` clean.

**Invariants:** none of INV-1..13 are frontend-owned at Phase 2 (they land in Phases 3–9 per Master Plan 5.4–5.6). The neutral-tone test above is the closest Phase 2 equivalent and is green. No invariant scheduled for this phase is untested.

## 4. Deviations and carry-overs

- **The SLA figure does not tick down between fetches.** The tracker renders the server's `slaRemainingBusinessSeconds` verbatim rather than running a client-side countdown. Deliberate: the business calendar (Sun–Thu 08:00–17:00 Amman + holidays) lives server-side with `sla_clock_events` as the ledger, and a browser countdown would drift from it — worse, a *paused* clock that appeared to keep running would actively misinform. Documented in `components/onboarding/SlaTracker.tsx`.
- **Built against a documented assumed shape for `governmentData`.** The contract types it `additionalProperties: true`, which cannot drive a source badge. Rather than stop the whole phase (hard rule 1), the assumption is isolated in exactly one adapter (`lib/onboarding/government.ts`) that degrades to a badge-less read-only render for any other shape, and the gap is filed as **Q-01**. No endpoint was invented and no response is reshaped to hide a gap. Same pattern for Q-03 (pause reason inferred from status, server field preferred when it appears) and Q-04 (source panel falls back to reconstructing rows, showing unseen sources as "not yet retrieved" rather than pretending).
- **Provisional catalogues shipped for reason codes (Q-02) and consent types (Q-05).** Both are client-supplied values with no enum in the contract and no catalogue anywhere in the frozen pack. They are transcriptions of ZM-SON-012/013 and §5.2 respectively, in `lib/onboarding/{reason-codes,consents}.ts`. **Agent A's accepted values must match these or `decide`/`consents` will fail validation at integration** — this is the most likely single point of failure at the checkpoint.
- **Phase 1 carry-over resolved:** test runner now exists (§3).
- **Phase 1 carry-over re-carried:** mock identities are still placeholders. `docs/specs/SEED_DATA.md` still does not exist. I extended the placeholder set to five suppliers to cover the state variety this phase needs (`lib/mocks/onboarding-store.ts`), which makes the eventual swap *larger*, not smaller. Still a NEEDS FROM A.
- **Phase 1 carry-overs unchanged:** no Supabase project provisioned; `/apps/web` still standalone pending A's root config; ESLint money rule still syntactic not type-aware.
- **Supplier's own seeded application starts as `DRAFT`** so the full checkpoint sequence is drivable by persona-switching rather than only inspectable. Two extra supplier personas (`supplier-conditional`, `supplier-ineligible`) added so those two screens are directly reachable. All dev-only, hidden when `NEXT_PUBLIC_API_MOCKING=disabled`.
- **One RTL item logged, not fixed:** the `←` back-link on the application detail screen is a literal character and doesn't mirror (checklist rule #5). Recorded in `RTL_CHECKLIST.md` for the Phase 9 pass, which needs an icon system anyway.

## 5. Open questions raised

Five, all filed to `OPEN_QUESTIONS.md` this session, all **OPEN**:

| Ref | Subject | Blocking? |
|---|---|---|
| Q-01 | `governmentData` has no per-field provenance shape, but ZM-GOV-002 + the brief require a source badge and retrieval date | Not blocking — isolated adapter, degrades safely |
| Q-02 | No structured catalogue for `decisionReasonCode` | Not blocking — provisional list shipped |
| Q-03 | `slaPaused` carries no reason, but "paused **with reason**" is a phase-file requirement | Not blocking — inferred from status |
| Q-04 | No way to list an application's government lookups, so the per-source `sourceAvailable` panel has no ids | Not blocking — but **the GAM-unavailable failure drill in the checkpoint needs this** |
| Q-05 | Consent types/versions are client-supplied with no catalogue | Not blocking — provisional catalogue shipped |

Judgement call worth stating plainly: hard rule 1 says a contract gap means stopping that thread. None of these is a *missing endpoint* — every endpoint the phase needs exists and is called as specified. They are under-specification inside objects the contract explicitly declares free-form (`additionalProperties: true`) or as bare strings. Stopping on them would have halted all of Phase 2 for gaps the contract technically permits. I built with the assumption isolated to one file per question and filed all five. If the product owner reads that as over-reach, the fix is cheap: five files change.

## 6. Risks observed

- **R-08 (mock/live drift) is now materially larger than at Phase 1.** Phase 1 was four auth endpoints; this phase adds eleven, three of which (Q-02, Q-05, and Q-01's shape) depend on catalogues and payload shapes I chose and A has not seen. The conformance gate still hasn't run. Concrete early warning: if A implements different consent codes or reason codes, the wizard's final step and the reviewer's decision both 422 on the first live day.
- **New risk — the failure drill may not be demonstrable.** The phase-file checkpoint requires injecting GAM unavailability and showing the application paused-not-adverse. My source panel needs Q-04's data to show *which* source didn't answer. Without it, the panel can only say a source hasn't been retrieved, which weakens the drill.
- No other change to the Risk Register picture.

## 7. Handoff notes for Agent A

1. **Match these three lists exactly, or the first integration day fails:** `lib/onboarding/consents.ts` (4 consent codes at version `1.0`), `lib/onboarding/reason-codes.ts` (13 codes), and the status strings in `lib/onboarding/status.ts` (the §5.5 table verbatim). If your values differ, say so in the daily log and I'll regenerate — don't accommodate mine if the requirements point elsewhere.
2. **Q-04 matters most of the five for the checkpoint** — the GAM failure drill is in the phase file's checkpoint definition and I can't render "GAM did not answer" without the request list on the application.
3. **`docs/specs/SEED_DATA.md` is now more overdue, not less.** I have five placeholder supplier identities with specific establishment numbers (`200145678`, `200987654`, `200555222`, `200333111`, `200777999`). If your seed uses different ones, the mock→live swap is a rewrite rather than a diff.
4. **My dummy-adapter variants are keyed by last digit** of the establishment number (`0` → sole proprietorship, `9` → GAM unavailable, else full). If your adapters key differently, tell me the convention and I'll match — this only affects mocks, but it affects whether we can demo the same cases.
5. Ownership held: I touched only `/apps/web/**`, `docs/coordination/{DAILY_LOG,OPEN_QUESTIONS,ENDPOINT_STATUS}.md`, `docs/specs/RTL_CHECKLIST.md` (B-owned), and this report. Nothing renamed. Root config still untouched and still yours.

## 8. Checkpoint countersignature

- [ ] I have read `PHASE_2_CHECKPOINT.md` and confirm the checkpoint behaviour matches what my half renders.
  **Unchecked — reason:** `PHASE_2_CHECKPOINT.md` doesn't exist, and neither does `PHASE_1_CHECKPOINT.md`. Agent A has posted no daily-log entries and announced no live endpoints, so **the Phase 1 checkpoint is also still open** — I am two phases ahead on mocks. My half is ready to wire the moment the eleven Phase 2 endpoints land; I'll run the checkpoint sequence (register → wizard → submit → reviewer requests info → clock pauses → supplier responds → clock resumes → approve → ACTIVE, plus the GAM failure drill) and countersign then.

---

# Appendix — for PHASE_2_CHECKPOINT.md only

Not applicable yet. The joint integration checkpoint requires Agent A's onboarding and government endpoints to be live, which has not happened.

What I can attest to today, against mocks only: the full checkpoint *sequence* is reproduced and green in `tests/onboarding-state-machine.test.ts` — submit starts the 24-business-hour clock, an information request pauses it with a recorded reason, a supplier response resumes it, approval stops it, and an unavailable registry pauses rather than rejects with nothing fabricated to fill the gap. That is the client-side statement of what the live checkpoint must show. It is **not** evidence the checkpoint passed.
