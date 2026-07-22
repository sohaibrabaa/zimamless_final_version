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
