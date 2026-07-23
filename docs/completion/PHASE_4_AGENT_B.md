# Phase 4 Completion Report — Agent B

**Phase:** 4 — Risk, Trust Score, and ML (A-heavy; B light) — plus a Phase 5 head start
**Agent:** B (frontend)
**Sessions spent:** 1 (planned: 1–2 days on risk components, remainder on Phase 5 screens)
**Dates:** 2026-07-23 → 2026-07-23
**Phase file:** `docs/plan/phases/PHASE_4_RISK_ML.md` (+ `PHASE_5_MARKETPLACE_OFFERS.md` for the head start)

Agent A had not started Phase 4 at the start of this session (no daily-log entry, no `ML_DESIGN.md`) — expected, since the phase file scopes B's Phase 4 work as light and mock-driven from day one.

## 1. Delivered vs. planned

### Phase 4 (primary)

| Planned item (phase file, Agent B tasks) | Status | Notes |
|---|---|---|
| `TrustScoreGauge` (composite + band) | ✅ done | `components/risk/TrustScoreGauge.tsx`. A single number and a band badge, deliberately not a needle gauge — a more "instrument-like" graphic reads as more authoritative than ZM-RSK-001's "decision support only" supports. |
| `ComponentBars` (five components) | ✅ done | `components/risk/ComponentBars.tsx`. Every bar fills the same colour regardless of value — a component score is a measurement, not an alert. |
| `FactorList` (positive/risk factors + reason codes) | ✅ done | `components/risk/FactorList.tsx`. All three are bare `string[]` in the contract; unrecognised values render as-is rather than being dropped. |
| **`dataAvailabilityPct` displayed separately, neutral styling, explanatory tooltip** | ✅ done | Lives in `ComponentBars`, below a divider, as a `Badge` (never a bar), with `dataAvailabilityNeutralTone()` — a function with no code path that can return a warning shade. The absence of such a path is asserted by a test, not just documented. |
| Disclaimer on every score display, both languages | ✅ done | `RiskPanel` renders `t("risk.disclaimer")` from the message catalogues, not `assessment.disclaimer` — see §4 for why. |
| Model version + calculation date + `mlUsed`/fallback display | ✅ done | `RiskPanel`, bottom card. `mlUsed === false` also renders the fallback reason and a distinct badge tone. |
| Synthetic-data limitation notice (ZM-RSK-016) | ✅ done | `t("risk.syntheticDataNotice")`, same card. |

**All five deliverables done**, composed into one `RiskPanel` (`components/risk/RiskPanel.tsx`) so every future consumer gets the disclaimer/version/fallback block automatically rather than having to remember to add it.

### Phase 5 head start (per the kickoff: "marketplace feed, offer form skeletons")

| Item | Status | Notes |
|---|---|---|
| Bank marketplace feed (`GET /marketplace/eligible`) | ✅ done, scoped as a stub | `app/[locale]/bank/marketplace/page.tsx`. Real content, real pagination — but a **static two-listing set**, not A's real policy-filter eligibility engine, which does not exist yet. Flagged in the UI copy and here. |
| Bank underwriting view (`GET /marketplace/listings/{id}`) | ✅ done | `app/[locale]/bank/marketplace/[id]/page.tsx`. Supplier + buyer identity, invoice data, documents, the full `RiskPanel`, decision-support disclaimer (inherited from `RiskPanel`), and the ZM-CON-018 double-financing notice. This is where the Phase 4 components get their first real consuming screen, per the phase file's own framing ("used in Phase 5's underwriting view"). |
| Offer form skeleton | ✅ done, deliberately inert | `app/[locale]/bank/marketplace/[id]/offer/page.tsx`. Every field the phase file names — transaction type, recourse type, gross + deductions, conditions builder, validity picker — with real catalogues (`lib/marketplace/offer-domain.ts`) and plain-language explanations. **Submission is not wired to a mock endpoint**; the button is disabled with a stated reason. See §4 for why nothing was faked here. |

Not attempted, and explicitly out of this session's scope: listing activation, policy-filter configuration, the approval queue, "my offers", and the offer comparison screen. Those remain Phase 5's real deliverable.

## 2. Endpoints / screens

| Endpoint | Status | Consumed by |
|---|---|---|
| `GET /transactions/{id}/risk` | mock | Supplier transaction detail (own score) and bank underwriting view |
| `GET /admin/risk-models` | mock, handler not implemented | No screen — not B's Phase 4 scope |
| `POST /admin/risk-models` | mock, handler not implemented | No screen — not B's Phase 4 scope |
| `GET /marketplace/eligible` | mock, head start | Bank marketplace feed |
| `GET /marketplace/listings/{id}` | mock, head start | Bank underwriting view + offer form skeleton |
| `POST /transactions/{id}/listing` | mock, not implemented | No screen — real Phase 5 work |

`endpoint-status.ts` and `ENDPOINT_STATUS.md` both updated with these notes.

## 3. Tests added

| Suite | Covers | Result |
|---|---|---|
| `lib/risk/risk-engine.spec.ts` (20 tests) | **The INV-9 paired-fixture property**: identical inputs differing only in `sourceAvailability` produce byte-identical `components` and `compositeScore`, across every single-source-down permutation and the all-down case; the band never moves either. **`dataAvailabilityNeutralTone()` always returns `"neutral"`**, contrasted against `bandTone()` which legitimately can return `"danger"`. AS-05 band-threshold mapping (three concrete scenarios + a structural no-gaps/no-overlaps check — see §4 for why the table wasn't parameterised by raw score). ZM-RSK-007: buyer liquidation, short tenor, and a REVIEW verification result each *legitimately* lower a component. ZM-RSK-017: `mlFallbackReason` only travels when `mlUsed` is false, and the fallback flag never changes the components it's attached to. Model version/timestamp stamping. Reason-code presence and the `PARTIAL_GOVERNMENT_DATA` trigger. Presentation helpers (`bandLabelKey`, `modelModeLabelKey`, `hasFallback`) including their unknown/undefined fallbacks. | ✅ |
| `lib/mocks/risk-store.spec.ts` (5 tests) | The assembly `GET /transactions/{id}/risk`'s handler actually calls, as opposed to the pure engine in isolation: `undefined` for an unsubmitted or nonexistent transaction; `dataAvailabilityPct` correctly read off S1's real Phase 2 onboarding fixture (100%, all three sources answered) as cross-store wiring; the same fallback-to-fully-available default for an organization with no onboarding application at all (a bank org, not just an unqueried supplier); the dev-only risk-mode toggle flips `mlUsed`/`mlFallbackReason` without touching `components`. | ✅ |

**116/116 vitest passing** (25 new; the 91 from Phase 3 all still green). `tsc --noEmit`, `eslint`, `next build`, and `check:i18n` clean in `web` and root-wide across all three workspaces.

The phase file's definition of done names two things specifically: **INV-9 test in CI** and **version-immutability test in CI**. INV-9 is fully covered from the client side — see above. Version immutability is **not fully covered here and cannot be**: ZM-RSK-010's guarantee ("historical scores MUST NOT change when a new version is activated") is a server-side persistence property — a score computed and stored under version N staying frozen when version N+1 activates. What this session covers is the client-visible half only: recomputing with the same inputs at two different timestamps does not retroactively alter either result's `calculatedAt` or `components` (`risk-engine.spec.ts`, "two calls... keep their own timestamp"). The real invariant is Agent A's to test against actual persisted rows once `RiskModelVersion` activation exists.

## 4. Deviations and design decisions

- **The disclaimer is sourced from i18n, not from `assessment.disclaimer`.** ZM-RSK-002 requires the disclaimer "in both languages," and the contract's `disclaimer` field is a bare string with no locale guarantee — the same class of gap as Q-03 (money digit set) and every other compliance-adjacent string in this codebase (consent text, declaration text, ineligibility copy), all of which are sourced from the message catalogues rather than trusted to arrive pre-localized. **Not filed as a new open question** — unlike Q-05/Q-06/Q-09/Q-13, satisfying ZM-RSK-002 is unambiguously the client's job regardless of what the API sends, so there is no ambiguity for a product owner to rule on, only a design decision, documented at the call site in `RiskPanel.tsx`.
- **`positiveFactors`, `riskFactors`, and `reasonCodes` are free-form strings with no catalogue, and deliberately stay that way rather than getting a provisional one.** This is a genuine difference from Q-06 (`decisionReasonCode`) and Q-13 (declaration version): those are **request bodies the server validates**, so a client/server mismatch on the accepted set is a 422 that breaks a user flow — which is why both got provisional catalogues and a heads-up to A. Risk factors are **response-only display text** with no validation on the way back; a code this build doesn't recognise renders as-is (`FactorList`'s `translateOrRaw` fallback) rather than being dropped or breaking anything. A mismatch here is cosmetic, not a 422, so there is nothing to pre-align and no question to file. Worth restating for whoever builds Phase 4's real engine: nothing needs to match my strings, but a translation table exists at `messages/{en,ar}.json` → `risk.factor.*` / `risk.reasonCode.*` if it's useful to reuse.
- **The marketplace feed and underwriting view are a head start, not Phase 5's real deliverable, and say so in the UI.** The feed returns the same static two listings to every bank persona — there is no policy-filter matching, because Agent A's eligibility engine (`bank_eligibility.rules_applied`, phase file A tasks) doesn't exist yet. The feed's intro copy states this plainly rather than implying the list is already filtered.
- **The offer form computes and displays nothing that isn't authoritative.** The phase file calls for "commission + listing fee server-computed read-only; net previewed live but always reconciled to the server figure." This session has no server to reconcile against — `POST /listings/{id}/offers/create` is not implemented — so rather than fabricate an estimated commission rate or a preview net figure, the form names the two server-computed fields with a note that they are computed on creation and shows no number. Inventing even a labelled "estimate" would have been the same defect the Phase 1, 2, and 3 audits each caught in a different form (invented fixtures, invented catalogues, invented invoice identities) one field earlier — a plausible-looking number nothing authoritative produced. Submission stays disabled with a stated reason rather than silently doing nothing on click.
- **A dev-only ML-outage toggle (`RiskModeToggle`) exists for the checkpoint's first drill** ("stop the ML container → recompute → rules-only score with visible degraded flag") since there is no ML container to stop against MSW. It reads/writes `localStorage` directly inside the MSW handler rather than through a header, unlike the existing persona picker: MSW's browser-mode resolvers execute in the page's own JS realm, so this works, and there is no server-side counterpart for the flag to eventually become — flipping the switch changes what the *mock* returns, not what a header tells a real API. Documented at the point of departure from the persona-header pattern in `lib/mocks/risk-mode-store.ts`.
- **Risk display was also added to the supplier transaction detail**, not only the bank underwriting view. Nothing in §9 restricts a supplier from seeing their own score, ZM-RSK-013's bank-facing exclusions don't apply to the supplier's own transaction, and it gave the risk components a second, independent consuming screen without waiting for the marketplace scaffolding to exist — useful given A hadn't started Phase 4 yet.

## 5. Open questions raised

None. See §4 for why the two candidates (the disclaimer's locale, the factor/reason-code vocabulary) don't rise to a filed question — the first is unambiguously the client's responsibility regardless of the API, and the second has no validation-failure consequence to pre-empt.

## 6. Risks observed

- **The marketplace feed's honesty depends on its copy staying accurate.** "Full policy-filter matching lands with the rest of Phase 5" is correct today; if the real Phase 5 session ships eligibility filtering but a screen still shows the old copy, it becomes a lie by omission rather than a stub notice. Flagging so the real Phase 5 session remembers to remove or update it, not just add the filtering.
- **The risk engine's demo formula cannot produce a `CRITICAL` band.** With two fixed baseline components (Supplier Verification 74, Data Confidence 70 — deliberately held constant so neither can be driven by `sourceAvailability`, per INV-9), the composite score has an effective floor around 29 even when every variable component is at its minimum, which sits in `HIGH`, not `CRITICAL`. This is fine for a client-side stand-in whose only job is to prove the shape and the INV-9 property, but it means the demo cannot show a `CRITICAL`-band listing until Agent A's real engine replaces it — worth knowing before someone goes looking for one in the mock data for a screenshot.
- **R-08 (mock/live drift) is now four phases deep with zero live endpoints.** Phase 1 was 4, Phase 2 added 12, Phase 3 added 15, this phase adds 5 more (2 risk + 3 marketplace/offer-adjacent) — 36 mocked endpoints, still nothing deployed. Unchanged risk, restated because it keeps growing.

## 7. Handoff notes for Agent A

1. **`riskFor Transaction` is a demo stand-in, not a spec.** `lib/risk/risk-engine.ts`'s formulas (fixed baselines for Supplier Verification/Data Confidence, simple linear penalties for the rest) exist only to produce a plausible, INV-9-correct shape for the UI to render against. Nothing about them needs to survive contact with your real scoring engine.
2. **The one property worth preserving exactly**: `dataAvailabilityPct` must be computable from a wholly separate input than the five components, with no shared code path — that separation is what ZM-RSK-005/006/008 actually require, and it's asserted by a CI test on both the pure engine and the mock-store assembly layer.
3. **`positiveFactors`/`riskFactors`/`reasonCodes` have a translation table already** at `messages/{en,ar}.json` under `risk.factor.positive.*`, `risk.factor.risk.*`, `risk.reasonCode.*` (4 entries, e.g. `PARTIAL_GOVERNMENT_DATA`, `BUYER_UNDER_LIQUIDATION`). Not a request to match them — `FactorList` renders any unrecognised string as-is — but reusing the keys avoids the client needing new translations for codes that mean the same thing yours will produce.
4. **The bank underwriting view (`GET /marketplace/listings/{id}`) and marketplace feed (`GET /marketplace/eligible`) are stubbed on my side with a static two-listing set** (`lib/mocks/marketplace-store.ts`) — supplier identities S1/S2, buyers B1/B2 from the frozen lists, invoice numbers `INV-2026-0001`/`INV-2026-0004` (the second is a **placeholder I invented**, flagged the same way the Phase 3 `MOCK-` invoice numbers were, since nothing in `EINVOICE_QR.md` §7 assigns a fourth listing-ready invoice). When your real listing/eligibility endpoints land, this whole file gets deleted rather than reconciled — it was never meant to model your engine, only to give the two head-start screens something to render.
5. Ownership held: touched only `/apps/web/**`, `docs/coordination/{ENDPOINT_STATUS,DAILY_LOG}.md`, and this report. Did not touch `/apps/api`, `/services/ml`, `/db`, or any completion report but my own.

## 8. Checkpoint countersignature

- [ ] Not run. `PHASE_4_CHECKPOINT.md` requires a live score on a deployed stack plus both drills (ML-container stop, ZM-RSK-005 government-outage). The API is still not deployed — unchanged since Phase 1, now four phases running. My half is ready to wire the moment `GET /transactions/{id}/risk` is live: flip the endpoint-status entry, point `RiskPanel` at the real response, and both checkpoint drills are demonstrable through the existing screens (the outage drill needs only a transaction whose supplier org has a government source marked unavailable, which Phase 2's S3 fixture already models on the onboarding side).

## 9. Next session's first task

Phase 5, in full: listing activation, real policy-filter eligibility, offer creation wired to a real (or at least fully-mocked) create endpoint with server-computed commission/listing fee, the approval queue, "my offers", policy-filter configuration, and — the phase file's own words — "the most important screen in the product," the supplier offer comparison. The marketplace feed, underwriting view, and offer-form skeleton built this session are a running start, not a substitute for that work.
