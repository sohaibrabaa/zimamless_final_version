# Phase 1 Fix Prompt

> Paste this prompt into a single Claude Code session at the repo root on `main`
> (after the Phase 1 merge commit). It fixes every defect found by the Phase 1
> audit of both agents' work. All items were verified against the code — none
> are speculative. Work through them in order; the acceptance gate is at the end.

---

## PROMPT (copy from here)

You are working on the Zimmamless V3 monorepo, on `main`, which now contains
both Agent A's backend (`apps/api`, `db`) and Agent B's frontend (`apps/web`).
An independent audit of Phase 1 found the defects below. Fix them all, keep
every existing test green, and do not touch frozen files
(`docs/02_DATABASE_SCHEMA.sql`, `docs/03_API_CONTRACT.yaml`). Ownership
boundaries no longer apply — this is a unification session.

### Part 1 — Workspace unification (do first)

1. Add `"apps/web"` to root `package.json` `workspaces`; delete
   `apps/web/package-lock.json` (root lockfile becomes authoritative); run
   `npm install` from the root and verify `npx next build` still succeeds in
   `apps/web`.
2. Add a `typecheck` script to `apps/web/package.json` (`tsc --noEmit`) so root
   `npm run typecheck --workspaces --if-present` covers the web app.
3. Make `apps/web/tsconfig.json` extend the root `tsconfig.base.json`.
4. Re-examine `apps/web/next.config.ts`'s `turbopack.root` pin: it existed
   because the worktree found the wrong lockfile. After folding, the repo-root
   lockfile is the correct root — remove the pin or replace it with
   `outputFileTracingRoot` pointing at the repo root.
5. `apps/web/.gitignore` ignores `.env*` — confirm `.env.local.example` stays
   tracked (it was force-added) and trim overlaps with the root `.gitignore`.

### Part 2 — Backend fixes (`apps/api`, `db`)

6. **Duplicate `SystemTimeProvider` instances (real bug).** `app.module.ts`
   registers both `{ provide: TIME_PROVIDER, useClass: SystemTimeProvider }`
   and `SystemTimeProvider` — two instances with separate caches, and
   `main.ts` primes the one nobody injects. Change to
   `{ provide: TIME_PROVIDER, useExisting: SystemTimeProvider }`.
7. **`actor_org_id` can be NULL on a mutation.** `PATCH /auth/language` is
   org-context-exempt, so a call without `X-Organization-Id` writes an audit
   row with `actor_org_id = NULL`, violating hard rule 6. Decide and enforce:
   for exempt mutations where the user has exactly one membership, resolve it
   as the actor org; otherwise require the header on mutating exempt routes.
   Add a unit test that fails if a mutation audit row would have a NULL actor
   org.
8. **`AllExceptionsFilter.codeForStatus` maps generic 403 →
   `ORGANIZATION_CONTEXT_REQUIRED`**, which is actively misleading for any
   future plain `ForbiddenException`. Map unmatched 403s to a neutral
   `FORBIDDEN` code (add it to the error-code list) and keep AppException codes
   as-is.
9. **`Money.multiply()` accepts a raw JS `number` factor**, undercutting the
   float ban. Restrict the factor to `Decimal | string | Money` (integers may
   stay allowed only if explicitly whitelisted, e.g. `Number.isSafeInteger`);
   update `money.spec.ts` accordingly.
10. **`db/tools/verify.mjs` uses `ssl: { rejectUnauthorized: false }`.**
    Verify with proper TLS (Supabase pooler presents a valid cert) or gate the
    insecure mode behind an explicit `--insecure-tls` flag.
11. **RLS integration suite silently self-skips when `DATABASE_URL` is unset.**
    In CI this would turn the security suite green by skipping. Make it throw
    when `process.env.CI` is set and `DATABASE_URL` is missing.
12. **`verify.mjs` "all four migrations recorded" check is stale** — it checks
    0000–0003 by name and never 0004. Include 0004 (and make the check derive
    the expected list from `db/migrations/` so it can't go stale again).
13. **Docs correction:** `PHASE_1_AGENT_A.md` and the daily log claim missing
    header, malformed uuid, and non-member org return "the same 403 with no
    difference to branch on". In reality a missing header returns
    `ORGANIZATION_CONTEXT_REQUIRED` and the other two
    `ORGANIZATION_CONTEXT_INVALID`. Either unify the codes in the guard
    (preferred: match the documented design) or correct both documents — pick
    one and make code and docs agree. Also fix "62 RLS-enabled" → 61
    (`schema_migrations` is exempt).

### Part 3 — Frontend fixes (`apps/web`)

14. **Replace every placeholder identity in `lib/mocks/data.ts` with the real
    seed identities from `docs/specs/GOV_DUMMY_DATA.md` and
    `db/seed/0100_seed_dev.sql`** — same names, org names, establishment
    numbers, and the same fixed UUIDs A seeded (e.g. Rania Haddad / Al-Noor
    Trading Company, Layla Mansour / Jordan National Bank, Zaid Qasem /
    platform). Use A's exact role strings (`SUPPLIER_OWNER`,
    `BANK_OFFER_APPROVER`, `PLATFORM_SUPER_ADMIN`, …) — the contract types
    roles as `string[]`, so divergence is silent until it breaks live.
15. **Add the multi-membership persona** (`multi@platform.zimmamless.test`,
    Sara Yaseen, two memberships) to the fixtures. Without it,
    `OrgSwitcher` never renders and the org-switch flow — a Phase 1
    checkpoint item — is unreachable in mock mode. Also add bank K2 and the
    blocked buyers B4–B6 so block-state screens can be built.
16. **Fix org-context persistence in `lib/session/SessionProvider.tsx`
    (breaks against the live API).** The client derives `X-Organization-Id`
    from `me.activeOrganizationId`, but the live `GET /auth/me` only echoes a
    *supplied* header — so after login no org is ever selected (every
    non-exempt call 403s), and `switchOrganization()` never records the new
    org, so the follow-up `fetchMe()` sends the old header. Store the active
    org id client-side (state + localStorage), default it to the first
    membership after login, send it on every request, and update it from the
    `POST /auth/context` response.
17. **Handle the live 403 in `OrgSwitcher`** — wrap `switchOrganization` in
    try/catch and surface a toast; the live API returns one identical 403
    (`ORGANIZATION_CONTEXT_INVALID`) for unknown-org and non-member.
18. **Make MSW respect the mock/live map or fix the claim.** `handlers.ts`
    registers all handlers unconditionally; `isLive()` in
    `lib/api/endpoint-status.ts` is dead code and flipping an entry to "live"
    changes only the badge. Implement passthrough for live entries (MSW
    `passthrough()` keyed off `endpointStatus`) so flipping an endpoint
    actually goes live.
19. **Align the mock `POST /auth/context` with the live API**: return
    `{organizationId}` in the body and return the same 403 envelope
    (`ORGANIZATION_CONTEXT_INVALID` + `correlationId`) for a non-member org
    instead of presence-only validation.
20. **Fix the `/health` URL mismatch**: live health is served at the server
    root (`/health`), outside `/v1` and outside the contract. Point the mock
    handler and any health check at the root URL, and drop `/health` from
    `endpoint-status.ts` (it is intentionally not a contract endpoint).
21. **Ports**: Next dev and the API both default to 3000. Standardize the API
    on 3001 (or Next on 3001) across `.env.example`, `.env.local.example`,
    `NEXT_PUBLIC_API_BASE_URL`, and `DEPLOY_RUNBOOK.md`.
22. **`lib/supabase/client.ts` silently falls back to
    `http://localhost:54321` / a placeholder anon key** — throw a clear error
    in production builds instead; keep the fallback for mock-mode dev only.
23. **`formatMoneyDisplay` in `lib/money.ts`**: the locale branch is dead
    (`numeralLocale === "ar-JO" ? "en-US" : "en-US"`). Per ZM-I18N (Western
    numerals everywhere), simplify to always `en-US` and delete the vestigial
    branch, with a comment citing the ruling.
24. **ESLint money ban bypasses**: also restrict `Number.parseFloat`,
    `Number.parseInt`, and `globalThis.parseFloat` via `no-restricted-syntax`
    member-expression selectors.
25. **Role-gated shells are not gated**: add a minimal guard in the three
    portal layouts — if the session's active membership's `organizationType`
    doesn't match the portal, redirect to that user's correct portal
    dashboard. Use A's real role strings from item 14.

### Part 4 — Process/coordination

26. Update `docs/coordination/ENDPOINT_STATUS.md` only if the mock/live map
    changed shape (statuses stay `mock` until A announces a deployed URL).
27. Append a dated entry to `docs/coordination/DAILY_LOG.md` summarizing this
    unification session (append-only; do not edit prior entries).
28. Extend `scripts/contract-conformance.mjs` to compare **status codes** per
    path+verb (the gate missed the 201→200 defect). Failing on mismatch for
    implemented routes only.

### Acceptance gate (all must pass before you finish)

- `npm run lint && npm run typecheck && npm test` from the root (now covering
  all three workspaces).
- `node db/tools/build-0001.mjs --check`.
- `npm run openapi:emit -w apps/api && node scripts/contract-conformance.mjs
  apps/api/openapi.generated.json` — green, now including status codes.
- With `.env` configured: `npm run db:verify` (15+ checks) and
  `npm run test:rls -w apps/api` (23 tests) still green.
- `npx next build` in `apps/web` — all routes, both locales.
- New unit tests for items 7, 9, 16 (org persistence can be tested at the
  SessionProvider level with MSW).
- Commit in logical chunks on `main` and push.

## END PROMPT
