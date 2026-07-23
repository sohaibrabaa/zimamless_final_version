# Phase 2 Completion Report — Agent A

**Phase:** 2 — Onboarding + Government (A) ∥ Onboarding UI (B)
**Agent:** A (backend)
**Sessions spent:** 1 (planned: 5–7 days)
**Dates:** 2026-07-23 → 2026-07-23
**Phase file:** `docs/plan/phases/PHASE_2_ONBOARDING_GOVERNMENT.md`

> **Status: the backend half of Phase 2 is complete and verified against the
> hosted Supabase project.** All 13 endpoints in scope serve real traffic
> with real tokens, the full lifecycle was driven end to end, and 129
> automated checks pass.
>
> **The phase is NOT closed.** Its integration checkpoint requires the
> deployed stack, and the API is still not deployed — the same carry-over
> that opened this session. §8.

## 1. Delivered vs. planned

| Planned item | Status | Evidence |
|---|---|---|
| Org bootstrap per D-04: `POST /onboarding/register`, exempt from org context | ✅ done | 201 then 200 with identical ids on a real zero-membership user. Required a guard fix — §4.1. |
| Applications CRUD + state machine incl. `APPROVED_CONDITIONAL` (ZM-SON-011) | ✅ done | 11-state whitelist machine; `APPROVED_CONDITIONAL` maps to its own organization status, not ACTIVE-with-a-flag. 18 tests. |
| SLA clock: Sun–Thu 08:00–17:00 Asia/Amman + holidays; `sla_clock_events` on every start/pause/resume/stop; elapsed reconstructible (ZM-SON-008); remaining time for the UI | ✅ done | Elapsed is recomputed from events on every read; the column is a cache never read back. 39 tests. Live: a seeded PAUSE 3 business hours in reads back as exactly 21h remaining. |
| Government adapter interface + CCD/ISTD/GAM dummies; full/partial/NOT_FOUND/UNAVAILABLE; latency; failure injection; retry/timeout/circuit-breaker; `sourceAvailable` distinct (ZM-GOV-008) | ✅ done | 22 tests including the INV-9 pair. `sourceAvailable` is derived from a discriminated union, not set by adapters. |
| Snapshot persistence (raw + normalized + hash + 90-day validity); `entity_field_values` provenance (ZM-GOV-001/002); self-declared never overwrites government (ZM-SON-004) | ✅ done | Live snapshots with sha256 over canonicalized raw payload, `valid_until` = +90d. 13 provenance-carrying fields on a live application. |
| Hard-rejection rules incl. sole-proprietorship ineligibility (ZM-SON-012/013) | ✅ done | Live: S4 submits → `REJECTED`, reasonCode `SOLE_PROPRIETORSHIP_NOT_ELIGIBLE`, non-pejorative message asserted by test. |
| Consents; information requests + `respond` (SLA pause/resume); reviewer `decide` with reason codes | ✅ done | Full cycle driven live: request → PAUSE → respond → RESUME → approve → org ACTIVE. |
| `GET /onboarding/applications-list` (D-05): supplier sees own, reviewer sees queue + filter + pagination | ✅ done | Live: reviewer sees all 5, supplier sees 1; `?status=` filter verified. |
| `GOVERNMENT_SERVICE_UNAVAILABLE` wiring: pause clock, never adverse | ✅ done | Live: S3's ISTD outage → paused, `slaDeadlineAt: null`, no adverse content. The state has no transition to REJECTED at all. |
| Seed: applications in assorted states incl. one paused on information-required | ✅ done | `db/seed/0200_seed_phase2.sql`, applied. ~~Five applications spanning every interesting state~~ **Corrected by the Phase 2 audit:** the seed file inserts **2** applications with fixed ids; the other 3 in the queue are residue of live verification runs with random ids (per the seed's own §4 comment) — real rows, but not seeded fixtures. Plus 12 holidays. |
| **Deploy the API (carried from Phase 1)** | ⛔ **not done** | No hosting account. Everything else in the runbook executed and corrected — §4.4, §8. |

## 2. Endpoints — live smoke results

All against the hosted database from localhost, with real ES256 tokens.
Not on a public URL.

| # | Check | Result |
|---|---|---|
| 1 | `POST /onboarding/register`, zero-membership user | ✅ 201, org + membership + draft application |
| 2 | Same call again | ✅ **200** with identical ids (idempotent per the overlay) |
| 3 | Register an establishment number already held | ✅ 409 `CONFLICT` |
| 4 | `POST …/submit` (S5, all sources answer) | ✅ 200 → `UNDER_REVIEW`, deadline Mon 14:00 Amman — correctly across the Fri/Sat weekend |
| 5 | `POST …/submit` (S3, ISTD unavailable) | ✅ 200 → `GOVERNMENT_SERVICE_UNAVAILABLE`, paused, **no deadline**, nothing adverse |
| 6 | `POST …/submit` (S4, sole proprietorship) | ✅ 200 → `REJECTED` + reason code + non-pejorative message; org `REJECTED` |
| 7 | `POST …/decide` `INFORMATION_REQUIRED` | ✅ 200 → paused, `slaPausedReason: INFORMATION_REQUESTED` |
| 8 | `GET …/information-requests` as the supplier | ✅ the OPEN request |
| 9 | `POST …/respond` | ✅ 200 → `INFORMATION_RESUBMITTED`, clock resumed, deadline reappears |
| 10 | `POST …/decide` `APPROVED` | ✅ 200 → `APPROVED`, organization `ACTIVE`, clock STOPped |
| 11 | `GET /onboarding/applications-list` as reviewer / as supplier | ✅ 5 items / 1 item; `?status=` filter works |
| 12 | Supplier calls `…/decide` | ✅ 403 `INSUFFICIENT_ROLE` |
| 13 | Supplier reads another org's application | ✅ **404**, not 403 — no enumeration oracle |
| 14 | Re-submit a decided application | ✅ 409 `INVALID_STATE_TRANSITION` |
| 15 | `REJECTED` with no reasonCode | ✅ 422 `VALIDATION_FAILED` |
| 16 | `POST /government/lookup` `90000001` / `90000002` | ✅ `UNAVAILABLE`/`sourceAvailable:false` vs `NOT_FOUND`/`sourceAvailable:true` — **INV-9 over HTTP** |
| 17 | `POST /government/lookup` status code | ✅ 202 per the contract |
| 18 | Audit rows for every mutation | ✅ actor user, actor org, correlation id all non-null |
| 19 | `sla_clock_events` for the full cycle | ✅ `START → PAUSE → RESUME → STOP` |
| 20 | Seeded paused application read back | ✅ exactly 21 business hours remaining, reconstructed from events |

## 3. Tests added

| Suite | Covers | Result |
|---|---|---|
| `business-time.spec.ts` | Sun–Thu week, half-open 08:00–17:00 window, weekend/holiday spans, Friday submission, deadline round-trip | ✅ 23/23 |
| `sla-clock.spec.ts` | Event-sourced reconstruction, multi-pause histories, no-deadline-while-paused, breach floor, duplicate/stray/double events | ✅ 16/16 |
| `government.spec.ts` | **INV-9 paired fixture**, determinism, per-identity behaviour, retry/timeout/circuit-breaker, money-as-string | ✅ 22/22 |
| `application-state.spec.ts` | Transition whitelist, clock effect per transition, ZM-SON-011 mapping, hard-rejection rules | ✅ 18/18 |
| `auth.guard.spec.ts` (extended) | The bootstrap exemption, and that the exempt-mutation rule still bites without it | ✅ 21/21 |
| `money.spec.ts` (unchanged) | Phase 1 | ✅ 25/25 |

**129 tests, up from 47.** Plus `db:verify` 15/15 and the conformance gate
at 15/82 paths with no drift.

Invariant status:

- **INV-9 is proven, not asserted.** `90000001` and `90000002` are asserted
  to differ in `sourceAvailable`, in data availability (0 vs 1), and in
  whether they constitute a finding — at the adapter, through the
  resilience layer, and over HTTP. The risk-score half lands in Phase 3
  with the scoring engine; what is proven now is that the distinction
  survives the whole data path, which is the part Phase 3 will depend on.
- Phase 1 invariants unchanged and still green.

## 4. Deviations, and four real defects found by running things

### 4.1 `POST /onboarding/register` would have 403'd for every real user

The Phase 1 audit closed a hard-rule-6 hole by making org-context-exempt
*mutations* adopt the caller's sole membership and refuse multi-org users.
That is right for `PATCH /auth/language`. It is exactly wrong for
registration, where the caller has **zero** memberships by definition — so
the rule would have refused the one call whose entire purpose is to create
their first one.

The kickoff flagged this as something to keep in mind; it turned out to be
not a nuance but a hard failure of the phase's first endpoint. Fixed with an
explicit `@BootstrapsOrganization()` marker on that single route. The
handler then patches the request context with the organization it creates,
so the audit row still names an actor org and hard rule 6 holds — the same
pattern `/auth/context` already uses. Three guard tests, one of which
removes the marker and asserts the refusal returns, so the exemption cannot
quietly widen.

### 4.2 A Postgres parameter-type inference failure that typecheck could not see

The status `UPDATE` used `CASE WHEN $2 = 'SUBMITTED' THEN $5 END` inside a
`COALESCE`. Postgres infers an unanchored parameter in a `CASE` as `text`,
so the statement failed at runtime with *"COALESCE types timestamp with time
zone and text cannot be matched"* — while `tsc` and every unit test were
green. Every placeholder in that statement is now cast explicitly. This is
the Phase 1 lesson repeating: the defects that matter are the ones only
execution finds.

### 4.3 The phase's own integration checkpoint had no identity to run on

Every full-success supplier in `GOV_DUMMY_DATA.md` is already seeded as an
organization, so `POST /onboarding/register` correctly returns 409 for all
of them — and the checkpoint's register → submit → approve flow could not be
run at all. Added **S5 `20000105`**, deliberately not seeded as an org.
Similarly **S4 `20000104`** is the only sole proprietorship, without which
ZM-SON-013's ineligibility path had no fixture. Both announced in the daily
log; nothing renamed or renumbered, so Agent B's fixtures are unaffected.

### 4.4 `business_calendar_holidays` was empty

Not a code defect — a data one, and the more dangerous kind because it fails
silently. An empty holiday table means "no public holidays exist", so every
holiday branch in the SLA arithmetic was unreachable against real data while
passing its unit tests against injected sets. Seeded 12 holidays in
`0200_seed_phase2.sql`. The lunar Islamic dates are approximations and are
labelled as such in both the seed and the spec — the product owner should
replace them with the official calendar before non-demo use.

### Design decisions worth recording

- **`sourceAvailable` is derived from a discriminated union**, not a boolean
  an adapter sets. There is no constructible shape in which an unanswered
  source carries field data, so hard rule 7 cannot be violated by a future
  adapter author who has not read the rule.
- **A paused clock exposes no deadline.** Projecting one from "if it resumed
  now" would show the supplier a date that moves on every refresh.
- **Elapsed SLA time is recomputed from events on every read.** The
  `sla_elapsed_business_secs` column is written as a cache for SQL
  reporting and never read back; if the two ever disagree, the events win.
- **Business-time arithmetic uses Intl, not a fixed +03:00.** Jordan dropped
  seasonal time in 2022, so the constant is right today and would become
  silently wrong — an hour off for part of the year — if that changed.
- **A supplier reading another org's application gets 404, not 403**, on the
  same enumeration-oracle reasoning as the Phase 1 context codes.
- **`ENCRYPTION_KEY` is new** and required in production. IBANs are stored
  with `pgp_sym_encrypt`; a development fallback key exists so local setup
  stays one command, and the API refuses to boot in production without a
  real one.

## 5. Open questions raised

None new. Q-01 through Q-04 remain as they were; none blocked this phase.
Q-04 (`/auth/context`'s undeclared body) is still worth settling before
Phase 5, and this phase's endpoints were written to declare every body they
return, so the gate's body-comparison gap did not widen.

## 6. Risks observed

- **The deploy risk from Phase 1 has now materialized rather than being
  retired.** Phase 1 warned that meeting deployment during Phase 9 demo prep
  was the failure mode to avoid. Phase 2 has now also completed without it.
  Every phase that passes adds surface to the first deploy; this is the
  single largest risk on the project and it is not mine to close.
- **Verification depth is uneven.** The SLA and government layers have real
  unit coverage; the onboarding *service* is proven by live end-to-end runs
  rather than by automated integration tests. Those runs are reproducible by
  hand but are not in CI, so a regression in, say, the respond→resume path
  would not be caught automatically. Listed as a carry-over rather than
  claimed as covered.
- **No RLS policies were added for the Phase 2 tables** because they already
  exist — `0003` covered every tenant table. But the persona suite does not
  yet exercise `supplier_applications`, `sla_clock_events`, or
  `entity_field_values` **with rows in them**, which is the same limitation
  Phase 1 recorded for offers and settlements. Worth adding when Phase 3
  re-runs that suite.

## 7. Handoff notes for the other agent

Everything material is in the daily-log entry for 2026-07-23, which Agent B
should read in full. The six that most affect the UI (*audit correction: this
list said "five" while introducing six items*):

1. A paused SLA has **no** `slaDeadlineAt` — render the paused state and
   remaining time, never a date.
2. `GOVERNMENT_SERVICE_UNAVAILABLE` must not render as adverse. Branch on
   `sourceAvailable`, never on `status` alone.
3. `governmentData` values are `{value, sourceKind, source, retrievedAt}`
   objects — that is what the source badge reads. Render `GOVERNMENT`
   fields read-only.
4. `/onboarding/register` is 201 first time, 200 thereafter, and is the only
   route exempt from `X-Organization-Id`.
5. `submit`/`respond`/`decide` return 200; `/government/lookup` returns 202.
6. Two seeded applications have fixed ids (`0e200000-…-0001` APPROVED,
   `0e200000-…-0002` INFORMATION_REQUIRED + paused) — hard-code those. The
   other three in the queue have random ids and are not fixtures.

## 8. Checkpoint countersignature

- [ ] **Not run.** The phase file requires the checkpoint on the deployed
  stack, driven through the real UI: register → wizard → submit → reviewer
  requests information → supplier responds → approve → org ACTIVE, plus the
  GAM-unavailability failure drill.

  **Every one of those steps is proven server-side** — §2 checks 1–20 walk
  the exact sequence, including the failure drill, against the hosted
  database. What has not happened is the deployment and Agent B's browser.

  No `PHASE_2_CHECKPOINT.md` is filed and no tag exists, because the
  checkpoint as written has not happened. `PHASE_1_CHECKPOINT.md` likewise
  remains unfiled, for the same single reason.

  **Blocking item, unchanged since Phase 1 and not resolvable by me:**
  creating the hosting service requires an account I do not have. The
  runbook's §0, §1, §3 and §4 have now been executed for real against the
  production build and corrected where they were wrong (including two steps
  that would have made a healthy deployment read as broken), and
  `render.yaml` at the repo root reduces §2 to a single action once an
  account exists.

## 9. Next session's first task

Deploy, the moment a URL or an account is available: run the corrected
runbook §2, smoke it, write `PHASE_1_CHECKPOINT.md` and
`PHASE_2_CHECKPOINT.md`, tag both, and announce the URL so Agent B can flip
`ENDPOINT_STATUS.md`. If deployment is still blocked, the next most useful
work is automated integration tests over the onboarding service — the gap
named in §6 — rather than starting Phase 3 on top of two unverified phases.
