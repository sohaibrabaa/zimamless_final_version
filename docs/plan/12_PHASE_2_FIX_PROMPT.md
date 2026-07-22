# Phase 2 Fix Prompt

> Paste this into a single Claude Code session at the repo root on `main`
> (after the Phase 2 merge commit). One session, not parallel — most items
> are cross-half reconciliations. Every item was verified against code by
> the Phase 2 audit; none are speculative. The acceptance gate is at the end.

---

## PROMPT (copy from here)

You are working on the Zimmamless V3 monorepo on `main`, which now contains
both halves of Phase 2. An independent audit found the items below. Fix them
all, keep every existing test green (129 API + 38 web), and do not touch the
frozen files (`docs/02_DATABASE_SCHEMA.sql`, `docs/03_API_CONTRACT.yaml`).
Ownership boundaries are suspended for this session.

Context you need first: read `docs/completion/PHASE_2_AGENT_A.md` §7 and
`PHASE_2_AGENT_B.md` §7 — each half wrote handoff assumptions the other
never saw. This session is where they meet.

### Part 1 — Cross-half contract reconciliation (the point of this session)

1. **`governmentData` field shape (Q-05).** The server sends
   `{value, sourceKind, source, retrievedAt}` with `sourceKind ∈ GOVERNMENT |
   SELF_DECLARED | DERIVED`. The client (`apps/web/lib/onboarding/government.ts`)
   reads a `verificationStatus` field (`GOVERNMENT_VERIFIED | SELF_DECLARED |
   UNVERIFIED`) that the server never sends — so against live data every field
   would render, but the government/self-declared distinction (and therefore
   the source badge logic) silently degrades. Make the client read
   `sourceKind` with A's values, keep the tolerant fallback for unknown
   shapes, update the Q-05 tests, and close Q-05 in `OPEN_QUESTIONS.md`
   recording the server shape as the answer.
2. **Reason codes.** The server auto-emits `ENTITY_NOT_FOUND_IN_REGISTRY`,
   `SOLE_PROPRIETORSHIP_NOT_ELIGIBLE`, `REGISTRY_STATUS_<status>`, and
   `LICENCE_<status>`; the client's catalogue
   (`apps/web/lib/onboarding/reason-codes.ts`) is 13 different codes, and its
   ineligibility screen triggers on `ENTITY_TYPE_NOT_ELIGIBLE_V3` — a code
   the server never produces, so **the ZM-SON-013 ineligibility screen would
   never fire against the live API** (the `companyType` fallback path still
   works; the code path does not). Unify: (a) the client's ineligibility
   trigger recognises `SOLE_PROPRIETORSHIP_NOT_ELIGIBLE`; (b) merge the
   server's auto-emitted codes into the client catalogue with display copy;
   (c) the server validates *reviewer-supplied* `reasonCode` on `/decide`
   against the unified catalogue (422 `VALIDATION_FAILED` otherwise) — today
   it accepts any string, which is how this drift stayed invisible. Update
   Q-06 with the resolution.
3. **Consent types (Q-09).** The wizard sends
   `GOVERNMENT_LOOKUP_AUTHORIZATION`, `BANK_DISCLOSURE_AUTHORIZATION`,
   `TERMS_OF_SERVICE`, `PRIVACY_POLICY` @ version `1.0`; the server validates
   nothing and its seed uses a different vocabulary (`PLATFORM_TERMS`,
   `GOVERNMENT_DATA_ACCESS` @ `v1.0`). Adopt the client's four as canonical:
   server-side whitelist on `…/consents`, seeds updated to the same codes and
   version string, Q-09 closed. Also: `…/submit` must refuse with a stable
   code when the four essential consents are not all granted — the wizard
   already branches on `CONSENTS_REQUIRED`; make the server emit exactly that.
4. **`slaPausedReason` values (Q-07).** The server sends
   `INFORMATION_REQUESTED` or `GOVERNMENT_SERVICE_UNAVAILABLE`; the client's
   copy map keys on `INFORMATION_REQUIRED` (the status, not the reason).
   Map A's values in `SlaTracker`/i18n so the reason renders from the field,
   falling back to status inference. Close Q-07.
5. **Q-08 — per-source panel has no data.** No endpoint lists an
   application's government lookups, and the client's optional
   `governmentRequests[]` read is never satisfied. Add `governmentRequests`
   (id, source, status, sourceAvailable, retrievedAt, validUntil) to the
   application detail body server-side — additive inside an object the
   overlay already extends, same pattern as `slaPausedReason`. The client
   already renders it when present. Close Q-08. This is what makes the
   checkpoint's failure drill say *which* source went quiet.
6. **Q-10 — sole-proprietorship fixture.** The server's answer is identity
   **S4 `20000104`** (already in `GOV_DUMMY_DATA.md` §2), not a `9000000x`
   injection key. Switch the mock store's ineligibility path from the local
   `90000006` placeholder to S4 and delete
   `SOLE_PROPRIETORSHIP_KEY_PENDING_RULING`. Close Q-10.
7. **S3's organization id.** The client mock uses placeholder
   `0e000000-0000-4000-8000-000000000007`; the server seed creates S3's org
   with a *random* id via the register flow. Pin S3's org id to the
   placeholder value in `0200_seed_phase2.sql` (an UPDATE by establishment
   number `20000103`, keeping the seed idempotent) so mock and live agree on
   the one fixture id the SLA screens hard-code.
8. **The failure-drill document disagreement.** The phase file's checkpoint
   says "inject GAM unavailability"; `GOV_DUMMY_DATA.md` §2 assigns the
   outage to S3's **ISTD**, and both the server's live smoke and the client
   fixture follow ISTD. Edit
   `docs/plan/phases/PHASE_2_ONBOARDING_GOVERNMENT.md` (a planning doc, not
   frozen) to say ISTD, citing the identity file as authoritative.

### Part 2 — Backend defects (`apps/api`)

9. **The outage-recovery path is unreachable over HTTP (worst finding).**
   `onboarding.service.ts` implements `retryGovernment()` — resume from
   `GOVERNMENT_SERVICE_UNAVAILABLE` — but no controller exposes it, so an
   application paused on an outage can never leave that state via the API.
   The contract has no retry endpoint, so do not invent one: trigger the
   retry from `POST /government/lookup` (an existing contract path) when a
   lookup for the paused application's establishment number succeeds, and/or
   on `GET …/applications/{id}` reads as a lazy re-check. Add a test that
   drives UNAVAILABLE → available → resumed through public routes only. If
   neither hook satisfies the phase requirements, file it in
   `OPEN_QUESTIONS.md` as Q-11 rather than adding a route.
10. **Government endpoints have no ownership or role checks (the security
    finding).** `GET /government/requests/:id` returns any request row —
    including another company's full normalized registry snapshot — to any
    authenticated user with any org context, and `POST /government/lookup`
    lets any org member run lookups on arbitrary establishment numbers.
    Restrict both: platform roles see everything; a supplier sees only
    requests/lookups tied to their own organization's establishment numbers;
    everyone else gets the same 404-not-403 the applications module uses.
    Add persona tests.
11. **`respond()` silently discards `documentIds`.** Until Phase 3 documents
    exist, reject a non-empty `documentIds` with 422 `VALIDATION_FAILED` and
    a message saying attachments arrive with the documents feature — a
    silent drop of supplier evidence is the worst of the three options.
12. **`EINVOICE` accepted, no adapter registered** — `GovernmentLookupDto`
    allows it and `adapterFor` throws. Reject it explicitly with
    `VALIDATION_FAILED` naming the supported sources.
13. **Register idempotency ignores the body.** A second
    `POST /onboarding/register` with a *different* establishment number
    returns the first org's ids with 200 — the caller's input is silently
    ignored. Return 409 `CONFLICT` when the caller already has an org and the
    establishment number differs.
14. **No state gating on `bank-account`/`consents`** — both accept writes on
    decided (REJECTED/APPROVED) applications. Refuse with 409
    `INVALID_STATE_TRANSITION` outside DRAFT/INFORMATION_REQUIRED states.
15. **Production boots with the published dev `ENCRYPTION_KEY`.** The
    refuse-to-boot checks emptiness only; also refuse when the value equals
    the dev fallback string.
16. **`FINAL_REVIEW` is unreachable** (no transition into it; `DecideDto`
    doesn't accept it). Keep the state but mark it reserved in a comment on
    the state machine and the DTO, so a later phase doesn't re-discover this.

### Part 3 — Frontend defects (`apps/web`)

17. **API_BASE fallback mismatch** — `lib/mocks/handlers.ts` defaults to
    `localhost:3001/v1` while `lib/api/client.ts` defaults to
    `localhost:3000/v1`; with the env var unset, every mock silently misses
    and the app looks dead. Fix the handlers fallback to 3000 (the API's
    port).
18. **Two stale Q-number comments** — `lib/mocks/onboarding-store.ts` lines
    ~18 and ~30 cite Q-09 for the governmentData shape; that is Q-05.
    (B's report claims every citation was updated; these two survived.)
19. **Mock `decide` accepts any decision in any state** — it assigns
    `application.status = decision` with no whitelist, where live returns
    409 `INVALID_STATE_TRANSITION`. Enforce the same transition rules in the
    mock store so mock and live refuse identically.
20. **Wizard error handling** — it special-cases only `CONSENTS_REQUIRED`
    (which, after item 3, the server really emits) and collapses
    `VALIDATION_FAILED`/`INVALID_STATE_TRANSITION` to "unknown error". Give
    the two real codes user-facing copy in both locales.
21. **"Answered, found nothing" modelled on one source only** — the mock
    bootstrap for a `90000002` key marks ISTD/GAM `SUCCESS,
    sourceAvailable=true` with zero fields; model NOT_FOUND consistently
    across sources so INV-9's pair reads correctly on every panel row.

### Part 4 — Docs and process

22. Correct the two completion reports where the audit falsified a claim,
    marking corrections rather than rewriting: A §1 seed row ("five
    applications" — the seed inserts 2 with fixed ids; the other 3 are live-
    run residue), A §7 ("the five" introduces six items); B §1b ("all 14
    handlers" — there are 16; "adds eleven endpoints" — twelve).
23. Append a dated unification entry to `docs/coordination/DAILY_LOG.md`
    (append-only) summarizing this session; update `ENDPOINT_STATUS.md` only
    if endpoint semantics changed shape (statuses stay `mock`).
24. Update `OPEN_QUESTIONS.md`: close Q-05/Q-07/Q-08/Q-09/Q-10 with their
    resolutions per Part 1; record the Q-06 validation decision; add Q-11
    only if item 9 could not be closed contract-legally.

### Acceptance gate (all must pass)

- `npm run lint && npm run typecheck && npm test` from the root — all three
  workspaces, all suites (129 API + 38 web at minimum; new tests on top for
  items 2, 3, 9, 10, 13, 14, 19).
- `node db/tools/build-0001.mjs --check`.
- `npm run openapi:emit -w apps/api && node scripts/contract-conformance.mjs
  apps/api/openapi.generated.json` — green.
- With `.env`: `npm run db:verify` and `npm run test:rls -w apps/api` green;
  re-apply `0200_seed_phase2.sql` after item 7 and confirm idempotency.
- `npx next build` in `apps/web` + `npm run check:i18n -w web` — green.
- Commit in logical chunks on `main` and push.

**Unchanged and still the project's #1 risk: the API is not deployed.** This
session does not close that — only a hosting account does. If one exists by
the time you run, deploy first (`render.yaml` + runbook §2), smoke it, write
`PHASE_1_CHECKPOINT.md` and `PHASE_2_CHECKPOINT.md`, tag both, and announce
the URL in the daily log before starting the fix list.

## END PROMPT
