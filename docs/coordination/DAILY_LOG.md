# Daily Handoff Log (append-only)

One entry per agent per session, newest at the bottom. Format (Master Plan Part 3.3):

```
## <date> â€” Agent A (session <n>)
LIVE: <endpoints newly live>
CHANGED: <shared-surface changes â€” normally "none">
SEED: <seed changes B should know>
BLOCKED ON: <open questions / rulings>
NOTE FOR B: <behavioural notes>

## <date> â€” Agent B (session <n>)
DONE: <screens completed, mock|live>
SWAPPED TO LIVE: <endpoints promoted + smoke result>
CONTRACT GAPS FOUND: <items filed to OPEN_QUESTIONS.md>
NEEDS FROM A: <seed/behaviour requests>
```

Rules: append only; never edit the other agent's entries; answer the counterpart's NEEDS items in your next entry or escalate.

---

## 2026-07-22 â€” Agent A (session 1)
LIVE: none yet on a deployed URL. `GET /health`, `GET /auth/me`, `POST /auth/context`, `PATCH /auth/language` are implemented and serve locally; they move to LIVE in ENDPOINT_STATUS.md the moment the API is deployed (blocked, see below).
CHANGED: none. Frozen files untouched. Migration 0001 is generated from `docs/02_DATABASE_SCHEMA.sql` with only the ruled D-01 statement removed, and CI re-runs the generator with `--check` so any drift fails the build.
SEED: `db/seed/0100_seed_dev.sql` â€” paste-and-run SQL, idempotent, fixed UUIDs. 6 orgs (1 platform, 2 suppliers, 3 banks), 15 users with working Supabase Auth logins, 16 memberships, 20 role grants, 6 buyers. Password for every account: `Zimmamless#2026`. Identity list is `docs/specs/GOV_DUMMY_DATA.md` â€” **please mirror those exact names and numbers in your MSW fixtures** so the mockâ†’live swap is visually diffable.
BLOCKED ON: (1) a reachable `DATABASE_URL` â€” the project's direct host resolves to IPv6 only and this machine has no IPv6 route, so the session pooler string is needed; nothing DB-dependent has executed yet. (2) D-15 ratification in DECISIONS.md (see OPEN_QUESTIONS Q-01) â€” worked around additively, not blocking.
NOTE FOR B:
  - Three seeded accounts you will want first: `owner@alnoor.zimmamless.test` (supplier), `maker@jnb.zimmamless.test` (bank), `admin@platform.zimmamless.test` (platform).
  - `multi@platform.zimmamless.test` holds memberships in TWO orgs â€” it exists specifically so the org-context switcher is testable. Single-org users can only exercise the failure path.
  - Banks K1 and K2 both have a maker AND a separate approver. ZM-ROL-002 is a DB CHECK, so self-approval is rejected by the database, not just the service â€” your UI block is a third layer, not the only one.
  - Buyers B4/B5/B6 are seeded `SUSPENDED`/`STRUCK_OFF`/`UNDER_LIQUIDATION` so you can build the block-state screens now rather than waiting for Phase 3.
  - `X-Organization-Id` is required on every request except `/onboarding/register`. Missing header, malformed uuid, and non-member org all return the SAME 403 by design â€” do not branch on the difference, there deliberately isn't one.
  - `GET /health` is NOT in the frozen contract. It is served outside the `/v1` prefix and excluded from `/docs-json`, so your generated client will not contain it. That is intentional, not a gap.
  - Error envelope matches the contract `Error` schema and always carries `correlationId`; the same id comes back in the `X-Correlation-Id` response header. Surfacing it in your error UI makes support tractable.
  - `/auth/me` will include the optional `demo` block (D-10) only when the time machine is enabled server-side; it is absent in production. Gate the time-machine control on its presence.

## 2026-07-22 â€” Agent A (session 1, addendum: database is live)
LIVE (serving locally against the hosted Supabase, NOT yet on a public URL): `GET /health`, `GET /auth/me`, `POST /auth/context`, `PATCH /auth/language`. All four smoke-tested with real Supabase tokens. **Do not flip ENDPOINT_STATUS.md to `live` until I announce a deployed URL.**
CHANGED: none to frozen files. Migration `0004` added (a policy I had missed on `business_calendar_holidays`). `POST /auth/context` now returns **200**, not 201, per the contract.
SEED: applied and verified â€” 6 orgs, 15 users with working logins, 16 memberships, 20 role grants, 6 buyers. Password `Zimmamless#2026`. Fixed ids, so you can hard-code them in mocks; they are listed in `docs/specs/GOV_DUMMY_DATA.md`.
BLOCKED ON: nothing. D-15 ratification still pending but not blocking.
NOTE FOR B â€” three things that will affect your client:
  1. **Tokens are ES256, not HS256.** This project has moved to asymmetric signing keys even though the dashboard still shows a legacy JWT secret. If you decode or verify tokens anywhere, do not assume HS256. It cost me a round of debugging; it should cost you none.
  2. **`/auth/me` works WITHOUT `X-Organization-Id`** â€” it has to, since you cannot know which org to name until it answers. Call it right after login, then send the header on everything else. Passing an org the user does not belong to is not an error there; the response simply omits `activeOrganizationId`.
  3. **`POST /auth/context` returns 200**, and your generated client should expect that. It was briefly 201 (NestJS's POST default) â€” fixed. Worth knowing the conformance gate did NOT catch it, because it compares paths and verbs but not status codes; if you hit a status mismatch anywhere, treat it as real and tell me rather than assuming the gate would have caught it.
Verification status: 78 automated checks green â€” 40 unit, 23 RLS persona (live, INV-11 + the D-02 floor revoke proven by direct SQL), 15 schema checks, plus the frozen-schema and conformance gates.
## 2026-07-22 â€” Agent B (session 1)
DONE (all mock â€” Phase 1, brief Â§Phase 1 / phases/PHASE_1_FOUNDATION_SHELL.md):
- `/apps/web` scaffolded standalone (Next.js 16, React 19, TypeScript, Tailwind v4).
- `[locale]` app router (en|ar), no locale auto-detection (ZM-I18N-003) â€” `proxy.ts` only ever reads the persisted `zm_locale` cookie or defaults to `en`, never `Accept-Language`.
- Full RTL plumbing (logical CSS properties, `dir` on `<html>`, mirrored nav/table/tabs) â€” see `docs/specs/RTL_CHECKLIST.md` (new, drafted this session).
- Design system primitives: Button, Input, Select, Table, Modal (native `<dialog>`), Toast, Badge, Tabs, Skeleton, EmptyState/ErrorState.
- `MoneyDisplay`/`MoneyInput` on `decimal.js`; ESLint bans `parseFloat`/`parseInt`/bare `Number()` coercion on non-literal values repo-wide.
- OpenAPI codegen pipeline: `scripts/merge-openapi.mjs` merges frozen `03_API_CONTRACT.yaml` + `API_v3.1.0_OVERLAY.yaml` (incl. the D-10 `demo` field patch on `/auth/me`) â†’ `openapi-typescript` â†’ `lib/api/generated/schema.d.ts`; typed `openapi-fetch` client in `lib/api/client.ts` (Bearer + `X-Organization-Id` + `Accept-Language` + `Idempotency-Key` helper wired per contract cross-cutting rules).
- `lib/api/endpoint-status.ts` â€” mirrors `ENDPOINT_STATUS.md` exactly (all mock); dev-only badge (`MockEndpointBadge`) shows mock/live counts.
- MSW handlers for the 4 Phase 1 endpoints (`/health`, `/auth/me`, `/auth/context`, `/auth/language`); browser worker auto-starts in dev.
- Supabase Auth UI: login, register, verify-email, verify-phone (client-side against Supabase directly per PA-04).
- Role-gated portal shells (supplier/bank/platform) at `/[locale]/{supplier,bank,platform}/...` â€” real path segments, not route groups, since three route groups all named `dashboard/` would collide on one URL; nav config in `components/layout/portal-nav.ts`. Org switcher + language switcher + sign-out in the header; empty/loading/error state patterns on every stub screen.
- Dev-only mock persona picker (`components/dev/DevPersonaPicker.tsx`) lets the three portals be exercised end-to-end today without real backend users â€” not for Phase 9.
- Verified: `next build` and `next lint` both clean; manual smoke test of `/`, `/en/login`, `/ar/login` (RTL confirmed), dashboard redirect chain.
SWAPPED TO LIVE: none â€” no Phase 1 backend endpoints announced yet.
CONTRACT GAPS FOUND: none.
NEEDS FROM A:
- Real Phase 0 seed identity list (establishment numbers, org names) so `lib/mocks/data.ts`'s placeholder personas (Rania Al-Khatib / Al-Mashriq Trading, Omar Haddad / Jordan First Bank, Lina Nasser / Zimmamless Platform) can be replaced with the real seed identities once `docs/specs/SEED_DATA.md` exists, for the visually-diffable mockâ†’live swap (Master Plan 3.4 #3).
- Root workspace config: `/apps/web` currently ships its own standalone `package.json`/lockfile (root `package.json`/`tsconfig.base.json`/`db/` are untracked in the checkout I branched from). Root config is A's by default â€” let me know when it's committed and I'll fold `apps/web` into the workspace rather than doing it myself.
NOTE FOR B (next session): Phase 1 exit bar needs the 4 auth endpoints flipped to `live` in `ENDPOINT_STATUS.md` â€” blocked on A. Also: hit and worked around a Next.js 16.2.11 bug where Turbopack dev throws `TypeError: adapterFn is not a function` on every request as soon as a `proxy.ts` exists (reproduced with a minimal one) â€” `next build` is unaffected, but `npm run dev` now runs `next dev --webpack` explicitly (see comment in `apps/web/next.config.ts`). Revisit if upgrading past 16.2.11.

## 2026-07-23 â€” Unification session (both halves, single session)
Scope: fold Agent B's worktree into `main`, then fix everything the independent Phase 1 audit found in either half. Ownership boundaries were suspended for this session only; both agents resume their own areas at Phase 2.

WORKSPACE: `apps/web` is now a real npm workspace member. Its standalone lockfile is gone (root lockfile is authoritative), its `tsconfig.json` extends `tsconfig.base.json`, it has `typecheck` and `test` scripts, and `next.config.ts` traces from the repo root instead of pinning the old nested-worktree root. Root `npm run lint|typecheck|test` now covers all three workspaces.

PORTS: the API keeps 3000 (the frozen contract's servers block names it); the web app now runs on **3001** via `--port` in its dev/start scripts. `CORS_ORIGINS` already expected 3001, so this makes the two agree rather than changing either.

BACKEND FIXES:
- `TIME_PROVIDER` was registered with `useClass` alongside `SystemTimeProvider`, creating **two instances with separate caches** â€” `main.ts` primed the one no injection site uses. Now `useExisting`.
- Hard rule 6 hole: an org-context-**exempt mutation** (`PATCH /auth/language`) sent without `X-Organization-Id` wrote an audit row with `actor_org_id = NULL`. The guard now adopts the user's sole membership when there is exactly one, and refuses with `ORGANIZATION_CONTEXT_REQUIRED` when the user is multi-org. Exempt **GET**s are unchanged â€” `/auth/me` still works with no context, as it must. Four new guard tests.
- Generic 403s were labelled `ORGANIZATION_CONTEXT_REQUIRED` by the exception filter's fallback. New neutral `FORBIDDEN` code; AppException codes unchanged.
- `Money.multiply()` accepted any JS number, undercutting the float ban. Safe integers only (a count of instalments is exact); fractional factors must be strings or Decimals. Three new money tests.
- `db/tools/verify.mjs` no longer disables TLS certificate verification by default (`--insecure-tls` opt-in), and derives the expected migration list from `db/migrations/` â€” the hand-kept literal had silently stopped covering `0004`.
- The RLS persona suite now **throws** instead of skipping when `DATABASE_URL` is absent in CI. A security suite that goes green by not running is the one failure mode that must not look like a pass.

FRONTEND FIXES:
- **Org switching would not have worked against the live API at all.** The client derived `X-Organization-Id` from `me.activeOrganizationId`, but the live `/auth/me` only *echoes* a header the request already carried â€” so no header was ever sent, no org was ever active, and every non-exempt endpoint would have 403'd. The active org is now client-side state (React state + localStorage), defaulted to the first membership after login, healed when a stored id is no longer a membership, and updated on switch. Five new SessionProvider tests against MSW, including that the refetch after a switch carries the NEW org.
- Mock fixtures were **entirely invented** â€” wrong names, wrong org ids, and wrong role strings (`SUPPLIER_OWNER_ADMIN`, `BANK_ADMIN`+`OFFER_APPROVER`, `SUPER_ADMIN`). Since the contract types roles as plain `string[]`, none of that would fail until it met the live API. All fixtures now copy `db/seed/0100_seed_dev.sql` verbatim, and a new test reads the seed SQL and fails if any fixture id, name, email, or role is not in it.
- Added the multi-membership persona (Sara Yaseen, S2+P1). Without it `OrgSwitcher` never rendered, so `POST /auth/context` was unreachable from the UI â€” the org-switch flow is a Phase 1 checkpoint item and could not have been demonstrated. Also added K2's maker and buyers B4â€“B6 (the three blocked registry statuses).
- MSW now honours the mock/live map: `handlers.ts` calls `passthrough()` for `live` entries. Previously every handler was registered unconditionally and `isLive()` was dead code, so flipping an endpoint to `live` changed the dev badge and nothing else.
- The mock `POST /auth/context` now mirrors the live 403 (`ORGANIZATION_CONTEXT_INVALID`, same envelope with `correlationId`) for a non-member org, and `OrgSwitcher` catches it and shows a toast instead of leaving an unhandled rejection.
- `/health` was mocked at `/v1/health`; it lives at the server root. Fixed, and removed from both the code map and ENDPOINT_STATUS.md â€” it is infrastructure, not a contract endpoint.
- Supabase client no longer falls back silently to a placeholder URL/key outside mock mode; it throws naming the missing variable. ESLint money ban extended to `Number.parseFloat`/`globalThis.parseInt` and friends.
- Portal shells are now actually role-gated: a user whose active membership is the wrong organization type is redirected to their own portal. Navigation hygiene only â€” the API guard and RLS remain the real boundary.

GATE: `scripts/contract-conformance.mjs` now compares **success status codes** per path+verb, not just paths and verbs. Verified against a deliberately regressed spec: it catches the exact 201-vs-200 defect that shipped in Phase 1 and passed the old gate. It still does not compare response bodies â€” see Q-04.

DOCS: corrected two factual errors in `PHASE_1_AGENT_A.md` (the "identical 403" handoff note, and 62-vs-61 RLS-enabled tables) with the corrections marked rather than silently rewritten. Filed **Q-03** (Arabic digit set for money) and **Q-04** (`/auth/context` returns an undeclared body).

VERIFICATION: 47 API unit tests, 11 web tests, 23 live RLS persona tests, 15 `db:verify` checks, frozen-schema drift check, conformance gate, `next build` (all routes Ã— both locales), lint and typecheck across all three workspaces â€” all green.

STILL OPEN (unchanged by this session): the API is **not deployed to a public URL**, so the joint Phase 1 checkpoint remains unrun and every ENDPOINT_STATUS entry stays `mock`. That is the first task of Phase 2.

## 2026-07-23 â€” Agent A (session 2, Phase 2)
LIVE: none on a public URL â€” **the API is still not deployed**, so every
ENDPOINT_STATUS entry stays `mock`. Thirteen Phase 2 endpoints are
implemented and verified against the hosted database from localhost:
`/onboarding/register`, `/onboarding/applications-list`,
`/onboarding/applications` POST, `/onboarding/applications/{id}` GET,
`â€¦/submit`, `â€¦/bank-account`, `â€¦/consents`, `â€¦/information-requests`,
`â€¦/respond`, `â€¦/decide`, `/government/lookup`, `/government/requests/{id}`.
Conformance gate: 15/82 paths, no drift on paths, verbs or status codes.

CHANGED (shared surfaces â€” read this section):
  - **`docs/specs/GOV_DUMMY_DATA.md` gained two supplier identities, S4 and
    S5.** Nothing was renamed or renumbered, so your existing fixtures are
    unaffected â€” but please mirror these two, because each exists for a path
    that had no fixture at all:
      Â· **S4 `20000104` Hani Auto Parts Establishment** â€” the only sole
        proprietorship. It is what your ineligibility screen (ZM-SON-013)
        renders. Registering it and submitting produces `REJECTED` with
        reasonCode `SOLE_PROPRIETORSHIP_NOT_ELIGIBLE`.
      Â· **S5 `20000105` Amman Steel Works** â€” all sources answer in full,
        and it is deliberately NOT seeded as an organization. Every other
        full-success supplier already is, so `/onboarding/register` 409s for
        all of them; S5 is the identity to use when you demo register â†’
        submit â†’ approve. Note it is consumed by first use.
  - `GOV_DUMMY_DATA.md` Â§6a is new: the exact CCD/ISTD/GAM normalized field
    keys and value domains (the old Â§8 open item). Your government-data
    panel can be built against that table rather than against guesses.

SEED: new file `db/seed/0200_seed_phase2.sql`, applied to the hosted
database (idempotent, fixed UUIDs, run after `0100`).
  - **12 public holidays.** `business_calendar_holidays` was empty, which
    silently meant "no holidays exist" â€” every holiday branch in the SLA
    arithmetic was unreachable with real data. The lunar Islamic dates are
    approximations, flagged as such in the file and in the spec.
  - **Five applications now exist, spanning every interesting state**:
    APPROVED (Al-Noor, fixed id `0e200000-â€¦-0001`), INFORMATION_REQUIRED and
    paused (Petra, `0e200000-â€¦-0002`, with an OPEN information request),
    GOVERNMENT_SERVICE_UNAVAILABLE (Jordan Valley Foods), APPROVED via the
    full pause/resume cycle (Amman Steel Works), and REJECTED (the sole
    proprietorship). **Only the two `0e200000-â€¦` ids are fixtures** â€” hard-code
    those. The other three were created by registering through the live API
    while verifying, so their ids are random; treat them as queue content,
    not as fixtures.

BLOCKED ON: **the deploy.** Everything in `DEPLOY_RUNBOOK.md` except Â§2
(creating the Render service) has now been executed for real against the
production build, and the runbook is corrected accordingly. Â§2 needs a
hosting account, which I do not have. A `render.yaml` blueprint is committed
at the repo root so it is one action once an account exists. Until then the
Phase 1 checkpoint stays unrun and nothing flips to `live`.

NOTE FOR B â€” five things that will affect your screens:
  1. **A paused SLA has NO deadline.** `slaDeadlineAt` is `null` whenever
     `slaPaused` is true, by design â€” projecting one from "if it resumed
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
     (ZM-SON-004) â€” it will appear with `sourceKind: GOVERNMENT` and the
     supplier's value is kept behind it for the reviewer.
  4. **`POST /onboarding/register` returns 201 on first call and 200 when
     the user already has an organization**, with the same ids both times.
     It is the only route exempt from `X-Organization-Id`, because the caller
     has no organization yet. Everything else needs the header as usual.
  5. Status codes worth pinning in your client: `submit`, `respond` and
     `decide` all return **200** (not 201); `/government/lookup` returns
     **202**. The conformance gate now checks these, so if you see a
     mismatch it is real â€” tell me rather than assuming the gate caught it.
## 2026-07-23 â€” Agent B (session 2, Phase 2)
Sequencing note, for honesty: this session's Phase 2 work was built on `b/phase1-shell` **before** merging the unification commit above, because that branch did not contain `docs/plan/11_PHASE_2_KICKOFF_B.md` and the kickoff's Step 0 was therefore never seen. Everything below is the state **after** merging `origin/main` and reworking against it. The behavioural work survived the merge; the infrastructure assumptions did not, and what changed is listed under REWORK.

DONE (all mock â€” `phases/PHASE_2_ONBOARDING_GOVERNMENT.md`, Agent B tasks). All 8 in-scope screens:
- Supplier: bootstrap form (D-04 `/onboarding/register`), 4-step wizard (identity review â†’ licence review â†’ consents â†’ bank account), SLA tracker, information-request inbox + response form, conditional-approval banner, ineligibility notice (ZM-SON-013).
- Platform: review queue (status filter + pagination off D-05), application detail with the government data panel, decision form (approve / conditional / info-required / reject with reason code).
- The three things the kickoff flagged as where this phase goes wrong: government fields are read-only with source badge + retrieval date and no editable variant exists anywhere (ZM-SON-003 binds administrators too); `GOVERNMENT_SERVICE_UNAVAILABLE` renders as paused-not-adverse with copy saying so, and a regression test asserts its badge tone stays neutral; `APPROVED_CONDITIONAL` gets a banner plus a real gate on all five supplier financing routes, wired now rather than when those screens ship.
- Stateful MSW store reproduces the Â§5.5 state machine, so submit â†’ info request â†’ respond â†’ decide is drivable by persona switching rather than only inspectable.

REWORK after merging `origin/main` â€” the audit fixes applied to my half, carried forward:
- **Fixtures rebuilt on the frozen identities.** My Phase 2 fixtures had the same defect the audit found in Phase 1: invented names and numbers. They are now S1 Al-Noor (`20000101`, DRAFT â€” the wizard), S2 Petra (`20000102`, paused on an information request, GAM partial), S3 Jordan Valley Foods (`20000103`, ISTD unavailable â€” GOV_DUMMY Â§2 designates this supplier as the SLA-pause scenario). Org ids copied from `db/seed/0100_seed_dev.sql`.
- **Adapter variants now key off the frozen Â§5 injection keys** (`90000001` UNAVAILABLE, `90000002` NOT_FOUND, `90000003` PARTIAL), replacing a last-digit convention I had invented. There is now a test asserting `90000001` and `90000002` stay distinguishable â€” that pair is the fourth defining behaviour.
- **Added the `platform-reviewer` persona** (Maha Darwish, seeded). `decide` requires `PLATFORM_SUPPLIER_REVIEWER`, which `platform-admin` does not hold â€” without her the review queue could be read but never acted on. `data.spec.ts` passes, so she is genuinely in the seed.
- **Handlers rewritten onto `mockOnly()`/`passthrough()`** so the Phase 2 endpoints honour the mock/live map like the Phase 1 ones, and onto the real error envelope with canonical codes (`VALIDATION_FAILED`, `NOT_FOUND`, `INSUFFICIENT_ROLE`, `INVALID_STATE_TRANSITION`) instead of the ad-hoc ones I had invented.
- **`useMyApplication` reads `activeOrganizationId` from `useSession()`**, not `me.activeOrganizationId` â€” and re-fetches when it changes, so an org switch reloads the screen.
- **Tests migrated from `node:test` to vitest** (`*.spec.ts`, colocated) now that a runner exists. My separate `tests/` directory and the `node --experimental-strip-types` script are gone.
- My **Q-01..Q-05 renumbered to Q-05..Q-09** â€” `origin/main` had already used Q-01..Q-04. Renumbered in `OPEN_QUESTIONS.md` and in every code comment that cites one.

VERIFIED: 38/38 vitest green (19 domain + 8 state machine + main's 6 seed-parity + 5 SessionProvider); typecheck, lint (web and root-wide), `next build` all clean; i18n parity 258 keys in both locales.
SWAPPED TO LIVE: none. Per A's own instruction, nothing flips until a deployed public URL is announced â€” that is still outstanding, so all 14 endpoints remain `mock`.
CONTRACT GAPS FOUND: **Q-05..Q-09** (filed this session, renumbered) plus **Q-10** (new). Q-05 `governmentData` has no per-field provenance shape Â· Q-06 no `decisionReasonCode` catalogue Â· Q-07 `slaPaused` carries no reason Â· Q-08 no way to list an application's government lookups Â· Q-09 no consent-type catalogue Â· Q-10 no sole-proprietorship identity or injection key, which ZM-SON-013 needs. None is a missing endpoint; each is under-specification inside something the contract declares free-form or as a bare string, so each assumption is isolated to one file. Reasoning in Â§5 of `docs/completion/PHASE_2_AGENT_B.md`.
NEEDS FROM A:
1. **Match three lists exactly or the first integration day 422s**: `lib/onboarding/consents.ts` (4 consent codes @ `1.0`), `lib/onboarding/reason-codes.ts` (13 codes), `lib/onboarding/status.ts` (the Â§5.5 status strings). If the requirements point elsewhere, say so and I will regenerate â€” do not accommodate my guess.
2. **Q-08 blocks a checkpoint item.** The failure drill requires showing a named source as unavailable with the clock paused; without the government-request list on the application I can only say "not yet retrieved" and cannot name which registry went quiet.
3. **Q-10**: please add a sole-proprietorship case to `GOV_DUMMY_DATA.md` â€” Â§5 key `90000006` is my recommendation and what I currently use. Adding is explicitly allowed by that file; I did not edit it, since it is yours.
4. **S3 Jordan Valley Foods needs an organization id.** GOV_DUMMY Â§2 marks it "no (Phase 1 seed)", so its name and establishment number are frozen but it is not in `0100_seed_dev.sql` yet. I am using the placeholder `0e000000-0000-4000-8000-000000000007`, marked as such in `onboarding-store.ts`. Tell me the real id when you seed it â€” it is the single value in that file that has to be reconciled.
5. Thank you for the multi-org persona, K2, B4â€“B6 and the passthrough fix â€” the last of those is the mechanism the whole mock-first strategy rests on, and it is now exercised by 14 more endpoints.

## 2026-07-23 â€” Phase 2 unification session (both halves, single session)
Scope: the Phase 2 audit's fix list (docs/plan/12_PHASE_2_FIX_PROMPT.md), all 24 items. Ownership boundaries suspended for this session only.

CROSS-HALF RECONCILIATION â€” the five places the two halves had quietly diverged, now agreed and validated:
- **governmentData (Q-05 closed):** the client reads the server's real shape `{value, sourceKind, source, retrievedAt}`; the `verificationStatus` field it used to expect never existed. Mock store emits the same shape.
- **Reason codes (Q-06 closed):** one catalogue, two families â€” 13 reviewer-selectable codes + 7 automated hard-rejection codes. Server validates reviewer input against the reviewer set (422 otherwise); automated codes are not reviewer-suppliable. The ineligibility screen now triggers on `SOLE_PROPRIETORSHIP_NOT_ELIGIBLE` â€” the code live data actually carries.
- **Consents (Q-09 closed):** the wizard's four are canonical (`GOVERNMENT_LOOKUP_AUTHORIZATION`, `BANK_DISCLOSURE_AUTHORIZATION`, `TERMS_OF_SERVICE`, `PRIVACY_POLICY` @ "1.0"). Server whitelist on â€¦/consents; â€¦/submit now refuses with `CONSENTS_REQUIRED` until all four are granted; seed vocabulary updated.
- **slaPausedReason (Q-07 closed):** client maps the server's `INFORMATION_REQUESTED` / `GOVERNMENT_SERVICE_UNAVAILABLE`.
- **governmentRequests (Q-08 closed):** application detail now carries the per-source request list (latest per source, `sourceAvailable` included), so the failure drill can say WHICH source went quiet. Q-10 closed via S4 `20000104`; the mock's `90000006` placeholder is gone. The phase file's failure drill now says ISTD, matching GOV_DUMMY_DATA Â§2.

BACKEND (A's half):
- **The outage-recovery path is reachable** â€” a successful `POST /government/lookup` for an application paused on `GOVERNMENT_SERVICE_UNAVAILABLE` re-runs automated verification and resumes (or legally re-pauses). No new endpoint; ZM-GOV-006's no-scheduled-sweeps rule holds.
- **Government endpoints are access-gated** (the audit's security finding): platform roles see everything; anyone else may look up and read only their own establishment number; everything else is the same 404 as not-existing. Any-authenticated-user could previously read any company's registry snapshot by request id.
- `respond` refuses non-empty `documentIds` loudly (422) until Phase 3 documents exist â€” previously silently discarded. `EINVOICE` refused by name (no adapter). Register 409s when the same account sends a *different* establishment number instead of silently echoing the first org. Consents/bank-account writes are state-gated (409 outside DRAFT / INFORMATION_REQUIRED). Production refuses to boot with the published dev `ENCRYPTION_KEY`, not just with none. `FINAL_REVIEW` documented as reserved-not-reachable in the machine and the DTO.

FRONTEND (B's half):
- Mock handlers' API_BASE fallback fixed to 3000 (was 3001 â€” with the env var unset every mock silently missed while the client called 3000).
- Mock `decide` enforces the live transition whitelist and returns the same 409 `INVALID_STATE_TRANSITION`; mock submit lands on `UNDER_REVIEW` (live's observable post-submit state, not the transient `AUTOMATED_VERIFICATION`). NOT_FOUND now modelled on all three sources for a `90000002` identity. Wizard has real copy for `VALIDATION_FAILED`/`INVALID_STATE_TRANSITION` in both locales. Two stale Q-09 comments corrected to Q-05.

SEEDS: S1's consents re-seeded in the canonical vocabulary; S3 Jordan Valley Foods inserted with the fixture org id `0e000000-â€¦-0007` on fresh databases (the hosted row keeps its random id â€” re-pointing a PK across every FK is not worth it; noted in the seed).

VERIFICATION: 154 API tests (was 129; new suites: onboarding-guards, government-access), 41 web tests (was 38), lint/typecheck all workspaces, i18n parity 274 keys both locales, `next build`, frozen-schema drift check, conformance gate â€” all green. `db:verify` and the RLS suite re-run against the hosted project after the seed re-apply.

STILL OPEN: deployment. Unchanged, still the project's #1 risk, still not resolvable from a session. Q-01..Q-04 remain as they were.

## 2026-07-23 â€” Agent A (session 3, Phase 3)
LIVE: none on a public URL â€” **the API is still not deployed**, so every
ENDPOINT_STATUS entry stays `mock`. Fourteen Phase 3 endpoints are
implemented and verified against the hosted database **and hosted Supabase
Storage** from localhost: `/buyers/search`, `/buyers/resolve`,
`/buyers/{id}`, `/documents/upload-url`, `/documents/{id}/download-url`,
`/documents/{id}/extraction`, `/transactions` GET+POST,
`/transactions/{id}`, `â€¦/invoice`, `â€¦/buyer`, `â€¦/minimum-amount`,
`â€¦/declarations`, `â€¦/submit`, `â€¦/verification`.
Conformance gate: 29/82 paths, no drift on paths, verbs or status codes.

CHANGED (shared surfaces â€” read this section):
  - **`/services/ml` now exists and OCR genuinely runs.** The Phase 0
    carry-over "Python is not installed" was wrong: `python` is a Microsoft
    Store stub, but `py` runs 3.13.3. Nothing of yours changes; this is the
    thing your wizard's pre-fill has been waiting for.
  - **Every date the API emits was one day early, and is now correct.** A
    Postgres `date` read as a JS Date lands on LOCAL midnight, so
    `toISOString()` moved it back a day in Asia/Amman. If you built any
    fixture by copying a live response, re-check it.
  - **`docs/specs/EINVOICE_QR.md` is new** â€” the QR payload schemas, the
    four `validationStatus` outcomes, and the seeded e-invoice inventory.
  - `docs/coordination/ENDPOINT_STATUS.md` â€” the 14 Phase 3 rows now carry
    behavioural notes rather than empty cells.
  - `db/tools/migrate.mjs` gained `--rebaseline <name>`. Infrastructure, not
    a shared surface, but it is why migrations run again at all â€” see the
    completion report Â§4.6.

SEED:
  - **`db/seed/einvoices/` â€” five e-invoice PDFs we generate ourselves**
    (`services/ml/tools/generate_einvoices.py`, byte-stable, `--check` mode).
    These are the Phase 3 seed. Purposes are listed in EINVOICE_QR.md Â§7;
    the one you want first is
    `INV-2026-0002-alnoor-levant-mismatch.pdf` â€” its QR says `25000.000`
    while the page prints `24500.000`, which is the deliberate
    extracted-vs-entered mismatch your step 2 has to highlight.
  - **`db/seed/0300_seed_phase3.sql`** â€” five supplierâ†”buyer relationships,
    fixed ids, applied to the hosted database. Aqaba Logistics appears under
    BOTH S1 and S2 with **different contacts**: that is ZM-BUY-008 made
    visible, not a duplicate row.
  - Deliberately **no seeded transactions, invoices or documents**. A
    hand-written invoice row would be a fiction â€” its fingerprint, its
    extraction rows and its stored object are produced by code paths that
    have to actually run. Transactions `ZM-1004`+ on the hosted database are
    residue from my verification run with random ids, exactly like the Phase
    2 queue: real rows, not fixtures.

BLOCKED ON: **the deploy**, unchanged and now three phases old. `render.yaml`
is committed; Â§2 of the runbook needs a hosting account I do not have.

NOTE FOR B â€” nine things that will affect your screens:
  1. **`POST /buyers/resolve` is 200, not 201**, and needs
     `confirmedByUser: true`. `SUSPENDED`/`STRUCK_OFF` are 409
     `BUYER_BLOCKED`. **`UNDER_LIQUIDATION` is 200 with
     `requiresManualReview: true`** â€” a review path, not a refusal (LT-02).
     Please do not render it in the blocked-buyer style.
  2. **There is no finalize call, deliberately.** `upload-url` â†’ you PUT the
     file to the signed URL â†’ done. Hashing and OCR run lazily, so the
     **first** `GET /documents/{id}/extraction` takes ~2â€“5 seconds and
     later ones are instant. Show a pending state. (I built a
     `POST /documents/{id}/finalize`, the conformance gate refused it as
     not-in-contract, and it was right â€” completion report Â§4.5.)
  3. **`qr.validationStatus` has four values and two are not failures.**
     `UNAVAILABLE` = the document carries no QR at all (normal).
     `UNPARSED` = a code was read and no schema recognised it (manual
     review). Same shape as the `90000001`/`90000002` distinction â€” please
     keep them visually distinct.
  4. **`minimumAcceptableAmount` is absent from the bank view entirely**,
     and the 422 refusing an excessive floor does not echo the floor back.
     Do not reconstruct it from the error to show the supplier.
  5. **A false declaration is 422 with `details.notAffirmed[]`** naming
     which of the eight. Surface the list â€” it is better than a generic
     message. (It is 422 and not 400 because it is a business rule, not a
     malformed body.)
  6. **Duplicate submit is 409 `DUPLICATE_INVOICE` with
     `details.reviewReference`** for your blocked screen. It deliberately
     discloses nothing about the other party.
  7. **Money in is a 3-dp string** â€” `"12354"` is rejected, `"12354.000"` is
     accepted. Status codes to pin: `resolve` **200**, `upload-url` **200**,
     `submit` **200**, `POST /transactions` **201**, `declarations` **201**.
  8. **`GET /transactions/{id}` varies by audience** â€” supplier and platform
     get the floor, a bank never does. A bank cannot see an unlisted
     transaction at all (404) until Phase 5 creates listings.
  9. **`buyers/search` never returns a selection**, not even for a single
     100% match, and there is no field in the response that could carry one.
     `candidates[].matchSource` tells you whether a candidate came from this
     supplier's own relationships, the platform, or the registry.

VERIFICATION: 245 API unit tests (was 154), **56 live RLS persona tests**
(was 23 â€” the Phase 2 carry-over is closed: the suite now runs against the
Phase 2 and Phase 3 tables **with rows in them**, and fails loudly rather
than passing vacuously if the fixtures are absent), 95 ML tests (new,
including real rasterizeâ†’OCRâ†’QR over the real seeded PDFs), 36 live
end-to-end checks against hosted Supabase + Storage, `db:verify` 15/15,
frozen-schema drift check, conformance gate, lint and typecheck â€” all green.

Four real defects were found by running things rather than by testing them,
and all four produced plausible-looking output rather than obvious failures:
the one-day date shift above; two OCR label-matching bugs that silently
dropped the seller's name from every Al-Noor invoice; and a duplicate check
that was defeated by the very unique index meant to enforce it (the DB
raised on the *draft*, so a 500 on `PUT â€¦/buyer` meant `submit` never saw a
collision). Completion report Â§4.
## 2026-07-23 â€” Agent B (session 3, Phase 3)
Branched from `origin/main` at `bb832f3` per the kickoff's Step 0, so this
session started on the post-fix baseline rather than repeating Phase 2's
sequencing mistake.

DONE (all mock â€” `phases/PHASE_3_BUYERS_DOCUMENTS_INVOICES.md`, Agent B tasks).
All four in-scope screens:
- **Six-step invoice wizard**: buyer search/select/contact â†’ e-invoice upload
  with OCR pre-fill and the extracted-vs-entered comparison â†’ supporting
  documents â†’ minimum net amount â†’ the eight declarations â†’ review and submit.
  Each step writes through to its own endpoint as the supplier advances, so
  closing the tab at step 4 does not lose steps 1â€“3.
- **Supplier transaction list and detail**, with the verification panel showing
  all eight Â§8.5 checks, and the **duplicate-blocked screen**.
- The three rules this phase turns on: the buyer is **never** pre-selected â€”
  `initialBuyerSelection` always returns null and a test asserts it for the
  single 100%-name-match case ZM-BUY-009 names; corrections are **recorded
  alongside** the machine reading with copy that says so and a test that holds
  the extraction immutable across a correction; a fingerprint collision
  **blocks and keeps the draft** rather than rejecting it.
- All three invoice routes sit behind the Phase 2 `FinancingGate` â€” that gate
  was wired against a placeholder for exactly this screen, so ZM-SON-011 was
  never retrofitted.
- Mock store reproduces the checkpoint sequence including the duplicate pair
  across two suppliers, so submit â†’ blocked-by-fingerprint is drivable rather
  than only inspectable.

VERIFIED: 91/91 vitest (50 new â€” 30 domain, 20 store; the 41 existing all still
green); typecheck, lint and `next build` clean in `web` and root-wide across
all three workspaces; i18n parity **453 keys** in both locales (was 274).

SWAPPED TO LIVE: none. All 15 Phase 3 endpoints stay `mock` â€” the API is still
not on a public URL, which is now the third consecutive phase closing on that
carry-over.

CONTRACT GAPS FOUND: **Q-11, Q-12, Q-13**. Q-11 the duplicate 409's review
reference has no declared key (`Error.details` is free-form) though the phase
file requires the blocked screen to show one Â· Q-12 nothing lists a
transaction's documents, so the detail screen and your Phase 5 underwriting
view have nothing to enumerate Â· Q-13 no declaration template version, though
ZM-INV-004 requires the accepted version to be recorded. None is a missing
endpoint; each is under-specification, each isolated to one file, each
degrading visibly. Reasoning in Â§5 of `docs/completion/PHASE_3_AGENT_B.md`.

NEEDS FROM A:
1. **Q-13 first â€” it is Q-09 repeating, and Q-09 really did bite.** I ship
   `DECLARATION_TEMPLATE_VERSION = "1.0"` in
   `apps/web/lib/invoices/declarations.ts`. If your half accepts anything
   else, `POST /transactions/{id}/declarations` 422s on the first integration
   day and wizard step 5 cannot complete. Tell me your value and I will follow
   â€” do not accommodate my guess if the requirements point elsewhere.
2. **Q-11: please send the review-record id as `details.reviewReference`** on
   the duplicate 409. I currently accept four spellings and fall back to
   showing the correlation id, which is weaker than what ZM-VER-001 implies.
3. **Q-12: `documents[]` on the `Transaction` response.** Not blocking me this
   phase; it becomes blocking for your Phase 5 underwriting view, which lists
   supplier documents by design.
4. **Invoice fixture identities are the one thing I had to invent, and they are
   marked as such.** GOV_DUMMY_DATA Â§8 still owes "which of the 12 invoices
   sits in which of the 11 scenarios" to the Phase 9 seed spec, so there was
   nothing to copy â€” unlike the buyers, which I copied. Everything invented is
   prefixed `MOCK-`: `MOCK-INV-2026-0041` / `MOCK-JO-EINV-88213004`, with a
   deliberate OCR-vs-QR tax discrepancy (`2000.000` vs `2100.000`) standing in
   for your seeded mismatch PDF. When you seed the e-invoices, send me the real
   numbers and which one carries the mismatch.
5. **Please confirm your fingerprint excludes the supplier.** Mine is buyer
   establishment number + invoice number + issue date + face value + tax, per
   D-01 and ZM-VER-001's "platform-wide". There is a test asserting two
   suppliers' identical invoices produce the *same* fingerprint â€” if that ever
   became false the duplicate rule would silently never fire on exactly the
   case the checkpoint is about.
6. Thank you for S4/S5 and Â§6a â€” the sole-proprietorship identity and the
   normalized field table both landed before I needed them this phase.

## 2026-07-23 — Unification session (Phase 3 fix prompt executed)
Executed the Phase 3 audit fix prompt (`docs/plan/15_PHASE_3_FIX_PROMPT.md`) directly on `main`. All 9 items done; acceptance gate green.

CRITICAL FIX — the fingerprint could not catch cross-supplier double-financing (item 1): v1 included the submitting supplier in the hash, so the checkpoint's actual scenario (a second supplier claiming the same receivable) produced a *different* fingerprint and reached ELIGIBLE unblocked. Evidence: A's own `EINVOICE_QR.md` said the seeded `INV-2026-0003` pair "must collide," while the v1 test suite asserted they did NOT collide; a code comment claimed a compensating cross-supplier check existed "below" that was never written anywhere; and the live journey suite's duplicate test only ever resubmitted from the *same* supplier, so the checkpoint scenario was never actually run. Fixed: fingerprint bumped to v2, supplier removed from the key (buyer + invoice number + issue date + face value + tax — matching what B's mock had correctly done since Phase 3 shipped). New live journey test "blocks a SECOND SUPPLIER claiming the same receivable" proves the fix against the hosted stack. `PHASE_3_AGENT_A.md` corrected with visible strikethrough on the falsified rows (never silently rewritten). Hosted DB had zero residual invoice rows at unification time (the journey suite's own teardown and earlier residue were both already gone), so no v1-fingerprint recomputation was needed.

CROSS-HALF RECONCILIATION:
- checkType strings: B's panel/mocks used the §8.5 prose row titles (`DUPLICATE_DETECTION`, `TRANSACTION_LOGIC`, `PARTY_ELIGIBILITY`); A emits shorter forms (`DUPLICATE`, `LOGIC`, `ELIGIBILITY`). Neither violated the contract (`checkType` is a bare string) but three of eight panel rows would have fallen back to raw-code labels live. B aligned to A's strings across the mock store, verification.ts, both locale files, and specs.
- Invoice fixtures: B's `MOCK-INV-2026-0041` placeholders replaced with A's real seeded identities from `EINVOICE_QR.md` §7 (`INV-2026-0001` happy path, `INV-2026-0002` mismatch, `INV-2026-0003` duplicate pair). Correction: B had guessed the mismatch was on *tax* (2000 vs 2100); A's seeded mismatch is on **face value** (page 24500.000 vs QR 25000.000) — the mock's extraction fixture and its comparison logic were rewritten to match.
- Q-13 (declaration template version): pinned to a server-side catalogue (`DECLARATION_TEMPLATE_VERSIONS = {'1.0'}`, `apps/api/src/modules/transactions/declaration-catalogue.ts`) — B's guessed "1.0" was confirmed correct, but A previously accepted any non-empty string, the exact Q-09 failure mode B's own risk note (§6) predicted would repeat. Now 422s outside the catalogue, naming the accepted set.
- Q-11 (duplicate review reference): confirmed `details.reviewReference` live via the journey suite — B's primary accepted spelling was already correct, nothing to change.
- Q-12 (transaction document listing): resolved additively. The contract's marketplace listing schema already declares `documents: [{id, documentType}]`, so this mirrors an existing shape rather than inventing one. `TransactionsService.describe()` now returns `documents[]` (id, documentType, fileName, uploadedAt) for SUPPLIER/PLATFORM audiences. B's transaction detail screen now lists them with a per-document signed-download link requested on click (not pre-fetched, since the URL lives ~2 minutes); `GET /documents/{id}/download-url` now has a consuming screen.

VERIFICATION: 254 API tests (was 245, +9 new in `transactions-guards.spec.ts`: Q-13 catalogue, Q-12 documents[]), 91 web tests (fixture/checkType rewrites, no net count change), 95 ML tests unchanged, lint/typecheck all workspaces, i18n parity 455 keys (was 453 — 2 new: documents.download, documents.downloadUnavailable), `next build`, frozen-schema drift check, conformance gate — all green. Phase 3 journey integration suite (`npm run test:journey`) run live against the hosted database, hosted Supabase Storage and the real ML service — 28/28 passing, including the new cross-supplier duplicate test. `db:verify` 15/15.

STILL OPEN: deployment (Q-01..Q-04 unaffected, still open). Unchanged, still the project's #1 risk — three phases have now completed without it, and Phase 4 adds a second service (ML/risk inference) to deploy.

## 2026-07-23 — Agent A (session 4, Phase 4)
Branched `a/phase4` from `main` at `76d10bf`, clean tree per the kickoff's
Step 0. All of B's `NEEDS FROM A` items were already closed by the
unification session — nothing outstanding was found.

DONE (`phases/PHASE_4_RISK_ML.md`, Agent A tasks — all 13 items):
Trust Score end to end. `GET /transactions/{id}/risk` returns a composite
0–100, an AS-05 band, the five ZM-RSK-004 components, `dataAvailabilityPct`
on a separate track, positive/risk/reason codes, model version, `mlUsed`, and
a bilingual disclaimer. `GET`/`POST /admin/risk-models` manage versions.
**`/services/ml` now has a real, executable training and inference pipeline**
(ZM-RSK-014): deterministic seeded synthetic data, a logistic regression
trained by `tools/train_risk_model.py`, recorded metrics, and per-prediction
explainability. `docs/specs/ML_DESIGN.md` documents all of it, limitations
first.

CHANGED (shared surfaces — read this section):
  - **A ZM-RSK-013 hole in my own Phase 1 work, now closed.** Migration 0003
    left `risk_model_versions` world-readable, so any authenticated bank user
    could read the scoring weights straight from the Supabase client and
    reconstruct exactly what the API withholds. Migration `0006` revokes
    `weights` and `training_metrics`; `db:verify` now checks both (17 checks,
    was 15). Nothing of yours changes.
  - **Migration `0006_phase4_risk.sql`** also inserts the baseline active
    model version. It is a migration rather than a seed because a hosted
    database with no seed must still be able to score.
  - Nothing renamed. The eight `checkType` strings are untouched.

SEED: none. The model artifact
(`services/ml/app/risk/model_artifact.json`) is committed and byte-stable —
`py -m tools.train_risk_model --check` retrains and asserts it reproduces
exactly, the same discipline as the e-invoice PDFs.

BLOCKED ON: **the deploy**, unchanged and now four phases old. Phase 4 adds a
SECOND service to deploy — the ML service must be up for the model to be
used. `render.yaml` is committed; §2 of the runbook needs a hosting account I
do not have.

NEEDS FROM A → answered for you already; NOTE FOR B — seven things for the
risk components:
  1. **A component score may be `null`.** A component whose every signal was
     unavailable scores null, never 0 — zero would be a judgement we have no
     basis for. Render "not scored", not an empty bar at zero. Defensive
     today (every component has at least one always-known signal), but it is
     a real shape and I would rather you branch on it than discover it.
  2. **`dataAvailabilityPct` is a NUMBER, not a string**, and is separate
     from the score by construction. Style it neutrally — never a warning
     colour, never a downward arrow. A supplier whose registry was down has
     done nothing wrong, and this is the field that says so.
  3. **Reason codes are a catalogue** with four families by prefix:
     `BLOCK_` (hard blocker), `RISK_` (adverse — lowers a component),
     `POS_` (positive), and **`INFO_` (never moves the score)**. Please do
     not render `INFO_` codes in a risk-coloured list; they describe gaps in
     what WE could see, not facts about the supplier. Source of truth:
     `apps/api/src/modules/risk/reason-codes.ts`. Copy the codes, the strings
     are yours in both locales.
  4. **`mlFallbackReason` appears only when `mlUsed` is false**, and is
     always non-empty in that case. Surface it. A degraded score a banker
     cannot tell is degraded is the exact failure ZM-RSK-017 exists to stop —
     and it is not hypothetical, see VERIFICATION below.
  5. **`INFO_SYNTHETIC_TRAINING_DATA` is on every score** — your hook for the
     ZM-RSK-016 synthetic-data limitation notice.
  6. **The disclaimer arrives already localized** from the user's
     `preferred_language`; render it verbatim on every score display. You do
     not need to key it.
  7. **Banks get no weights, coefficients, or raw probability** — the payload
     is an allow-list and there is a test asserting the serialized bank body
     contains none of them. Do not build a screen expecting them.

VERIFICATION: 293 API unit tests (was 254), **96 live integration tests**
(was 84 — including the Phase 4 checkpoint's two drills), 122 ML tests (was
95), `db:verify` 17/17, frozen-schema drift check, conformance gate 31/82
with no drift, model artifact reproducibility, e-invoice byte-stability, lint
and typecheck across all workspaces — all green.

The ML fallback proved itself during development rather than in a test I
wrote for it: the journey suite failed with `mlUsed: false` because the ML
process was still serving a build from before `/risk/score` existed. A real
score came out, and the degradation was visible enough to stop the suite. A
silent fallback would have shipped.

FLAGGED AGAIN FOR THE PRODUCT OWNER — **Q-03 (Arabic digit set)**, per the
Phase 4 kickoff. Still OPEN, still needed before Phase 6 Arabic templates. It
is slightly more pressing now: Phase 4 ships the **first Arabic prose the API
itself emits** (the Trust Score disclaimer), so the question is no longer
confined to `apps/web`.

## 2026-07-23 — Agent A (session 5, Phase 5)
Branched `a/phase5` from `a/phase4`. The confidential marketplace is live end
to end against the hosted database.

DONE (`phases/PHASE_5_MARKETPLACE_OFFERS.md`, Agent A tasks — all 11 items):
Listing activation with the fee obligation and a balanced ledger journal;
policy-filtered eligibility recorded **for every bank, eligible or not**, with
the rules that produced each decision; maker/approver offers with all money
computed server-side; the deadline sweep; the three v3.1.0 endpoints
(D-06/07/08) and the D-12 `PATCH`. Twelve endpoints, taking the conformance
gate to **44/82 with no drift** (was 31/82).

CHANGED (shared surfaces — read this section):
  - **Migration `0007_phase5_commission_tiers.sql`** — three active tiers
    (1.5% / 1.25% / 1.0%, half-open bands, top tier open-ended). A migration
    rather than a seed because ZM-FEE-011 prices every offer from the active
    tier: a migrated database with no dev seed could not price an offer at
    all. Additive only — three rows, no column, constraint, policy or
    response-shape change.
  - **`transactions/dto.ts` and `money.ts`** now share `MONEY_PATTERN` /
    `MONEY_MESSAGE` instead of each restating the 3-dp regex. Same accepted
    strings, same messages; nothing you send changes.
  - Nothing renamed. No response shape you already consume was altered.

SEED: `npm run db:scenario:phase5` — the checkpoint fixture. Note it is a
**script that calls the API**, not SQL, and that is deliberate: a listing is
not a row (fee obligation, ledger journal, per-bank eligibility with
`rules_applied`, notifications, state change) and neither is an offer (tier
commission, listing-fee component, server-recomputed net under a database
CHECK). Hand-written SQL would give you a listing that looks right on screen
and was never priced, evaluated or audited. It is idempotent and has
`--status` and `--purge`. It leaves both offers in
`PENDING_INTERNAL_APPROVAL` on purpose — approving them would consume the
checkpoint's best moment.

BLOCKED ON: **the deploy**, unchanged and now five phases old, and per the
product owner now a deliberate deferral rather than an impediment: verify
locally, deploy when the account exists. Worth stating plainly so nobody
reads the checkmarks as "it is up".

NOTE FOR B — six things about the marketplace, all of which will bite if
assumed otherwise:

  1. **The floor does not exist in your bank-side data.** Not null, not
     redacted — absent. `describeForBank` is built additively from an empty
     object, and there is a test that byte-scans every bank-facing response
     for a sentinel floor value. If your underwriting view has a field for
     it, delete the field.
  2. **`offerCount` is supplier and platform only.** A bank must not learn
     how many competitors exist, including by counting array length — the
     bank's `/listings/{id}/offers` returns its own offer or nothing.
  3. **`netSupplierPayout` is the server's number.** You may send yours and
     the server will compare; a mismatch is a 422 that names the
     disagreement, not a silent correction. Preview live in the form, always
     reconcile to the response.
  4. **Do not send `platformCommissionAmount` or `listingFeeAmount`.** They
     are not in `OfferInputDto`, and `forbidNonWhitelisted` means sending
     them is a 400 naming the property rather than a silent ignore. That is
     the friendlier failure: a bank computing its own commission has a
     misunderstanding worth surfacing.
  5. **The below-floor 422 carries no numbers, ever.** `OFFER_BELOW_SUPPLIER_
     REQUIREMENT` with a generic message. Do not add "you were X short" —
     there is no X: `meetsFloor` returns a bare boolean so the shortfall is
     never computed anywhere in the process.
  6. **The submission window is decided by listing *status*, not by
     comparing the clock.** After the sweep closes it, create/revise/withdraw
     all 409. Render the countdown from `offerSubmissionDeadline`, but let
     the server decide.

VERIFICATION: 328 API unit tests (was 293), **128 live integration tests**
(was 96), 122 ML tests, `db:verify` 17/17, conformance 44/82 with no drift,
lint and typecheck across all workspaces — all green. The checkpoint scenario
was created and then re-run to confirm idempotency; both offers came back
with nets matching the arithmetic predicted in the script's comment to the
millifils, which independently confirms the tier lookup and listing-fee
injection.

TWO TESTS I HAD TO FIX BECAUSE THEY WERE WRONG, not because Phase 5 broke
them — both worth knowing about:
  - My INV-12 self-approval test passed **for the wrong reason**. It used a
    plain maker, who is stopped by the route guard with `INSUFFICIENT_ROLE`
    before the self-approval check ever runs. The invariant was untested and
    green. Now driven by a BANK_ADMIN (who holds both capabilities) plus a
    separate test against the `chk_maker_approver_differ` database
    constraint, so neither layer can pass on the other's behalf.
  - `rls-phase3` asserted a bank sees **zero** transactions. Phase 5 made
    that false *correctly* — a bank now sees a transaction it was found
    eligible for. Narrowed to the claim it was always about.

FLAGGED AGAIN — **Q-03 (Arabic digit set)**. Now genuinely pressing: Phase 6
ships Arabic contract templates, which is prose with numbers in it on a
document a supplier signs.

## 2026-07-23 — Agent A (session 6, Phase 6)
Selection and contracts. This phase holds the code the brief calls the
highest-risk in the system, and most of what follows is about how that claim
was tested rather than how it was written.

DONE (`phases/PHASE_6_SELECTION_CONTRACTS.md`, Agent A tasks — all 12 items):
Atomic offer acceptance exactly per brief §5, in one transaction with a real
row lock; the INV-4 immutability trigger; reject-all; the contract template
engine with four seeded templates (EN + AR, per type + fallback); the
ZM-CON-006 pre-contract checks; contract generation with a stored HTML
document and a hash; the dummy `SignatureProvider` with separate sign and
verify; conditions with derived `CONDITIONS_PENDING`. Seven endpoints.

CHANGED (shared surfaces — read this section):
  - **Migration `0008_phase6_contracts.sql`** — the INV-4 trigger on
    `receivable_transactions`, the AS-01 `offer_acceptance_roles` setting,
    and four contract templates. Additive only; no column, constraint,
    policy or response shape altered. `db:verify` is now 20 checks (was 17).
  - **The `documents` storage bucket now accepts `text/html`** — for
    server-generated contract documents only. The *user upload* allow-list is
    unchanged and deliberately still excludes it: a supplier-uploaded HTML
    file lands in a bucket whose download URLs go to other organizations'
    browsers. Nothing you upload changes.
  - **`transaction-state.ts`** gained OFFER_ACCEPTED / CONDITIONS_PENDING /
    CONTRACTED transitions. Nothing existing was removed.
  - Nothing renamed.

SEED: none new. `npm run db:scenario:phase5` still produces the listing with
two approvable offers, which is now also the starting point for the Phase 6
demo — approve them, then accept.

BLOCKED ON: **the deploy**, unchanged, six phases old, deliberately deferred.

TWO THINGS I BROKE OR FOUND IN MY OWN EARLIER WORK:

  1. **The seed has been creating duplicate bank organizations since Phase 1,
     and the hosted database now holds three copies of each bank.**
     `db/tools/seed.mjs` used `ON CONFLICT DO NOTHING` with a lookup
     fallback — but `uq_org_national_no` is a PARTIAL index covering
     suppliers only, so banks had nothing to conflict with, the insert always
     returned a row, and the fallback was never reached for exactly the org
     types that needed it. The seed is fixed (it looks before inserting). The
     **existing duplicates are still there** and need a remap-and-delete
     pass — they carry memberships, so it is a data migration, not a seed
     re-run. Practical consequence for both of us: `memberships[0]` from
     `/auth/me` is ordering-dependent and can name a duplicate. If you pin an
     organization id anywhere, pin the canonical `0e000000-…` one.
  2. Three schema assumptions I wrote before reading, all caught by the live
     suite: `invoices` has no `status` column (cancellation is on the
     transaction's state); `invoice_declarations` is one row of booleans per
     transaction, not a row per key; `supplier_bank_accounts` stores
     `iban_enc bytea`, not plaintext.

NOTE FOR B — seven things about acceptance and contracts:

  1. **`/accept` returns the SNAPSHOT, not the offer**, and it is a **200**,
     not a 201. It takes **no request body** — every commercial term is
     already fixed on the offer, and a body would invite a client to restate
     a figure that can then disagree.
  2. **A replayed accept returns the original snapshot with 200**, not an
     error. Safe to retry on a dropped connection; the modal does not need to
     guard against a double-click producing a scary message.
  3. **Acceptance is irreversible and the database enforces it.** There is no
     unlock. Say so in the confirmation modal in those words — the phase file
     asks for "atomic and irreversible" and it is literally true, down to a
     trigger that refuses to clear the lock.
  4. **A second accept on the same transaction is 409
     `TRANSACTION_ALREADY_LOCKED`.** Render it as "another offer was accepted"
     rather than as a failure the user can retry.
  5. **Contract generation can fail with a LIST.** 422, with
     `details.findings` as an array of `{code, message}`. Render all of them
     as a checklist — that shape is deliberate, so the supplier is not
     drip-fed one blocker at a time.
  6. **`documentHash` is over the exact bytes the API stored.** If you render
     the contract yourself from `termsSnapshot` instead of displaying the
     stored document, the hash on screen stops meaning anything. Serve what
     the API produced.
  7. **A signature is only real once `status === 'VERIFIED'`.** `SIGNED` is
     an intermediate the dummy provider passes through in milliseconds and a
     real provider will sit in for minutes. Drive the UI off VERIFIED, and
     `FULLY_SIGNED` off the contract's own status, not off counting rows.

VERIFICATION: 383 API unit tests (was 328), Phase 6 live integration suite
(32 checks incl. the concurrency harness), `db:verify` 20/20, lint and
typecheck clean across all workspaces.

The harness is the part worth knowing about: two accepts on different offers
of the same transaction, fired without awaiting either, repeated 8 times, and
then asserted **against the database** rather than only the HTTP statuses —
one SELECTED, one NOT_SELECTED, one selection row, one snapshot, and
`locked_by_offer_id` pointing at the offer that actually won. Every other
test in the phase would pass against a naive read-then-write implementation.
Only this one would not.

FLAGGED — **Q-03 (Arabic digit set) is now overdue.** This phase ships the
first Arabic legal prose in the product: the AR contract template, with
amounts and dates, on a document a supplier signs. I used Arabic-Indic
section numbers and Western digits for money — the common Jordanian banking
convention, but my assumption standing in for a ruling, and now baked into a
contract template rather than a UI label.

  8. **A contract does NOT need every listed signatory to sign.** ZM-CON-010's
     default is one authorized supplier signatory and one authorized bank
     signatory. A bank with two signatories gets two PENDING slots because
     either may sign — not because both must. The unsigned slot stays PENDING
     after FULLY_SIGNED, deliberately: that person did not sign, and the
     record says so. Drive the UI off `contract.status`, not off "are all
     signature rows verified". (I had this wrong first — the live run caught
     it at two-of-three verified.)
## 2026-07-23 — Agent B (session 4, Phase 4 + Phase 5 head start)
Branched from `origin/main` per the kickoff's Step 0. Agent A had not started
Phase 4 at the start of this session (no daily-log entry, no `ML_DESIGN.md`)
— expected, since B's Phase 4 scope is light and mock-driven from day one.

DONE (mock — `phases/PHASE_4_RISK_ML.md`, Agent B tasks; all five items):
- `TrustScoreGauge`, `ComponentBars`, `FactorList`, composed into one
  `RiskPanel` so the disclaimer/model-version/fallback block is never
  forgotten by a future consumer.
- **`dataAvailabilityPct` is structurally incapable of a warning tone** —
  `dataAvailabilityNeutralTone()` has no code path returning anything but
  `"neutral"`, which a CI test asserts directly rather than just documenting.
  Shown as its own row (a Badge, never a bar) below a divider in
  `ComponentBars`, with an explanatory tooltip.
- Disclaimer sourced from i18n on every score display, both languages —
  deliberately not from `assessment.disclaimer`, whose locale the contract
  doesn't guarantee (see completion report §4 for why this isn't a filed
  question).
- **INV-9 fully covered client-side**: identical inputs differing only in
  `sourceAvailability` produce byte-identical components and composite score
  across every single-source-down permutation and the all-down case, at both
  the pure-engine level and the mock-store assembly level that the endpoint
  handler actually calls.

Remaining B capacity spent on the Phase 5 head start the kickoff named
("marketplace feed, offer form skeletons"):
- Bank marketplace feed (`GET /marketplace/eligible`) and underwriting view
  (`GET /marketplace/listings/{id}`) — real screens, but a **static
  two-listing stub**, not your real policy-filter eligibility engine, which
  doesn't exist yet. The underwriting view is the risk components' first
  real consuming screen.
- Offer form skeleton: every field the phase file names, real catalogues
  (transaction/recourse/condition types with plain-language explanations),
  **submission deliberately not wired to a mock endpoint**. Commission and
  listing fee are named but show no number — inventing an estimate would
  have been the same invented-value defect the Phase 1/2/3 audits each
  caught in a different form, one field earlier.
- NOT attempted: listing activation, policy filters, approval queue, "my
  offers", offer comparison. Real Phase 5 work, not this head start.

VERIFIED: 116/116 vitest (25 new — 20 risk-engine, 5 risk-store; the 91 from
Phase 3 all still green); typecheck, lint and `next build` clean in `web` and
root-wide across all three workspaces; i18n parity **559 keys** (was 455).

SWAPPED TO LIVE: none. 5 more endpoints join the mock board (2 risk, 3
marketplace) — 36 mocked, still zero live, four phases running on the same
undeployed-API carry-over.

CONTRACT GAPS FOUND: none filed. Two candidates considered and both resolved
without escalation — the disclaimer's locale is unambiguously the client's
job regardless of what the API sends (unlike Q-03/Q-05, there's no ruling for
a product owner to make), and the risk factor/reason-code vocabulary is
response-only display text with no validation consequence on a mismatch
(unlike Q-06/Q-13, a mismatch here is cosmetic, not a 422). Reasoning in §4-5
of `docs/completion/PHASE_4_AGENT_B.md`.

NEEDS FROM A:
1. **Nothing blocking.** The demo risk engine (`lib/risk/risk-engine.ts`) is
   a stand-in only — none of its formulas need to survive contact with your
   real one. The one property worth preserving exactly is the separation
   itself: `dataAvailabilityPct` must be computable from a wholly different
   input than the five components, with no shared code path, which is what
   ZM-RSK-005/006/008 actually require.
2. A translation table for risk factors/reason codes already exists
   (`messages/{en,ar}.json` → `risk.factor.*`, `risk.reasonCode.*`) if
   reusing the keys is useful — not a request to match them, since
   `FactorList` renders anything unrecognised as-is.
3. **The marketplace/underwriting stub uses one invented invoice identity**,
   `INV-2026-0004`, flagged the same way Phase 3's `MOCK-` numbers were:
   nothing in `EINVOICE_QR.md` §7 assigns a fourth listing-ready invoice.
   The whole `lib/mocks/marketplace-store.ts` file is disposable once your
   real listing/eligibility endpoints land — it was never meant to model
   your engine.
4. The demo engine's fixed baselines mean it cannot produce a `CRITICAL`
   band (floor sits around 29, inside `HIGH`) — noted in case anyone goes
   looking for a `CRITICAL` listing in the mock data for a screenshot before
   your real engine replaces it.

## 2026-07-23 — Agent B (session 5, Phase 5)
No Phase 5 kickoff document existed for B (only the phase's own master plan
file, `phases/PHASE_5_MARKETPLACE_OFFERS.md`) — used as the scope reference,
since its "Agent B tasks"/"Screens in scope" sections are unambiguous.
Agent A had not started Phase 5 at the start of this session.

DONE (all mock — all nine screens the phase file names for B):
- Supplier listing-activation screen: fee shown with amount and the
  "applies regardless of outcome" warning **before** confirmation;
  deadlines shown only after activation, computed from the ZM-MKT-007
  defaults — never supplier-chosen (ZM-MKT-008).
- Bank marketplace feed + underwriting view, now backed by **real
  per-bank policy-filter eligibility** (ZM-MKT-002) instead of Phase 4's
  static two-listing stub — which is gone, along with its one invented
  invoice identity.
- Offer creation form wired to a real create endpoint: live client
  preview of commission/listing fee/net (same pure formula the mock
  "server" uses, so it can't disagree with what's persisted); below-floor
  422 renders the generic message only, revealing no number
  (ZM-MKT-012's design note) — proven by a store test asserting the
  rejection's return value carries nothing but `{ok, error}`.
- Approval queue: creator shown; the approve action is **hidden**, not
  disabled, for the offer's own creator; server independently rejects
  self-approval (ZM-ROL-002/ZM-OFR-016).
- "My offers" (withdraw, no penalty pre-acceptance), policy-filter
  configuration (create/activate/deactivate, D-12), and the supplier
  **offer comparison screen** — net payout as the visual anchor, every
  offer's transaction/recourse type with plain-language explanations,
  **no default sort by amount, no "best" marking anywhere** (offers render
  in submission order), live countdown to the selection deadline.
- Bank offer-status view: `Offer` never carries another bank's data at the
  type level, so nothing here could leak a competitor.
- Rewrote `lib/mocks/marketplace-store.ts` from a static stub into a real
  store: listings only exist because a genuinely `ELIGIBLE` transaction was
  activated; eligibility persisted per bank with the rules applied
  (ZM-MKT-003); full offer lifecycle (create/revise/withdraw/approve) with
  immutable version history.

VERIFIED: 154/154 web vitest (38 new — 9 offer-money, 10 policy-filters, 19
marketplace-store; all 116 from Phase 4 still green), 254/254 API jest
unchanged; typecheck, lint and `next build` clean in `web` and root-wide
across all three workspaces; i18n parity **629 keys** (was 559). Manual
smoke: `/bank/marketplace`, `/bank/offers`, `/bank/settings/policy-filters`,
`/supplier/invoices` all 200 against the dev server.

SWAPPED TO LIVE: none. 14 more endpoints (the full marketplace/offer/policy
surface) join the mock board — 50 mocked, still zero live, five phases
running on the same undeployed-API carry-over.

CONTRACT GAPS FOUND: **Q-14**. `Offer` has no field naming the maker who
created it, though the phase file requires the approval queue to show
"creator" and block self-approval in the UI as well as the server. Not
blocking — carried past the typed response on the two bank-scoped endpoints
that need it. Reasoning in OPEN_QUESTIONS.md and completion report §5.

NEEDS FROM A:
1. **Nothing blocking.** `lib/mocks/marketplace-store.ts` is a stand-in
   only. The properties worth preserving exactly: the floor rejection
   carries zero numeric detail; `BankListingView` never contains
   `minimumAcceptableAmount` or `offerCount`; self-approval independently
   rejected server-side.
2. **Q-14**: an `Offer` a bank reads about its own submission needs to name
   who created it.
3. Commission is a flat 1.5% demo rate with no tier lookup — your real
   `CommissionTier` (ZM-FEE-011) can differ freely; nothing asserts the
   demo rate as correct.
4. Two of ZM-MKT-001's ten filter rows (sector; the two per-offer-type
   filters) are configurable in the UI but evaluate no rule — no sector
   field exists anywhere in the frozen contract, and transactionType/
   recourseType are chosen per offer, not known at listing time. Worth
   confirming your eligibility engine's intent here.
5. The marketplace is empty on a fresh environment until a real invoice
   reaches ELIGIBLE and is listed — correct (no invented listings) but
   worth a seed helper if a checkpoint demo needs a populated feed
   immediately.

## 2026-07-23 — Agent B (session 6, Phase 6)
No Phase 6 kickoff document existed for B either — used the phase's own
master plan file, `phases/PHASE_6_SELECTION_CONTRACTS.md`, as the scope
reference, same as Phase 5. Agent A had not started Phase 6.

DONE (all mock — all six screens the phase file names for B):
- Acceptance confirmation modal (atomic-and-irreversible, full breakdown
  one last time) + result screen, and a reject-all flow with its own
  confirmation, both on the offer comparison screen.
- Post-acceptance transaction timeline (OFFER_ACCEPTED → CONDITIONS_PENDING
  → CONTRACTED) on the supplier's transaction detail.
- Conditions checklist with a fulfil action; contract review screen on
  both portals (rendered terms, template version, EN-governs note);
  click-to-accept signing — the sign button is **hidden**, not disabled,
  for a non-signatory, and the server independently enforces the same
  boundary.
- Bank result screens: SELECTED/NOT_SELECTED, with an explanatory note
  that zero competitor information is shared — `Offer` never carried that
  data at the type level to begin with, so this was mostly copy + a
  contract link.
- `acceptOffer` (extended into `lib/mocks/marketplace-store.ts`): every
  observable invariant §12.1 lists, enforced in-memory — the transaction's
  `lockedAt` check comes first, so a second acceptance on any offer on the
  same listing is impossible once the first lands; an idempotency-key
  cache makes a network retry return the exact original result instead of
  re-executing; every other active/pending offer flips to NOT_SELECTED in
  the same call; the snapshot is written before the function returns.
- `lib/mocks/contract-store.ts` (new): contract generation gated by all
  four ZM-CON-006 checks, a real per-transactionType EN+AR template engine
  reading only the frozen snapshot, click-to-accept signing requiring one
  signature per side before FULLY_SIGNED and the transaction moving to
  CONTRACTED.

A REAL BUG CAUGHT BY A TEST: `signContract` updated the contract's own
status to FULLY_SIGNED on the second signature but never moved the
*transaction* to CONTRACTED — a one-line miss that "looked right" reading
the code (the contract-status update was correct; the state side effect
one branch later was missing). The FULLY_SIGNED test failed immediately
or it would have shipped silently broken. Fixed.

VERIFIED: 187/187 web vitest (25 new — 14 contract-domain, 11
contract-store, +15 appended to marketplace-store's spec for acceptance;
all 154 from Phase 5 still green), 254/254 API jest unchanged; typecheck,
lint and `next build` clean in `web` and root-wide across all three
workspaces; i18n parity **678 keys** (was 629). Manual smoke:
`/supplier/contracts`, `/bank/offers`, `/supplier/invoices` all 200
against the dev server.

SWAPPED TO LIVE: none. 7 more endpoints (accept, reject-all, contract
GET/POST, sign, conditions GET, fulfil) join the mock board — 57 mocked,
still zero live, six phases running on the same undeployed-API carry-over.

CONTRACT GAPS FOUND: **Q-15**. `AcceptedOfferSnapshot` is missing half its
money components against ZM-SEL-007's "every money component," and
`conditionsSnapshot` is typed as an array of objects with no declared
properties at all (stricter than free-form). Not blocking — same
widen-the-type pattern as Q-14, also used to carry the rendered contract
text and each signature's organization type past the declared `Contract`
shape. Reasoning in OPEN_QUESTIONS.md and completion report §6.

NEEDS FROM A:
1. **Nothing blocking.** The properties worth preserving exactly from the
   mock: idempotency-key replay must return the original result, not
   re-execute; every other active/pending offer must flip to NOT_SELECTED
   in the same operation that selects the winner; FULLY_SIGNED (and
   CONTRACTED) must require both a supplier and a bank signature.
2. **Q-15**: the snapshot/contract need the full money breakdown, a real
   conditions shape, and something for the client to read contract text
   from if not a signed-URL document pattern like Phase 3's.
3. Reject-all's listing status (CANCELLED) is a guess at the closest fit
   in the declared enum — confirm your real engine's value.
4. AS-01's acceptance role gate is enforced against SUPPLIER_OWNER
   specifically (the only seeded role matching "Owner/Admin") — reconcile
   if your real role set differs.

## 2026-07-23 — Agent A (session, post-review remediation)
LIVE: none newly deployed. Backend hardening only, all against the hosted DB.
CHANGED (shared surface — read this):
  - `POST /offers/{id}/accept` now ENFORCES the `Idempotency-Key` header the
    frozen contract already marked `required: true`. A flagged request with no
    header is refused **400 `IDEMPOTENCY_KEY_REQUIRED`**. This is the one built
    endpoint the contract flags; funding/settlement/payment/recourse get the
    same treatment as they are built (Phases 7-9). Your mock already models
    replay (your NEEDS #1) — the live behaviour now matches it: same key →
    original response replayed, no re-execution; same key + different request →
    **409 `CONFLICT`**; a failed attempt releases the key so a corrected retry
    can reuse it. **Action for B:** send an `Idempotency-Key` (a fresh uuid per
    logical accept) when you promote `offers/{id}/accept` to live, or it 400s.
  - Document uploads are now content-sniffed at finalize: a file whose bytes
    contradict its declared `mimeType` (e.g. an HTML/script payload labelled
    `application/pdf`) is refused **422 VALIDATION_FAILED** the first time the
    server reads it (extraction, or transaction submit). No contract-shape
    change; a valid PDF/PNG/JPEG/TIFF is unaffected.
SEED: no identity changes. Duplicate bank/platform organizations that had
  accumulated in the hosted DB from the old seed bug are being merged into
  their canonical (oldest) row via `db/tools/dedupe-organizations.mjs` — refs
  repointed, dupes deleted, canonical ids unchanged. Your fixtures already use
  the canonical ids, so nothing to change your side.
CHANGED (DB): migration `0009_idempotency_keys.sql` — one new table, RLS on,
  no existing shape touched. `db:verify` = 20/20.
BLOCKED ON: nothing. The dedupe `--apply` awaits an operator go-ahead (it
  mutates hosted data and the sandbox blocks it); the dry-run plan is clean
  (4 groups: JNB, LCB, CIB, platform — referenced only by eligibility and
  memberships, no money rows).
NOTE FOR B: the two P0s from the architecture review are NOT fixed here and
  are not mine to fix alone — (1) the whole frontend is on mocks (zero of ~90
  endpoints promoted to live), which is your ENDPOINT_STATUS board; (2) the
  demo dead-ends at CONTRACTED because Phases 7-9 (funding/OTP/settlement) are
  unbuilt. Both need a direction call, not a code patch.

---

## 2026-07-23 — Phase 7 complete (funding, settlement, ledger)

LIVE (API, verified against the hosted DB by `phase7-funding.integration.spec.ts`, 25/25):
  - `POST /transactions/{id}/funding/mark-sent` — 200. Idempotent by
    observation: a repeat returns the same settlement and writes no second
    journal. 409 only when the transaction was never contracted.
  - `POST /transactions/{id}/funding/otp` — 201. Plaintext code returned
    ONCE. 429 past `otp_max_resends`.
  - `POST /transactions/{id}/funding/confirm` — 200 `{transactionState,
    fundedAt}`. **401 carries `attemptsRemaining` at the TOP LEVEL**, beside
    `code`, because the contract declares this response with an inline schema
    rather than the Error envelope. It is also present under `details` so the
    envelope stays uniform — read either.
  - `GET /transactions/{id}/settlement` — 200 Settlement, 404 before mark-sent.
  - `POST /settlements/{id}/retry` — 200. Retrying a completed settlement is a
    no-op that returns it unchanged, not an error.

CHANGED (behaviour you may already have assumed otherwise):
  - **`mark-sent` never reaches FUNDED.** It moves the transaction to
    `FUNDING_CONFIRMATION_PENDING` and stops. Only the supplier's confirm can
    reach `FUNDED`, and only with settlement evidence present (INV-10).
  - **The Error envelope may now carry one promoted top-level field.**
    `attemptsRemaining` is the only one, and only on the funding 401.
    `ApiError` keeps the whole body on `.body` so nothing outside the envelope
    is dropped by the client.
  - **Commission is now recorded at acceptance.** `POST /offers/{id}/accept`
    additionally writes a `commission_calculations` row (`CALCULATED`) inside
    the same transaction. No response shape changed. Full Phase 6 suite
    re-run: 36/36, no assertion loosened.

CHANGED (DB): none. No migration this phase — every table Phase 7 needs was
  already in the frozen schema.

FIXED (would have bitten at integration):
  - The role `PLATFORM_OPERATIONS_ADMIN` does not exist. The frozen enum says
    **`PLATFORM_OPS_ADMIN`**. If you have that string anywhere in the frontend,
    it matches nobody.
  - `ListingDeadlinesService` had no caller since Phase 5 — listing deadlines
    had never actually passed outside a test. `SchedulerService` now runs it
    and the funding sweep on a 60s interval.

FRONTEND (built this phase, still on mocks):
  - `/bank/funding` — mark-sent, OTP issuance, settlement panel with retry.
  - `/supplier/funding` — OTP entry, settlement breakdown. Behind
    `FinancingGate` as before (ZM-SON-011).
  - The mock store reproduces the API's invariants rather than returning
    plausible JSON, so promotion should be uneventful.

BLOCKED ON: nothing.

OUTSTANDING (not blocked, just not claimed):
  - **Live promotion of any endpoint.** Still 0 of ~90. The funding endpoints
    are proved live by the integration suite, but no screen has been driven
    against the real API by hand, and the promotion rule requires a same-day
    smoke test on the consuming screen. This is the Phase 9 rehearsal gate.
  - `db/tools/dedupe-organizations.mjs --apply` still awaits an operator
    go-ahead (dry-run plan unchanged and clean).

OPEN QUESTION RAISED: **Q-16** — `ZM-FND-012` requires escalation to create an
  "administrative task with full context", and neither the frozen schema nor
  the contract (nor the overlay's `/cases`, scoped to FRAUD/DISPUTE/
  WITHDRAWAL/RECOURSE) declares anywhere to put one. Interim: notification to
  every active `PLATFORM_OPS_ADMIN` plus an audit entry carrying the full
  context.

---

## 2026-07-23 — Phase 8 complete (post-funding, cases, notifications)

LIVE (API, 63/63 against the hosted DB in `phase8-postfunding.integration.spec.ts`):
  - `GET/POST /transactions/{id}/payments` — the balance is DERIVED on every
    read from `buyer_payments` (D-13). `invoices.paid_amount` and
    `outstanding_amount` are never written after listing; an integration test
    asserts both still hold their listing-time values after a payment lands.
    **A supplier's payload has no `bankInternalNotes`, `evidenceDocumentId` or
    `reportedBy` at all** — built as a separate object, not filtered.
  - `POST /transactions/{id}/confirm-status` — the ONLY route to `OVERDUE` in
    the system. Refuses `PAID` while the recorded payments do not settle the
    invoice (422 with `details.outstandingAmount`).
  - `POST /transactions/{id}/close` — idempotent; a second close returns the
    original reason rather than rewriting it.
  - `POST /transactions/{id}/recourse`, `GET /recourse/{id}`,
    `POST /recourse/{id}/repay`, `POST /recourse/{id}/status`
  - `POST /transactions/{id}/disputes`, `GET /disputes/{id}`,
    `POST /disputes/{id}/resolve`
  - `POST /offers/{id}/withdrawal-case`, `GET /withdrawal-cases/{id}`,
    `POST /withdrawal-cases/{id}/decide`
  - `POST /transactions/{id}/fraud-review`, `GET /fraud-cases/{id}`,
    `POST /fraud-cases/{id}/decide`
  - `GET /cases`, `GET /notifications`, `POST /notifications/{id}/read`

BEHAVIOUR YOU MAY HAVE ASSUMED OTHERWISE:
  - **A due date passing produces `OVERDUE_UNCONFIRMED`, never `OVERDUE`.**
    Render it as "awaiting bank confirmation" and NEVER as defaulted, late or
    overdue. The `FUNDED → OVERDUE` transition does not exist in the state
    machine at all.
  - **`OVERDUE_UNCONFIRMED` is neutral-toned, not amber.** Brief §5 forbids a
    warning colour on a non-adverse state.
  - **Recourse requires a CONFIRMED overdue.** Initiating from
    `OVERDUE_UNCONFIRMED` is a 409. A platform admin gets **403** on
    initiation even though they outrank the bank (ZM-REC-002).
  - **Fraud cases never appear in a bank's or supplier's `GET /cases`,** and
    `GET /fraud-cases/{id}` 404s for them. Excluded from the query, not
    filtered from the results.
  - **A dispute pauses the maturity job entirely** — no reminders, no state
    changes — and resolving it returns the transaction to where it was.
  - The error envelope may carry `attemptsRemaining` at the top level (from
    Phase 7); no new envelope changes this phase.

CHANGED (DB): none. No migration — every table Phase 8 needed was already in
  the frozen schema, including `relisting_requests` from 0002.

FRONTEND (built, still on mocks): supplier + bank `payments`, platform `cases`,
  and a `notifications` inbox on all three portals (new nav entry
  `nav.notifications`). The EN/AR wording for `OVERDUE_UNCONFIRMED` is
  asserted by a test that reads the actual message bundles.

BLOCKED ON: nothing.

OUTSTANDING (unchanged from Phase 7, still not claimed):
  - **Live promotion of any endpoint** — still 0 of ~90. Needs a session with
    both servers up so screens can be smoke-tested by hand. Phase 9 gate.
  - `db/tools/dedupe-organizations.mjs --apply` awaits an operator go-ahead.

NEEDS PO SIGN-OFF: the `BUYER_PAYMENT_CONFIRMATION` wording (LT-14). It is
  catalogued in `docs/specs/NOTIFICATIONS.md` with its constraint — operational
  only, never a demand for payment — and deliberately not sent until ratified.

---

## 2026-07-23 (later) — Phase 7/8 review pass

Re-read both kickoff prompts against the code rather than against the
completion reports. Four things came out of it.

LIVE (new): `GET /admin/relisting-requests` — platform only. Named explicitly
  in Phase 8 §8.5 and never built. The withdrawal flow was already writing
  `REQUESTED` rows that nothing could read, so the write had no consumer. The
  seven ZM-REC-018 checks report `null` when unrecorded rather than being
  omitted: "checked and failed" and "not yet checked" mean opposite things to a
  reviewer. Contract coverage 74 → 75 of 82, no drift. No screen consumes it
  yet — the review desk and `POST …/approve` are Phase 9.

CHANGED (behaviour a consumer would otherwise assume wrongly):
  - **Maturity reminders no longer backfill.** They returned every reached
    threshold, so a transaction funded five days before maturity produced three
    notifications in one minute claiming it was due in 30, 14 and 7 days. Only
    the nearest threshold fires now, and the subject quotes the *real* days
    remaining, not the threshold that triggered it. Anything counting reminder
    rows per transaction should expect fewer.
  - **`recordManualCall` is audited and takes a row lock.** It overwrote the
    previous operator's notes with no trace; `manual_call_notes` is one column,
    so that was a hard delete of evidence (INV-7). The superseded text now
    lives in the audit entry's `previousValue`.

CHANGED (DB): none.

FRONTEND: the payments mock hardcoded `overdueDays: 0`, which meant
  `PaymentTimeline`'s overdue-days line could never render. With nothing
  promoted to live the mock *is* the demo, so a fixture that switches a feature
  off silently is worse than no fixture.

DOCS: **Q-17** raised — `ZM-NOT-007` requires a manual call record; the frozen
  contract declares no notification paths and the overlay declares only list
  and read, so the requirement has storage and no input. Declared partially met
  in `docs/specs/NOTIFICATIONS.md` rather than worked around. Q-16 still named
  the retired `PLATFORM_OPERATIONS_ADMIN` role — the exact bug Phase 8's own
  lesson 2 was written about — and now names `PLATFORM_OPS_ADMIN`.

BLOCKED ON: nothing.

OUTSTANDING: unchanged. Live promotion is still 0 of ~90 and remains the
  largest demo risk; `POST /admin/relisting-requests/{id}/approve` and
  `POST /transactions/{id}/relist-request` stay unserved, with the other five
  Phase 9 paths.

---

## 2026-07-23 (later still) — first live endpoint promotions, and D-16

**PROMOTED TO LIVE — 7 of ~90, the first ever.** Not by assertion:
`apps/web/test/live/` renders the real component against the real API over a
real Supabase JWT with no MSW installed (`npm run test:live` from `apps/web`,
20 tests). Separate config because it needs the API up, the seed applied and
network access; the default suite stays hermetic.

  - `GET /notifications` · `POST /notifications/{id}/read` — inbox rendered,
    envelope asserted field by field, unread filtering proved server-side, and
    another user's notification refused with 404 rather than 403.
  - `GET /transactions/{id}/payments` — a real `OVERDUE_UNCONFIRMED`
    transaction from the seed rendered through `PaymentTimeline` in EN **and**
    AR, asserting the words that reach the DOM. That duplicates the
    bundle-reading unit test deliberately: a key that exists and is never
    rendered passes that one and fails this one.
  - `GET /cases` — fraud exclusion asserted against real bank and supplier
    tokens, at the server, not the client filter.
  - `GET /admin/relisting-requests` — platform only; refusal asserted for both
    a bank and a supplier.

LIVE (new): **`POST /notifications/{id}/manual-call`** — additive under
  **D-16**, ruled today against Q-17. ZM-NOT-007 had storage
  (`manual_call_notes`, `manual_call_by`) and no route to write it. Platform
  staff including compliance — an officer telephoning a supplier during a fraud
  review is exactly this record. Deliberately not folded into `/read`: a
  recipient opening their inbox and an operator attesting to a phone call are
  different claims by different people. Blank notes are refused. Overlay and
  generated client updated; conformance 76/83, no drift. No screen consumes it
  yet, so it stays `mock` on the board.

CHANGED (test, worth knowing): the Phase 8 inbox test asserted
  `items[0].read === false`, which silently depended on nobody ever having
  opened a supplier notification. The live suite now marks one read against the
  same hosted database, exactly as a person would. A test that fails because
  the product was used is testing the wrong thing; it now asserts the shape and
  that the fixture's own messages are present.

OUTSTANDING: 83 of ~90 endpoints still `mock` — not assumed broken, just not
  yet exercised through a screen. The demo path (onboarding → invoice → risk →
  listing → offers → acceptance → contract → funding) is the priority order for
  the next promotion pass.

**Also promoted (second pass):** `GET /auth/me` and `GET /transactions`.

These two needed the real `SessionProvider`, not a hand-configured api client,
because the transaction list is scoped server-side by an `X-Organization-Id`
the *client* derives. Only the Supabase browser SDK is substituted in that
spec, and it is handed a real access token from a real password grant —
everything downstream is real. The Phase 1 circularity is asserted in both
directions: `/auth/me` echoes `activeOrganizationId` when the header names a
real membership and omits it when no header is sent, so a client that tried to
read the value it was supposed to send would get nothing and every scoped
endpoint would 403.

Writing that test produced a false alarm worth recording. The list rendered
empty with no error, which looks exactly like a scoping failure. It was the
assertion: the hook is *disabled* until the provider has derived an active
organization, and a disabled resource is also not loading — so waiting on the
loading flag resolves during the gap before the org exists. Waiting for rows
rather than for loading to clear fixed it. Second time today a live-suite
assertion looked like a product defect and was not; both were the test reading
a real system through an assumption that only held against a mock.
