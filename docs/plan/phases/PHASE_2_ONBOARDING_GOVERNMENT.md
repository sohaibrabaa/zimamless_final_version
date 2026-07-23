# Phase 2 — Onboarding + Government (A) ∥ Onboarding UI (B)

**Objective:** a supplier goes from registration to an APPROVED, ACTIVE organization decided by a platform reviewer, with the 24-business-hour SLA clock provably pausing and resuming, and government data flowing through dummy adapters with full provenance.

## Agent A tasks

- [ ] Org bootstrap per D-04 ruling: `POST /onboarding/register` (org + SUPPLIER_OWNER membership + draft application, exempt from org-context header).
- [ ] Applications CRUD + state machine (`DRAFT → … → APPROVED | APPROVED_CONDITIONAL | REJECTED`), incl. `APPROVED_CONDITIONAL` behaviour (login OK, financing actions blocked — ZM-SON-011).
- [ ] SLA clock: business calendar Sun–Thu 08:00–17:00 Asia/Amman + `business_calendar_holidays`; `sla_clock_events` on every start/pause/resume/stop; elapsed time reconstructible from events (ZM-SON-008); remaining-time computation for the UI.
- [ ] Government adapter interface + CCD/ISTD/GAM dummy adapters per `docs/specs/GOV_DUMMY_DATA.md`: deterministic by establishment number; full/partial/NOT_FOUND/UNAVAILABLE variants; simulated latency; failure injection; retry/timeout/circuit-breaker; `sourceAvailable` distinct from adverse results (ZM-GOV-008).
- [ ] Snapshot persistence (raw + normalized + hash + 90-day validity); `entity_field_values` provenance per field (ZM-GOV-001/002); self-declared never overwrites government (ZM-SON-004).
- [ ] Hard-rejection rules incl. sole-proprietorship ineligibility message (ZM-SON-012/013).
- [ ] Consents recording; information requests + `respond` (SLA pause/resume); reviewer `decide` endpoint with reason codes.
- [ ] `GET /onboarding/applications-list` (D-05, overlay path): supplier sees own; reviewer sees queue with status filter + pagination.
- [ ] `GOVERNMENT_SERVICE_UNAVAILABLE` state wiring: pause clock, never adverse.
- [ ] Seed: supplier applications in assorted states (incl. one paused on information-required) for B and the demo.

### Endpoints in scope (A)

`/onboarding/register`* · `/onboarding/applications-list`* · `/onboarding/applications` POST · `/onboarding/applications/{id}` · `…/submit` · `…/bank-account` · `…/consents` · `…/information-requests` · `…/respond` · `…/decide` · `/government/lookup` · `/government/requests/{id}`  (* = v3.1.0)

## Agent B tasks (mock-first, swap as A announces)

- [ ] Registration → org bootstrap flow (calls `/onboarding/register` when live).
- [ ] Onboarding wizard: establishment number → licence → consents → bank account (IBAN input with ownership evidence upload placeholder until Phase 3 documents land).
- [ ] **Government-derived fields read-only** with source badge (CCD/ISTD/GAM) + retrieval date — never editable inputs; blank fields rendered neutrally.
- [ ] SLA tracker: remaining business time, paused state with reason, `GOVERNMENT_SERVICE_UNAVAILABLE` shown as paused-not-adverse.
- [ ] Information-request inbox + response form (text + document attachment stub).
- [ ] `APPROVED_CONDITIONAL` state UI: banner + disabled financing actions.
- [ ] Platform portal: application review queue (filterable list), application detail with government data panel, decision form (approve / conditional / info-required / reject with reason code).
- [ ] Ineligibility screen (sole proprietorship) — clear, non-pejorative.

### Screens in scope (B)

Supplier: registration+bootstrap, onboarding wizard (4 steps), SLA tracker, info-request inbox, conditional-approval state. Platform: review queue, application detail, decision form.

## Ownership & collision guard

Disjoint trees as always. New shared surface this phase: `GOV_DUMMY_DATA.md` identities — owned by A; B consumes, requests changes via daily log.

## Dependencies

Phase 1 checkpoint (auth/context live) · D-04/D-05 rulings (v3.1.0 approved).

## Integration checkpoint

Live end to end on the deployed stack: register → wizard → submit (SLA starts) → reviewer requests information (clock pauses; supplier sees paused + reason) → supplier responds (clock resumes) → reviewer approves → org ACTIVE. Government fields render with CCD badge from a real dummy-adapter snapshot. Failure drill: inject **ISTD** unavailability (S3 Jordan Valley Foods — `GOV_DUMMY_DATA.md` §2 assigns the outage scenario to S3's ISTD; that identity file is authoritative, and this line originally said GAM in error) → application enters `GOVERNMENT_SERVICE_UNAVAILABLE`, clock paused, nothing rendered adverse.

## Definition of done

Checkpoint met; business-time unit tests (holiday spans, pause/resume reconstruction) green; `sourceAvailable=false` path tested; endpoints in `ENDPOINT_STATUS.md` flipped live with smoke confirmations.

## Effort

Agent A: 5–7 days · Agent B: 4–6 days.

## Completion reports

`docs/completion/PHASE_2_AGENT_A.md` · `PHASE_2_AGENT_B.md` · `PHASE_2_CHECKPOINT.md`.
