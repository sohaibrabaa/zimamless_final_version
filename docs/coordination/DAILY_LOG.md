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
