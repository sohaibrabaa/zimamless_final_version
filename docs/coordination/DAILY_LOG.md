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
