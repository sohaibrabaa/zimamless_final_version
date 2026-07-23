# Daily Handoff Log (append-only)

One entry per agent per session, newest at the bottom. Format (Master Plan Part 3.3):

```
## <date> — Agent A (session <n>)
LIVE: <endpoints newly live>
CHANGED: <shared-surface changes — normally "none">
SEED: <seed changes B should know>
BLOCKED ON: <open questions / rulings>
NOTE FOR B: <behavioural notes>

## <date> — Agent B (session <n>)
DONE: <screens completed, mock|live>
SWAPPED TO LIVE: <endpoints promoted + smoke result>
CONTRACT GAPS FOUND: <items filed to OPEN_QUESTIONS.md>
NEEDS FROM A: <seed/behaviour requests>
```

Rules: append only; never edit the other agent's entries; answer the counterpart's NEEDS items in your next entry or escalate.

---

## 2026-07-22 — Agent A (session 1)
LIVE: none yet on a deployed URL. `GET /health`, `GET /auth/me`, `POST /auth/context`, `PATCH /auth/language` are implemented and serve locally; they move to LIVE in ENDPOINT_STATUS.md the moment the API is deployed (blocked, see below).
CHANGED: none. Frozen files untouched. Migration 0001 is generated from `docs/02_DATABASE_SCHEMA.sql` with only the ruled D-01 statement removed, and CI re-runs the generator with `--check` so any drift fails the build.
SEED: `db/seed/0100_seed_dev.sql` — paste-and-run SQL, idempotent, fixed UUIDs. 6 orgs (1 platform, 2 suppliers, 3 banks), 15 users with working Supabase Auth logins, 16 memberships, 20 role grants, 6 buyers. Password for every account: `Zimmamless#2026`. Identity list is `docs/specs/GOV_DUMMY_DATA.md` — **please mirror those exact names and numbers in your MSW fixtures** so the mock→live swap is visually diffable.
BLOCKED ON: (1) a reachable `DATABASE_URL` — the project's direct host resolves to IPv6 only and this machine has no IPv6 route, so the session pooler string is needed; nothing DB-dependent has executed yet. (2) D-15 ratification in DECISIONS.md (see OPEN_QUESTIONS Q-01) — worked around additively, not blocking.
NOTE FOR B:
  - Three seeded accounts you will want first: `owner@alnoor.zimmamless.test` (supplier), `maker@jnb.zimmamless.test` (bank), `admin@platform.zimmamless.test` (platform).
  - `multi@platform.zimmamless.test` holds memberships in TWO orgs — it exists specifically so the org-context switcher is testable. Single-org users can only exercise the failure path.
  - Banks K1 and K2 both have a maker AND a separate approver. ZM-ROL-002 is a DB CHECK, so self-approval is rejected by the database, not just the service — your UI block is a third layer, not the only one.
  - Buyers B4/B5/B6 are seeded `SUSPENDED`/`STRUCK_OFF`/`UNDER_LIQUIDATION` so you can build the block-state screens now rather than waiting for Phase 3.
  - `X-Organization-Id` is required on every request except `/onboarding/register`. Missing header, malformed uuid, and non-member org all return the SAME 403 by design — do not branch on the difference, there deliberately isn't one.
  - `GET /health` is NOT in the frozen contract. It is served outside the `/v1` prefix and excluded from `/docs-json`, so your generated client will not contain it. That is intentional, not a gap.
  - Error envelope matches the contract `Error` schema and always carries `correlationId`; the same id comes back in the `X-Correlation-Id` response header. Surfacing it in your error UI makes support tractable.
  - `/auth/me` will include the optional `demo` block (D-10) only when the time machine is enabled server-side; it is absent in production. Gate the time-machine control on its presence.

## 2026-07-22 — Agent A (session 1, addendum: database is live)
LIVE (serving locally against the hosted Supabase, NOT yet on a public URL): `GET /health`, `GET /auth/me`, `POST /auth/context`, `PATCH /auth/language`. All four smoke-tested with real Supabase tokens. **Do not flip ENDPOINT_STATUS.md to `live` until I announce a deployed URL.**
CHANGED: none to frozen files. Migration `0004` added (a policy I had missed on `business_calendar_holidays`). `POST /auth/context` now returns **200**, not 201, per the contract.
SEED: applied and verified — 6 orgs, 15 users with working logins, 16 memberships, 20 role grants, 6 buyers. Password `Zimmamless#2026`. Fixed ids, so you can hard-code them in mocks; they are listed in `docs/specs/GOV_DUMMY_DATA.md`.
BLOCKED ON: nothing. D-15 ratification still pending but not blocking.
NOTE FOR B — three things that will affect your client:
  1. **Tokens are ES256, not HS256.** This project has moved to asymmetric signing keys even though the dashboard still shows a legacy JWT secret. If you decode or verify tokens anywhere, do not assume HS256. It cost me a round of debugging; it should cost you none.
  2. **`/auth/me` works WITHOUT `X-Organization-Id`** — it has to, since you cannot know which org to name until it answers. Call it right after login, then send the header on everything else. Passing an org the user does not belong to is not an error there; the response simply omits `activeOrganizationId`.
  3. **`POST /auth/context` returns 200**, and your generated client should expect that. It was briefly 201 (NestJS's POST default) — fixed. Worth knowing the conformance gate did NOT catch it, because it compares paths and verbs but not status codes; if you hit a status mismatch anywhere, treat it as real and tell me rather than assuming the gate would have caught it.
Verification status: 78 automated checks green — 40 unit, 23 RLS persona (live, INV-11 + the D-02 floor revoke proven by direct SQL), 15 schema checks, plus the frozen-schema and conformance gates.
## 2026-07-22 — Agent B (session 1)
DONE (all mock — Phase 1, brief §Phase 1 / phases/PHASE_1_FOUNDATION_SHELL.md):
- `/apps/web` scaffolded standalone (Next.js 16, React 19, TypeScript, Tailwind v4).
- `[locale]` app router (en|ar), no locale auto-detection (ZM-I18N-003) — `proxy.ts` only ever reads the persisted `zm_locale` cookie or defaults to `en`, never `Accept-Language`.
- Full RTL plumbing (logical CSS properties, `dir` on `<html>`, mirrored nav/table/tabs) — see `docs/specs/RTL_CHECKLIST.md` (new, drafted this session).
- Design system primitives: Button, Input, Select, Table, Modal (native `<dialog>`), Toast, Badge, Tabs, Skeleton, EmptyState/ErrorState.
- `MoneyDisplay`/`MoneyInput` on `decimal.js`; ESLint bans `parseFloat`/`parseInt`/bare `Number()` coercion on non-literal values repo-wide.
- OpenAPI codegen pipeline: `scripts/merge-openapi.mjs` merges frozen `03_API_CONTRACT.yaml` + `API_v3.1.0_OVERLAY.yaml` (incl. the D-10 `demo` field patch on `/auth/me`) → `openapi-typescript` → `lib/api/generated/schema.d.ts`; typed `openapi-fetch` client in `lib/api/client.ts` (Bearer + `X-Organization-Id` + `Accept-Language` + `Idempotency-Key` helper wired per contract cross-cutting rules).
- `lib/api/endpoint-status.ts` — mirrors `ENDPOINT_STATUS.md` exactly (all mock); dev-only badge (`MockEndpointBadge`) shows mock/live counts.
- MSW handlers for the 4 Phase 1 endpoints (`/health`, `/auth/me`, `/auth/context`, `/auth/language`); browser worker auto-starts in dev.
- Supabase Auth UI: login, register, verify-email, verify-phone (client-side against Supabase directly per PA-04).
- Role-gated portal shells (supplier/bank/platform) at `/[locale]/{supplier,bank,platform}/...` — real path segments, not route groups, since three route groups all named `dashboard/` would collide on one URL; nav config in `components/layout/portal-nav.ts`. Org switcher + language switcher + sign-out in the header; empty/loading/error state patterns on every stub screen.
- Dev-only mock persona picker (`components/dev/DevPersonaPicker.tsx`) lets the three portals be exercised end-to-end today without real backend users — not for Phase 9.
- Verified: `next build` and `next lint` both clean; manual smoke test of `/`, `/en/login`, `/ar/login` (RTL confirmed), dashboard redirect chain.
SWAPPED TO LIVE: none — no Phase 1 backend endpoints announced yet.
CONTRACT GAPS FOUND: none.
NEEDS FROM A:
- Real Phase 0 seed identity list (establishment numbers, org names) so `lib/mocks/data.ts`'s placeholder personas (Rania Al-Khatib / Al-Mashriq Trading, Omar Haddad / Jordan First Bank, Lina Nasser / Zimmamless Platform) can be replaced with the real seed identities once `docs/specs/SEED_DATA.md` exists, for the visually-diffable mock→live swap (Master Plan 3.4 #3).
- Root workspace config: `/apps/web` currently ships its own standalone `package.json`/lockfile (root `package.json`/`tsconfig.base.json`/`db/` are untracked in the checkout I branched from). Root config is A's by default — let me know when it's committed and I'll fold `apps/web` into the workspace rather than doing it myself.
NOTE FOR B (next session): Phase 1 exit bar needs the 4 auth endpoints flipped to `live` in `ENDPOINT_STATUS.md` — blocked on A. Also: hit and worked around a Next.js 16.2.11 bug where Turbopack dev throws `TypeError: adapterFn is not a function` on every request as soon as a `proxy.ts` exists (reproduced with a minimal one) — `next build` is unaffected, but `npm run dev` now runs `next dev --webpack` explicitly (see comment in `apps/web/next.config.ts`). Revisit if upgrading past 16.2.11.

## 2026-07-23 — Unification session (both halves, single session)
Scope: fold Agent B's worktree into `main`, then fix everything the independent Phase 1 audit found in either half. Ownership boundaries were suspended for this session only; both agents resume their own areas at Phase 2.

WORKSPACE: `apps/web` is now a real npm workspace member. Its standalone lockfile is gone (root lockfile is authoritative), its `tsconfig.json` extends `tsconfig.base.json`, it has `typecheck` and `test` scripts, and `next.config.ts` traces from the repo root instead of pinning the old nested-worktree root. Root `npm run lint|typecheck|test` now covers all three workspaces.

PORTS: the API keeps 3000 (the frozen contract's servers block names it); the web app now runs on **3001** via `--port` in its dev/start scripts. `CORS_ORIGINS` already expected 3001, so this makes the two agree rather than changing either.

BACKEND FIXES:
- `TIME_PROVIDER` was registered with `useClass` alongside `SystemTimeProvider`, creating **two instances with separate caches** — `main.ts` primed the one no injection site uses. Now `useExisting`.
- Hard rule 6 hole: an org-context-**exempt mutation** (`PATCH /auth/language`) sent without `X-Organization-Id` wrote an audit row with `actor_org_id = NULL`. The guard now adopts the user's sole membership when there is exactly one, and refuses with `ORGANIZATION_CONTEXT_REQUIRED` when the user is multi-org. Exempt **GET**s are unchanged — `/auth/me` still works with no context, as it must. Four new guard tests.
- Generic 403s were labelled `ORGANIZATION_CONTEXT_REQUIRED` by the exception filter's fallback. New neutral `FORBIDDEN` code; AppException codes unchanged.
- `Money.multiply()` accepted any JS number, undercutting the float ban. Safe integers only (a count of instalments is exact); fractional factors must be strings or Decimals. Three new money tests.
- `db/tools/verify.mjs` no longer disables TLS certificate verification by default (`--insecure-tls` opt-in), and derives the expected migration list from `db/migrations/` — the hand-kept literal had silently stopped covering `0004`.
- The RLS persona suite now **throws** instead of skipping when `DATABASE_URL` is absent in CI. A security suite that goes green by not running is the one failure mode that must not look like a pass.

FRONTEND FIXES:
- **Org switching would not have worked against the live API at all.** The client derived `X-Organization-Id` from `me.activeOrganizationId`, but the live `/auth/me` only *echoes* a header the request already carried — so no header was ever sent, no org was ever active, and every non-exempt endpoint would have 403'd. The active org is now client-side state (React state + localStorage), defaulted to the first membership after login, healed when a stored id is no longer a membership, and updated on switch. Five new SessionProvider tests against MSW, including that the refetch after a switch carries the NEW org.
- Mock fixtures were **entirely invented** — wrong names, wrong org ids, and wrong role strings (`SUPPLIER_OWNER_ADMIN`, `BANK_ADMIN`+`OFFER_APPROVER`, `SUPER_ADMIN`). Since the contract types roles as plain `string[]`, none of that would fail until it met the live API. All fixtures now copy `db/seed/0100_seed_dev.sql` verbatim, and a new test reads the seed SQL and fails if any fixture id, name, email, or role is not in it.
- Added the multi-membership persona (Sara Yaseen, S2+P1). Without it `OrgSwitcher` never rendered, so `POST /auth/context` was unreachable from the UI — the org-switch flow is a Phase 1 checkpoint item and could not have been demonstrated. Also added K2's maker and buyers B4–B6 (the three blocked registry statuses).
- MSW now honours the mock/live map: `handlers.ts` calls `passthrough()` for `live` entries. Previously every handler was registered unconditionally and `isLive()` was dead code, so flipping an endpoint to `live` changed the dev badge and nothing else.
- The mock `POST /auth/context` now mirrors the live 403 (`ORGANIZATION_CONTEXT_INVALID`, same envelope with `correlationId`) for a non-member org, and `OrgSwitcher` catches it and shows a toast instead of leaving an unhandled rejection.
- `/health` was mocked at `/v1/health`; it lives at the server root. Fixed, and removed from both the code map and ENDPOINT_STATUS.md — it is infrastructure, not a contract endpoint.
- Supabase client no longer falls back silently to a placeholder URL/key outside mock mode; it throws naming the missing variable. ESLint money ban extended to `Number.parseFloat`/`globalThis.parseInt` and friends.
- Portal shells are now actually role-gated: a user whose active membership is the wrong organization type is redirected to their own portal. Navigation hygiene only — the API guard and RLS remain the real boundary.

GATE: `scripts/contract-conformance.mjs` now compares **success status codes** per path+verb, not just paths and verbs. Verified against a deliberately regressed spec: it catches the exact 201-vs-200 defect that shipped in Phase 1 and passed the old gate. It still does not compare response bodies — see Q-04.

DOCS: corrected two factual errors in `PHASE_1_AGENT_A.md` (the "identical 403" handoff note, and 62-vs-61 RLS-enabled tables) with the corrections marked rather than silently rewritten. Filed **Q-03** (Arabic digit set for money) and **Q-04** (`/auth/context` returns an undeclared body).

VERIFICATION: 47 API unit tests, 11 web tests, 23 live RLS persona tests, 15 `db:verify` checks, frozen-schema drift check, conformance gate, `next build` (all routes × both locales), lint and typecheck across all three workspaces — all green.

STILL OPEN (unchanged by this session): the API is **not deployed to a public URL**, so the joint Phase 1 checkpoint remains unrun and every ENDPOINT_STATUS entry stays `mock`. That is the first task of Phase 2.

## 2026-07-23 — Agent A (session 2, Phase 2)
LIVE: none on a public URL — **the API is still not deployed**, so every
ENDPOINT_STATUS entry stays `mock`. Thirteen Phase 2 endpoints are
implemented and verified against the hosted database from localhost:
`/onboarding/register`, `/onboarding/applications-list`,
`/onboarding/applications` POST, `/onboarding/applications/{id}` GET,
`…/submit`, `…/bank-account`, `…/consents`, `…/information-requests`,
`…/respond`, `…/decide`, `/government/lookup`, `/government/requests/{id}`.
Conformance gate: 15/82 paths, no drift on paths, verbs or status codes.

CHANGED (shared surfaces — read this section):
  - **`docs/specs/GOV_DUMMY_DATA.md` gained two supplier identities, S4 and
    S5.** Nothing was renamed or renumbered, so your existing fixtures are
    unaffected — but please mirror these two, because each exists for a path
    that had no fixture at all:
      · **S4 `20000104` Hani Auto Parts Establishment** — the only sole
        proprietorship. It is what your ineligibility screen (ZM-SON-013)
        renders. Registering it and submitting produces `REJECTED` with
        reasonCode `SOLE_PROPRIETORSHIP_NOT_ELIGIBLE`.
      · **S5 `20000105` Amman Steel Works** — all sources answer in full,
        and it is deliberately NOT seeded as an organization. Every other
        full-success supplier already is, so `/onboarding/register` 409s for
        all of them; S5 is the identity to use when you demo register →
        submit → approve. Note it is consumed by first use.
  - `GOV_DUMMY_DATA.md` §6a is new: the exact CCD/ISTD/GAM normalized field
    keys and value domains (the old §8 open item). Your government-data
    panel can be built against that table rather than against guesses.

SEED: new file `db/seed/0200_seed_phase2.sql`, applied to the hosted
database (idempotent, fixed UUIDs, run after `0100`).
  - **12 public holidays.** `business_calendar_holidays` was empty, which
    silently meant "no holidays exist" — every holiday branch in the SLA
    arithmetic was unreachable with real data. The lunar Islamic dates are
    approximations, flagged as such in the file and in the spec.
  - **Five applications now exist, spanning every interesting state**:
    APPROVED (Al-Noor, fixed id `0e200000-…-0001`), INFORMATION_REQUIRED and
    paused (Petra, `0e200000-…-0002`, with an OPEN information request),
    GOVERNMENT_SERVICE_UNAVAILABLE (Jordan Valley Foods), APPROVED via the
    full pause/resume cycle (Amman Steel Works), and REJECTED (the sole
    proprietorship). **Only the two `0e200000-…` ids are fixtures** — hard-code
    those. The other three were created by registering through the live API
    while verifying, so their ids are random; treat them as queue content,
    not as fixtures.

BLOCKED ON: **the deploy.** Everything in `DEPLOY_RUNBOOK.md` except §2
(creating the Render service) has now been executed for real against the
production build, and the runbook is corrected accordingly. §2 needs a
hosting account, which I do not have. A `render.yaml` blueprint is committed
at the repo root so it is one action once an account exists. Until then the
Phase 1 checkpoint stays unrun and nothing flips to `live`.

NOTE FOR B — five things that will affect your screens:
  1. **A paused SLA has NO deadline.** `slaDeadlineAt` is `null` whenever
     `slaPaused` is true, by design — projecting one from "if it resumed
     now" would show a date that moves on every refresh. Render the paused
     state and the remaining time; do not render a date. `slaPausedReason`
     tells you why (`INFORMATION_REQUESTED` or
     `GOVERNMENT_SERVICE_UNAVAILABLE`).
  2. **`GOVERNMENT_SERVICE_UNAVAILABLE` is not an adverse state and must not
     look like one.** No red, no "failed", no "rejected". The clock is
     paused and nothing about the supplier has been judged. Correspondingly,
     on `/government/*` responses branch on **`sourceAvailable`**, never on
     `status` alone: `NOT_FOUND` means the registry answered "no such
     entity" (adverse, `sourceAvailable: true`) while `UNAVAILABLE` means it
     did not answer (`sourceAvailable: false`). Fixture keys `90000002` and
     `90000001` are that pair.
  3. **`governmentData` is a map of `{value, sourceKind, source,
     retrievedAt}`, not bare values.** That is what your source badge and
     retrieval date read from. `sourceKind` is `GOVERNMENT` or
     `SELF_DECLARED`; render `GOVERNMENT` fields read-only. A field the
     supplier typed that contradicts the registry is stored but does not win
     (ZM-SON-004) — it will appear with `sourceKind: GOVERNMENT` and the
     supplier's value is kept behind it for the reviewer.
  4. **`POST /onboarding/register` returns 201 on first call and 200 when
     the user already has an organization**, with the same ids both times.
     It is the only route exempt from `X-Organization-Id`, because the caller
     has no organization yet. Everything else needs the header as usual.
  5. Status codes worth pinning in your client: `submit`, `respond` and
     `decide` all return **200** (not 201); `/government/lookup` returns
     **202**. The conformance gate now checks these, so if you see a
     mismatch it is real — tell me rather than assuming the gate caught it.
## 2026-07-23 — Agent B (session 2, Phase 2)
Sequencing note, for honesty: this session's Phase 2 work was built on `b/phase1-shell` **before** merging the unification commit above, because that branch did not contain `docs/plan/11_PHASE_2_KICKOFF_B.md` and the kickoff's Step 0 was therefore never seen. Everything below is the state **after** merging `origin/main` and reworking against it. The behavioural work survived the merge; the infrastructure assumptions did not, and what changed is listed under REWORK.

DONE (all mock — `phases/PHASE_2_ONBOARDING_GOVERNMENT.md`, Agent B tasks). All 8 in-scope screens:
- Supplier: bootstrap form (D-04 `/onboarding/register`), 4-step wizard (identity review → licence review → consents → bank account), SLA tracker, information-request inbox + response form, conditional-approval banner, ineligibility notice (ZM-SON-013).
- Platform: review queue (status filter + pagination off D-05), application detail with the government data panel, decision form (approve / conditional / info-required / reject with reason code).
- The three things the kickoff flagged as where this phase goes wrong: government fields are read-only with source badge + retrieval date and no editable variant exists anywhere (ZM-SON-003 binds administrators too); `GOVERNMENT_SERVICE_UNAVAILABLE` renders as paused-not-adverse with copy saying so, and a regression test asserts its badge tone stays neutral; `APPROVED_CONDITIONAL` gets a banner plus a real gate on all five supplier financing routes, wired now rather than when those screens ship.
- Stateful MSW store reproduces the §5.5 state machine, so submit → info request → respond → decide is drivable by persona switching rather than only inspectable.

REWORK after merging `origin/main` — the audit fixes applied to my half, carried forward:
- **Fixtures rebuilt on the frozen identities.** My Phase 2 fixtures had the same defect the audit found in Phase 1: invented names and numbers. They are now S1 Al-Noor (`20000101`, DRAFT — the wizard), S2 Petra (`20000102`, paused on an information request, GAM partial), S3 Jordan Valley Foods (`20000103`, ISTD unavailable — GOV_DUMMY §2 designates this supplier as the SLA-pause scenario). Org ids copied from `db/seed/0100_seed_dev.sql`.
- **Adapter variants now key off the frozen §5 injection keys** (`90000001` UNAVAILABLE, `90000002` NOT_FOUND, `90000003` PARTIAL), replacing a last-digit convention I had invented. There is now a test asserting `90000001` and `90000002` stay distinguishable — that pair is the fourth defining behaviour.
- **Added the `platform-reviewer` persona** (Maha Darwish, seeded). `decide` requires `PLATFORM_SUPPLIER_REVIEWER`, which `platform-admin` does not hold — without her the review queue could be read but never acted on. `data.spec.ts` passes, so she is genuinely in the seed.
- **Handlers rewritten onto `mockOnly()`/`passthrough()`** so the Phase 2 endpoints honour the mock/live map like the Phase 1 ones, and onto the real error envelope with canonical codes (`VALIDATION_FAILED`, `NOT_FOUND`, `INSUFFICIENT_ROLE`, `INVALID_STATE_TRANSITION`) instead of the ad-hoc ones I had invented.
- **`useMyApplication` reads `activeOrganizationId` from `useSession()`**, not `me.activeOrganizationId` — and re-fetches when it changes, so an org switch reloads the screen.
- **Tests migrated from `node:test` to vitest** (`*.spec.ts`, colocated) now that a runner exists. My separate `tests/` directory and the `node --experimental-strip-types` script are gone.
- My **Q-01..Q-05 renumbered to Q-05..Q-09** — `origin/main` had already used Q-01..Q-04. Renumbered in `OPEN_QUESTIONS.md` and in every code comment that cites one.

VERIFIED: 38/38 vitest green (19 domain + 8 state machine + main's 6 seed-parity + 5 SessionProvider); typecheck, lint (web and root-wide), `next build` all clean; i18n parity 258 keys in both locales.
SWAPPED TO LIVE: none. Per A's own instruction, nothing flips until a deployed public URL is announced — that is still outstanding, so all 14 endpoints remain `mock`.
CONTRACT GAPS FOUND: **Q-05..Q-09** (filed this session, renumbered) plus **Q-10** (new). Q-05 `governmentData` has no per-field provenance shape · Q-06 no `decisionReasonCode` catalogue · Q-07 `slaPaused` carries no reason · Q-08 no way to list an application's government lookups · Q-09 no consent-type catalogue · Q-10 no sole-proprietorship identity or injection key, which ZM-SON-013 needs. None is a missing endpoint; each is under-specification inside something the contract declares free-form or as a bare string, so each assumption is isolated to one file. Reasoning in §5 of `docs/completion/PHASE_2_AGENT_B.md`.
NEEDS FROM A:
1. **Match three lists exactly or the first integration day 422s**: `lib/onboarding/consents.ts` (4 consent codes @ `1.0`), `lib/onboarding/reason-codes.ts` (13 codes), `lib/onboarding/status.ts` (the §5.5 status strings). If the requirements point elsewhere, say so and I will regenerate — do not accommodate my guess.
2. **Q-08 blocks a checkpoint item.** The failure drill requires showing a named source as unavailable with the clock paused; without the government-request list on the application I can only say "not yet retrieved" and cannot name which registry went quiet.
3. **Q-10**: please add a sole-proprietorship case to `GOV_DUMMY_DATA.md` — §5 key `90000006` is my recommendation and what I currently use. Adding is explicitly allowed by that file; I did not edit it, since it is yours.
4. **S3 Jordan Valley Foods needs an organization id.** GOV_DUMMY §2 marks it "no (Phase 1 seed)", so its name and establishment number are frozen but it is not in `0100_seed_dev.sql` yet. I am using the placeholder `0e000000-0000-4000-8000-000000000007`, marked as such in `onboarding-store.ts`. Tell me the real id when you seed it — it is the single value in that file that has to be reconciled.
5. Thank you for the multi-org persona, K2, B4–B6 and the passthrough fix — the last of those is the mechanism the whole mock-first strategy rests on, and it is now exercised by 14 more endpoints.

## 2026-07-23 — Phase 2 unification session (both halves, single session)
Scope: the Phase 2 audit's fix list (docs/plan/12_PHASE_2_FIX_PROMPT.md), all 24 items. Ownership boundaries suspended for this session only.

CROSS-HALF RECONCILIATION — the five places the two halves had quietly diverged, now agreed and validated:
- **governmentData (Q-05 closed):** the client reads the server's real shape `{value, sourceKind, source, retrievedAt}`; the `verificationStatus` field it used to expect never existed. Mock store emits the same shape.
- **Reason codes (Q-06 closed):** one catalogue, two families — 13 reviewer-selectable codes + 7 automated hard-rejection codes. Server validates reviewer input against the reviewer set (422 otherwise); automated codes are not reviewer-suppliable. The ineligibility screen now triggers on `SOLE_PROPRIETORSHIP_NOT_ELIGIBLE` — the code live data actually carries.
- **Consents (Q-09 closed):** the wizard's four are canonical (`GOVERNMENT_LOOKUP_AUTHORIZATION`, `BANK_DISCLOSURE_AUTHORIZATION`, `TERMS_OF_SERVICE`, `PRIVACY_POLICY` @ "1.0"). Server whitelist on …/consents; …/submit now refuses with `CONSENTS_REQUIRED` until all four are granted; seed vocabulary updated.
- **slaPausedReason (Q-07 closed):** client maps the server's `INFORMATION_REQUESTED` / `GOVERNMENT_SERVICE_UNAVAILABLE`.
- **governmentRequests (Q-08 closed):** application detail now carries the per-source request list (latest per source, `sourceAvailable` included), so the failure drill can say WHICH source went quiet. Q-10 closed via S4 `20000104`; the mock's `90000006` placeholder is gone. The phase file's failure drill now says ISTD, matching GOV_DUMMY_DATA §2.

BACKEND (A's half):
- **The outage-recovery path is reachable** — a successful `POST /government/lookup` for an application paused on `GOVERNMENT_SERVICE_UNAVAILABLE` re-runs automated verification and resumes (or legally re-pauses). No new endpoint; ZM-GOV-006's no-scheduled-sweeps rule holds.
- **Government endpoints are access-gated** (the audit's security finding): platform roles see everything; anyone else may look up and read only their own establishment number; everything else is the same 404 as not-existing. Any-authenticated-user could previously read any company's registry snapshot by request id.
- `respond` refuses non-empty `documentIds` loudly (422) until Phase 3 documents exist — previously silently discarded. `EINVOICE` refused by name (no adapter). Register 409s when the same account sends a *different* establishment number instead of silently echoing the first org. Consents/bank-account writes are state-gated (409 outside DRAFT / INFORMATION_REQUIRED). Production refuses to boot with the published dev `ENCRYPTION_KEY`, not just with none. `FINAL_REVIEW` documented as reserved-not-reachable in the machine and the DTO.

FRONTEND (B's half):
- Mock handlers' API_BASE fallback fixed to 3000 (was 3001 — with the env var unset every mock silently missed while the client called 3000).
- Mock `decide` enforces the live transition whitelist and returns the same 409 `INVALID_STATE_TRANSITION`; mock submit lands on `UNDER_REVIEW` (live's observable post-submit state, not the transient `AUTOMATED_VERIFICATION`). NOT_FOUND now modelled on all three sources for a `90000002` identity. Wizard has real copy for `VALIDATION_FAILED`/`INVALID_STATE_TRANSITION` in both locales. Two stale Q-09 comments corrected to Q-05.

SEEDS: S1's consents re-seeded in the canonical vocabulary; S3 Jordan Valley Foods inserted with the fixture org id `0e000000-…-0007` on fresh databases (the hosted row keeps its random id — re-pointing a PK across every FK is not worth it; noted in the seed).

VERIFICATION: 154 API tests (was 129; new suites: onboarding-guards, government-access), 41 web tests (was 38), lint/typecheck all workspaces, i18n parity 274 keys both locales, `next build`, frozen-schema drift check, conformance gate — all green. `db:verify` and the RLS suite re-run against the hosted project after the seed re-apply.

STILL OPEN: deployment. Unchanged, still the project's #1 risk, still not resolvable from a session. Q-01..Q-04 remain as they were.

## 2026-07-23 — Agent A (session 3, Phase 3)
LIVE: none on a public URL — **the API is still not deployed**, so every
ENDPOINT_STATUS entry stays `mock`. Fourteen Phase 3 endpoints are
implemented and verified against the hosted database **and hosted Supabase
Storage** from localhost: `/buyers/search`, `/buyers/resolve`,
`/buyers/{id}`, `/documents/upload-url`, `/documents/{id}/download-url`,
`/documents/{id}/extraction`, `/transactions` GET+POST,
`/transactions/{id}`, `…/invoice`, `…/buyer`, `…/minimum-amount`,
`…/declarations`, `…/submit`, `…/verification`.
Conformance gate: 29/82 paths, no drift on paths, verbs or status codes.

CHANGED (shared surfaces — read this section):
  - **`/services/ml` now exists and OCR genuinely runs.** The Phase 0
    carry-over "Python is not installed" was wrong: `python` is a Microsoft
    Store stub, but `py` runs 3.13.3. Nothing of yours changes; this is the
    thing your wizard's pre-fill has been waiting for.
  - **Every date the API emits was one day early, and is now correct.** A
    Postgres `date` read as a JS Date lands on LOCAL midnight, so
    `toISOString()` moved it back a day in Asia/Amman. If you built any
    fixture by copying a live response, re-check it.
  - **`docs/specs/EINVOICE_QR.md` is new** — the QR payload schemas, the
    four `validationStatus` outcomes, and the seeded e-invoice inventory.
  - `docs/coordination/ENDPOINT_STATUS.md` — the 14 Phase 3 rows now carry
    behavioural notes rather than empty cells.
  - `db/tools/migrate.mjs` gained `--rebaseline <name>`. Infrastructure, not
    a shared surface, but it is why migrations run again at all — see the
    completion report §4.6.

SEED:
  - **`db/seed/einvoices/` — five e-invoice PDFs we generate ourselves**
    (`services/ml/tools/generate_einvoices.py`, byte-stable, `--check` mode).
    These are the Phase 3 seed. Purposes are listed in EINVOICE_QR.md §7;
    the one you want first is
    `INV-2026-0002-alnoor-levant-mismatch.pdf` — its QR says `25000.000`
    while the page prints `24500.000`, which is the deliberate
    extracted-vs-entered mismatch your step 2 has to highlight.
  - **`db/seed/0300_seed_phase3.sql`** — five supplier↔buyer relationships,
    fixed ids, applied to the hosted database. Aqaba Logistics appears under
    BOTH S1 and S2 with **different contacts**: that is ZM-BUY-008 made
    visible, not a duplicate row.
  - Deliberately **no seeded transactions, invoices or documents**. A
    hand-written invoice row would be a fiction — its fingerprint, its
    extraction rows and its stored object are produced by code paths that
    have to actually run. Transactions `ZM-1004`+ on the hosted database are
    residue from my verification run with random ids, exactly like the Phase
    2 queue: real rows, not fixtures.

BLOCKED ON: **the deploy**, unchanged and now three phases old. `render.yaml`
is committed; §2 of the runbook needs a hosting account I do not have.

NOTE FOR B — nine things that will affect your screens:
  1. **`POST /buyers/resolve` is 200, not 201**, and needs
     `confirmedByUser: true`. `SUSPENDED`/`STRUCK_OFF` are 409
     `BUYER_BLOCKED`. **`UNDER_LIQUIDATION` is 200 with
     `requiresManualReview: true`** — a review path, not a refusal (LT-02).
     Please do not render it in the blocked-buyer style.
  2. **There is no finalize call, deliberately.** `upload-url` → you PUT the
     file to the signed URL → done. Hashing and OCR run lazily, so the
     **first** `GET /documents/{id}/extraction` takes ~2–5 seconds and
     later ones are instant. Show a pending state. (I built a
     `POST /documents/{id}/finalize`, the conformance gate refused it as
     not-in-contract, and it was right — completion report §4.5.)
  3. **`qr.validationStatus` has four values and two are not failures.**
     `UNAVAILABLE` = the document carries no QR at all (normal).
     `UNPARSED` = a code was read and no schema recognised it (manual
     review). Same shape as the `90000001`/`90000002` distinction — please
     keep them visually distinct.
  4. **`minimumAcceptableAmount` is absent from the bank view entirely**,
     and the 422 refusing an excessive floor does not echo the floor back.
     Do not reconstruct it from the error to show the supplier.
  5. **A false declaration is 422 with `details.notAffirmed[]`** naming
     which of the eight. Surface the list — it is better than a generic
     message. (It is 422 and not 400 because it is a business rule, not a
     malformed body.)
  6. **Duplicate submit is 409 `DUPLICATE_INVOICE` with
     `details.reviewReference`** for your blocked screen. It deliberately
     discloses nothing about the other party.
  7. **Money in is a 3-dp string** — `"12354"` is rejected, `"12354.000"` is
     accepted. Status codes to pin: `resolve` **200**, `upload-url` **200**,
     `submit` **200**, `POST /transactions` **201**, `declarations` **201**.
  8. **`GET /transactions/{id}` varies by audience** — supplier and platform
     get the floor, a bank never does. A bank cannot see an unlisted
     transaction at all (404) until Phase 5 creates listings.
  9. **`buyers/search` never returns a selection**, not even for a single
     100% match, and there is no field in the response that could carry one.
     `candidates[].matchSource` tells you whether a candidate came from this
     supplier's own relationships, the platform, or the registry.

VERIFICATION: 245 API unit tests (was 154), **56 live RLS persona tests**
(was 23 — the Phase 2 carry-over is closed: the suite now runs against the
Phase 2 and Phase 3 tables **with rows in them**, and fails loudly rather
than passing vacuously if the fixtures are absent), 95 ML tests (new,
including real rasterize→OCR→QR over the real seeded PDFs), 36 live
end-to-end checks against hosted Supabase + Storage, `db:verify` 15/15,
frozen-schema drift check, conformance gate, lint and typecheck — all green.

Four real defects were found by running things rather than by testing them,
and all four produced plausible-looking output rather than obvious failures:
the one-day date shift above; two OCR label-matching bugs that silently
dropped the seller's name from every Al-Noor invoice; and a duplicate check
that was defeated by the very unique index meant to enforce it (the DB
raised on the *draft*, so a 500 on `PUT …/buyer` meant `submit` never saw a
collision). Completion report §4.
