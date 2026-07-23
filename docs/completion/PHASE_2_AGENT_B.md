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

## 1b. Built before the merge, then reworked against it

This session's work was written on `b/phase1-shell`, which did **not** contain `docs/plan/11_PHASE_2_KICKOFF_B.md` — so the kickoff's Step 0 ("branch from merged `main`, not from `b/phase1-shell`") was never seen, and Phase 2 was built on a tree that predated the Phase 1 audit by eleven commits. The merge happened afterwards. Stating it plainly because it shaped everything below: the behavioural work survived, the infrastructure assumptions did not.

| Assumption that was wrong | Corrected to |
|---|---|
| Fixtures invented (names, establishment numbers, org ids) | S1 Al-Noor `20000101` / S2 Petra `20000102` / S3 Jordan Valley Foods `20000103`, org ids copied from `db/seed/0100_seed_dev.sql`, registry behaviour per `GOV_DUMMY_DATA.md` §2 |
| Adapter variants keyed off my own "last digit" convention | The frozen §5 injection keys — `90000001` UNAVAILABLE, `90000002` NOT_FOUND, `90000003` PARTIAL |
| Two invented personas for the conditional/ineligible screens | Dropped. They would have failed `data.spec.ts`, which reads the seed SQL. Added `platform-reviewer` (Maha Darwish) instead — seeded, and the only role `decide` accepts |
| Handlers registered unconditionally with ad-hoc error codes | `mockOnly()` + `passthrough()` so all ~~14~~ **16** (*audit correction: 4 Phase-1 + 12 Phase-2*) honour the mock/live map, with the canonical envelope (`VALIDATION_FAILED`, `NOT_FOUND`, `INSUFFICIENT_ROLE`, `INVALID_STATE_TRANSITION`) |
| `useMyApplication` keyed off `me.activeOrganizationId` | `activeOrganizationId` from `useSession()` — the audit showed deriving it from `/auth/me` is circular and leaves the header unset |
| Test runner: `node:test` in a `tests/` directory | vitest, colocated `*.spec.ts`, matching the runner that already existed on `main` |
| My questions numbered Q-01…Q-05 | Renumbered Q-05…Q-09 — `main` already had Q-01…Q-04. Updated in every code comment that cites one |

I repeated, in the Phase 2 fixtures, the exact defect the audit had just found in the Phase 1 ones: inventing identities instead of copying them. The lesson the audit drew — that the shared identity list only pays off if the values are copied — applies to every fixture I write, not just the ones that existed when it was written.

## 2. Endpoints / screens

All Phase 2 endpoints remain `mock`. Agent A's half is further along than my pre-merge report assumed — Phases 0 and 1 are complete, audited and merged, and the four auth endpoints serve locally against hosted Supabase — but A's own instruction is explicit that nothing flips until a **deployed public URL** is announced, which has not happened. `ENDPOINT_STATUS.md` and `lib/api/endpoint-status.ts` both record which screen consumes each endpoint, so every flip has a specific same-day smoke target.

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

Two mock handlers exist with no consuming screen: `POST /government/lookup` (nothing triggers a manual re-query yet) and `GET /government/requests/{id}` (the source panel reads the list on the application instead — Q-08). Both noted in `ENDPOINT_STATUS.md` rather than left to look consumed.

## 3. Tests added

Written on vitest, the runner that arrived with the merge. (My pre-merge version used `node:test`; it was migrated rather than kept, so there is one runner in the repo.)

| Test / suite | Covers | Status |
|---|---|---|
| `lib/mocks/onboarding-state-machine.spec.ts` (8 tests) | §5.5 clock transitions: submit starts (24h), info-request pauses **with reason**, response resumes, approval stops; ZM-SON-010 unavailable-source pauses and is never adverse; **`90000001` vs `90000002` stay distinguishable** — the "didn't answer" / "answered, found nothing" pair that is the fourth defining behaviour; D-04 bootstrap idempotency | ✅ |
| `lib/onboarding/onboarding-domain.spec.ts` (19 tests) | Clock-state table incl. server-flag override and unknown-status fallback; SLA breakdown/clamping; **ZM-SON-010 + ZM-GOV-003 neutral-tone assertion** (the two states most likely to be miscoloured by a later edit); ZM-SON-011 financing gate; Q-05 government normalization incl. bare values, blanks, arrays and malformed payloads; ZM-SON-013 sole-proprietorship detection; IBAN validation per failure mode; ZM-SON-012 consent completeness | ✅ |
| `scripts/check-i18n-parity.mjs` (`npm run check:i18n -w web`) | RTL checklist rule #8 — no key in one locale only (258 keys, both) | ✅ |

**38/38 vitest passing** — my 27 plus main's 6 seed-parity and 5 SessionProvider tests, which both still pass with my additions (that is what confirms the `platform-reviewer` persona is genuinely in the seed). `next build`, `tsc --noEmit`, and `eslint` clean in `web` and root-wide.

**Invariants:** none of INV-1..13 are frontend-owned at Phase 2 (they land in Phases 3–9 per Master Plan 5.4–5.6). The neutral-tone test above is the closest Phase 2 equivalent and is green. No invariant scheduled for this phase is untested.

## 4. Deviations and carry-overs

- **The SLA figure does not tick down between fetches.** The tracker renders the server's `slaRemainingBusinessSeconds` verbatim rather than running a client-side countdown. Deliberate: the business calendar (Sun–Thu 08:00–17:00 Amman + holidays) lives server-side with `sla_clock_events` as the ledger, and a browser countdown would drift from it — worse, a *paused* clock that appeared to keep running would actively misinform. Documented in `components/onboarding/SlaTracker.tsx`.
- **Built against a documented assumed shape for `governmentData`.** The contract types it `additionalProperties: true`, which cannot drive a source badge. Rather than stop the whole phase (hard rule 1), the assumption is isolated in exactly one adapter (`lib/onboarding/government.ts`) that degrades to a badge-less read-only render for any other shape, and the gap is filed as **Q-05**. No endpoint was invented and no response is reshaped to hide a gap. Same pattern for Q-07 (pause reason inferred from status, server field preferred when it appears) and Q-08 (source panel falls back to reconstructing rows, showing unseen sources as "not yet retrieved" rather than pretending).
- **Provisional catalogues shipped for reason codes (Q-06) and consent types (Q-09).** Both are client-supplied values with no enum in the contract and no catalogue anywhere in the frozen pack. They are transcriptions of ZM-SON-012/013 and §5.2 respectively, in `lib/onboarding/{reason-codes,consents}.ts`. **Agent A's accepted values must match these or `decide`/`consents` will fail validation at integration** — this is the most likely single point of failure at the checkpoint.
- **Phase 1 carry-overs closed by the merge, not by me:** the test runner, the npm workspace, the Supabase project and the seed identity list all arrived on . My contribution was to stop duplicating them — the  runner and  directory I had added are gone.
- **The identity carry-over is resolved.**  existed all along; my Phase 1 report said it did not, and that error propagated into a second set of invented fixtures this phase before the merge caught it (§1b).
- **Supplier's own seeded application starts as ** so the full checkpoint sequence is drivable by persona-switching rather than only inspectable.
- **Two screens have no seeded route to them.**  is reachable only by having the reviewer persona decide that way (which does demonstrate it), and the ineligibility screen needs a sole-proprietorship identity that the frozen list does not contain — filed as **Q-10**, using  as a local placeholder meanwhile. I did not add either to : that file is A's.
- **One RTL item logged, not fixed:** the `←` back-link on the application detail screen is a literal character and doesn't mirror (checklist rule #5). Recorded in `RTL_CHECKLIST.md` for the Phase 9 pass, which needs an icon system anyway.

## 5. Open questions raised

Six, all filed to `OPEN_QUESTIONS.md` this session, all **OPEN**. Numbered Q-05..Q-10 because `main` already held Q-01..Q-04:

| Ref | Subject | Blocking? |
|---|---|---|
| Q-05 | `governmentData` has no per-field provenance shape, but ZM-GOV-002 + the brief require a source badge and retrieval date | Not blocking — isolated adapter, degrades safely |
| Q-06 | No structured catalogue for `decisionReasonCode` | Not blocking — provisional list shipped |
| Q-07 | `slaPaused` carries no reason, but "paused **with reason**" is a phase-file requirement | Not blocking — inferred from status |
| Q-08 | No way to list an application's government lookups, so the per-source `sourceAvailable` panel has no ids | Not blocking — but **the GAM-unavailable failure drill in the checkpoint needs this** |
| Q-09 | Consent types/versions are client-supplied with no catalogue | Not blocking — provisional catalogue shipped |
| Q-10 | No sole-proprietorship identity or injection key in `GOV_DUMMY_DATA.md`, which ZM-SON-013 needs | Not blocking — `90000006` used as a local placeholder |

Judgement call worth stating plainly: hard rule 1 says a contract gap means stopping that thread. None of these is a *missing endpoint* — every endpoint the phase needs exists and is called as specified. They are under-specification inside objects the contract explicitly declares free-form (`additionalProperties: true`) or as bare strings. Stopping on them would have halted all of Phase 2 for gaps the contract technically permits. I built with the assumption isolated to one file per question and filed all six. If the product owner reads that as over-reach, the fix is cheap: six files change.

## 6. Risks observed

- **R-08 (mock/live drift) is now materially larger than at Phase 1.** Phase 1 was four auth endpoints; this phase adds ~~eleven~~ **twelve** (*audit correction*), three of which (Q-06, Q-09, and Q-05's shape) depend on catalogues and payload shapes I chose and A has not seen. Concrete early warning: if A implements different consent codes or reason codes, the wizard's final step and the reviewer's decision both 422 on the first live day. The conformance gate now compares paths, verbs **and success status codes** — but not request bodies or enum values, so it would not catch any of the three.
- **R-08 also materialised in a second form this session, and tooling caught it rather than I did:** I built Phase 2 on a pre-audit branch and reproduced the invented-fixture defect (§1b). What caught it was `data.spec.ts` reading the seed SQL. The generalisable lesson is that fixture drift needs a test rather than diligence — and that a worktree can silently sit eleven commits behind the branch a kickoff assumes.
- **New risk — the failure drill may not be fully demonstrable.** The phase-file checkpoint requires injecting registry unavailability and showing the application paused-not-adverse. My source panel needs Q-08's data to name *which* source went quiet; without it the panel can only say a source has not been retrieved, which weakens the drill. (Note: the phase file says GAM, while `GOV_DUMMY_DATA.md` §2 assigns the unavailable-source scenario to S3's **ISTD**. My fixture follows the identity file. Either serves the drill, but the two documents should agree — raised with A in the daily log rather than filed as a question, since nothing structural turns on it.)
- No other change to the Risk Register picture.

## 7. Handoff notes for Agent A

1. **Match these three lists exactly, or the first integration day fails:** `lib/onboarding/consents.ts` (4 consent codes at version `1.0`), `lib/onboarding/reason-codes.ts` (13 codes), and the status strings in `lib/onboarding/status.ts` (the §5.5 table verbatim). If your values differ, say so in the daily log and I'll regenerate — don't accommodate mine if the requirements point elsewhere.
2. **Q-08 matters most of the five for the checkpoint** — the GAM failure drill is in the phase file's checkpoint definition and I can't render "GAM did not answer" without the request list on the application.
3. **S3 Jordan Valley Foods needs an organization id.** Its name and establishment number are frozen in `GOV_DUMMY_DATA.md` §2, but that table marks it "no (Phase 1 seed)" and it is not in `0100_seed_dev.sql`. I use the placeholder `0e000000-0000-4000-8000-000000000007`, named `ORG_JORDAN_VALLEY_PENDING_SEED` in `onboarding-store.ts` — the single value in that file needing reconciliation when you seed it.
4. **My mock adapter now keys off your frozen §5 injection keys** (`90000001` UNAVAILABLE, `90000002` NOT_FOUND, `90000003` PARTIAL), so the same input misbehaves the same way on both sides. The one exception is Q-10: there is no key for a sole proprietorship and ZM-SON-013 needs one. I use `90000006` locally; pick whatever you prefer and I will follow.
5. **I added one persona to `lib/mocks/data.ts`** — `platform-reviewer` (Maha Darwish), seeded, because `decide` requires `PLATFORM_SUPPLIER_REVIEWER` and no existing fixture held it. `data.spec.ts` passes with it.
6. Ownership held: I touched only `/apps/web/**`, `docs/coordination/{DAILY_LOG,OPEN_QUESTIONS,ENDPOINT_STATUS}.md`, `docs/specs/RTL_CHECKLIST.md` (B-owned), and this report. I did **not** edit `GOV_DUMMY_DATA.md` or anything under `db/` — the Q-10 addition is a request, not a change. Nothing renamed.

## 8. Checkpoint countersignature

- [ ] I have read `PHASE_2_CHECKPOINT.md` and confirm the checkpoint behaviour matches what my half renders.
  **Unchecked — reason:** `PHASE_2_CHECKPOINT.md` does not exist. Neither does `PHASE_1_CHECKPOINT.md`: Agent A's half is built, audited and merged, but the API is **not deployed to a public URL**, so the joint Phase 1 checkpoint is still unrun and every endpoint stays `mock`. My half is ready to wire the moment the eleven Phase 2 endpoints land; I will run the sequence (register → wizard → submit → reviewer requests info → clock pauses → supplier responds → clock resumes → approve → ACTIVE, plus the unavailable-registry drill) and countersign then.

---

# Appendix — for PHASE_2_CHECKPOINT.md only

Not applicable yet. The joint integration checkpoint requires Agent A's onboarding and government endpoints to be live, which has not happened.

What I can attest to today, against mocks only: the full checkpoint *sequence* is reproduced and green in `lib/mocks/onboarding-state-machine.spec.ts` — submit starts the 24-business-hour clock, an information request pauses it with a recorded reason, a supplier response resumes it, approval stops it, and an unavailable registry pauses rather than rejects with nothing fabricated to fill the gap. That is the client-side statement of what the live checkpoint must show. It is **not** evidence the checkpoint passed.
