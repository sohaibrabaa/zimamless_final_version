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

## Q-01 — `SupplierApplication.governmentData` has no per-field provenance shape
Raised by: Agent B, 2026-07-23, blocking: not blocking (Phase 2 renders defensively — see below)
Question: `03_API_CONTRACT.yaml` L1375–1378 types `governmentData` as `type: object, additionalProperties: true` — free-form. But `ZM-GOV-002` requires every field to carry `value`, `source`, `retrievedAt`, `verificationStatus`, `evidenceRef`, `sourceReference`, and the brief (§5 "Government fields") and `PHASE_2` both require B to render each field read-only **with a source badge (CCD/ISTD/GAM) and retrieval date**. A free-form object does not tell B where in the payload the source/timestamp for a given field lives, so two independent implementations will disagree.
Options considered:
1. Contract stays free-form; A and B agree a normalized shape in the daily log (not binding, drifts).
2. Overlay amendment types `governmentData` as `{ [fieldName]: { value, source, retrievedAt, verificationStatus, evidenceRef?, sourceReference? } }` — a direct encoding of ZM-GOV-002, additive only (the base schema already permits it since `additionalProperties: true`).
3. Drop provenance from the application payload and have the UI join `GET /government/requests/{id}` per source — needs a request-id list on the application, which the contract also does not provide (see Q-04).
Recommendation: **Option 2.** It is additive (any object satisfying it already satisfies the frozen schema), it is a literal transcription of ZM-GOV-002, and it is the only option that makes the source badge deterministic.
Interim behaviour (does not pre-empt the ruling): B parses `governmentData` through a single adapter, `apps/web/lib/onboarding/government.ts`, which accepts the Option-2 shape and degrades to a value-only, badge-less render for anything else. If the ruling differs, exactly one file changes.
Needed by: Phase 2 integration checkpoint
Status: OPEN

## Q-02 — No structured catalogue for `decisionReasonCode`
Raised by: Agent B, 2026-07-23, blocking: not blocking (reviewer form ships with a documented provisional list)
Question: `POST /onboarding/applications/{id}/decide` takes `reasonCode: { type: string }` with no enum, and `SupplierApplication.decisionReasonCode` is likewise a bare string. `ZM-SON-012` enumerates six hard-rejection conditions and `ZM-SON-013` adds sole-proprietorship ineligibility, but no codes are defined anywhere in the frozen pack. The reviewer decision form (Phase 2, B) has to render a fixed picker, and the supplier-facing rejection screen has to map a code to a localized, non-pejorative explanation — both need the same catalogue as A's validation.
Options considered:
1. Free text — rejected: `ZM-SON-013` requires a *recorded* structured reason and the supplier message must be localizable, which free text is not.
2. Fix the catalogue in `DECISIONS.md` (7 rejection codes from ZM-SON-012/013 + conditional-approval and information-required codes) and have both agents key off it.
3. Add `GET /admin/reason-codes` — new endpoint, and B is not permitted to invent one.
Recommendation: **Option 2** — a decisions-log catalogue, no contract change needed since the field is already `string`.
Interim behaviour: B ships the provisional list in `apps/web/lib/onboarding/reason-codes.ts`, derived verbatim from ZM-SON-012/013, with EN+AR supplier-facing copy. A's accepted values must match or the decide call will 422 at integration.
Needed by: Phase 2 integration checkpoint
Status: OPEN

## Q-03 — `slaPaused` carries no pause reason, so the required "paused with reason" UI has no source
Raised by: Agent B, 2026-07-23, blocking: not blocking (reason is inferred from `status`)
Question: `ZM-SON-009` requires the supplier to see remaining SLA time **and current state at all times**; `PHASE_2_ONBOARDING_GOVERNMENT.md` (B tasks) requires "paused state **with reason**", and specifically that `GOVERNMENT_SERVICE_UNAVAILABLE` renders as paused-not-adverse. `SupplierApplication` provides `slaPaused: boolean` and `slaRemainingBusinessSeconds` but no reason field, while `ZM-SON-008` says every pause/resume is recorded with timestamp, reason, and actor server-side. The reason exists in `sla_clock_events` and is not exposed.
Options considered:
1. Infer the reason from `status` — `INFORMATION_REQUIRED` → awaiting your response, `GOVERNMENT_SERVICE_UNAVAILABLE` → source did not answer. Works for the two states §5.5 marks as pausing, but silently mislabels any future pause reason.
2. Additive optional field `slaPausedReason: string` (+ optional `slaPausedAt`) on `SupplierApplication`.
Recommendation: **Option 2**, with Option 1 as the fallback render when the field is absent.
Interim behaviour: B implements Option 1 keyed off `status` and reads `slaPausedReason` when present, so no change is needed if the field lands.
Needed by: Phase 2 integration checkpoint
Status: OPEN

## Q-04 — No way to list the government lookups belonging to an application
Raised by: Agent B, 2026-07-23, blocking: not blocking (per-source panel driven from `governmentData`)
Question: `GET /government/requests/{id}` fetches one lookup by id, and `POST /government/lookup` returns one. Nothing returns the set of lookups performed for an application, so the supplier/reviewer per-source panel (CCD / ISTD / GAM, each with its own `sourceAvailable`, `status`, `retrievedAt`, `validUntil` — required by `ZM-GOV-003` and by the phase-2 failure drill where GAM is injected unavailable) has no id to fetch. The application payload does not include the request ids either.
Options considered:
1. Additive `governmentRequests: GovernmentRequest[]` on `SupplierApplication` (or on the `GET .../applications/{id}` response only).
2. Additive `GET /onboarding/applications/{id}/government-requests`.
3. Derive per-source availability from `governmentData` alone — loses `sourceAvailable` for a source that returned nothing at all, which is exactly the `ZM-GOV-008` "source did not answer" signal that must not read as adverse.
Recommendation: **Option 1** — one round trip, and it keeps the reviewer detail screen a single GET.
Interim behaviour: B's `GovernmentSourcePanel` reads `application.governmentRequests` when present and otherwise reconstructs one row per source seen in `governmentData`, rendering unseen sources as a neutral "not yet retrieved" — never as adverse. Option 3's weakness is therefore visible in the UI, not hidden.
Needed by: Phase 2 integration checkpoint (the GAM-unavailable failure drill cannot be demonstrated without it)
Status: OPEN

## Q-05 — Consent types and versions are supplied by the client with no catalogue
Raised by: Agent B, 2026-07-23, blocking: not blocking (provisional catalogue in the wizard)
Question: `POST /onboarding/applications/{id}/consents` requires `consentType`, `consentVersion`, `granted` per item, but nothing tells the client which consents are required, what their current versions are, or what text to display. §5.2 names four categories ("lookup and sharing authorization; terms; privacy; declarations") without codes or versions. Submitting an unrecognised `consentType`/`consentVersion` will fail validation server-side; `ZM-SON-012` also makes "refusal of essential consents" a hard rejection, so the client must know which ones are essential.
Options considered:
1. Catalogue fixed in `DECISIONS.md` (codes + current version + EN/AR copy + essential flag), both agents key off it.
2. Additive `GET /onboarding/consent-types`.
Recommendation: **Option 1** for the competition build — the set is static and versioned by document revision, not by runtime state.
Interim behaviour: `apps/web/lib/onboarding/consents.ts` holds the provisional four codes at version `1.0`, all flagged essential per ZM-SON-012, with EN+AR copy. A's accepted set must match.
Needed by: Phase 2 integration checkpoint
Status: OPEN
