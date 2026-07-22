# Phase 1 — Foundation (A) ∥ Shell (B)

**Objective:** auth, organizations, multi-org context, RLS, and audit — built once, by Agent A. This is the only genuinely serial dependency in the project: nothing downstream wires live data until `/auth/me` works end to end. Agent B is fully busy in parallel on everything that needs no backend.

## Agent A tasks

- [ ] Migration `0001` = the frozen schema **with the D-01 fingerprint fix as ruled**; migration `0002` = approved additive amendment (tables + grants incl. D-02 revoke). Both apply cleanly to fresh local **and** hosted Supabase.
- [ ] Supabase Auth JWT validation (NestJS guard); `users` row sync on first authenticated request (PA-04).
- [ ] `X-Organization-Id` context guard: 403 when header missing or names an org the user doesn't belong to; role checks per `role_key`.
- [ ] RLS: helper functions from the schema + policies for **every** tenant table (schema shows the pattern for 8; complete the set; keep a coverage checklist in `docs/specs/ARCHITECTURE.md`).
- [ ] Audit-log interceptor: every mutation → `audit_logs` (actor user, actor org, before/after, IP, correlation id).
- [ ] Error envelope per contract `Error` schema; correlation-ID propagation; structured logging.
- [ ] `TimeProvider` injected via DI; lint rule banning `new Date()`/`Date.now()` in `src/modules/**` and `src/jobs/**`.
- [ ] Money: decimal library + lint rule banning float arithmetic on money in `apps/api`.
- [ ] Endpoints live: `GET /health`, `GET /auth/me` (with D-10 `demo` block when enabled), `POST /auth/context`, `PATCH /auth/language`.
- [ ] Dev seed: one user per persona (supplier owner; bank admin/maker/approver/ops; platform admin/reviewer/compliance) using the Phase 0 identity list.
- [ ] First RLS persona test in CI (direct-SQL as supplier JWT cannot read other orgs' rows).
- [ ] Serve OpenAPI at `/docs-json`; CI contract-conformance diff against frozen contract + overlay.
- [ ] Deploy api to hosting; record steps in `docs/ops/DEPLOY_RUNBOOK.md` (draft).

### Endpoints in scope (A)

`/health` · `/auth/me` · `/auth/context` · `/auth/language`

## Agent B tasks (no backend dependency — starts immediately)

- [ ] Next.js app router with `[locale]` segment (`en`|`ar`); message catalogs; **no locale auto-detection** (ZM-I18N-003); language persisted per user.
- [ ] Full RTL plumbing: logical CSS properties, `dir` handling, mirrored nav/icon strategy; start `docs/specs/RTL_CHECKLIST.md`.
- [ ] Design system primitives: colors, type, spacing, Button, Input, Select, Table, Modal, Toast, Badge, Tabs, Skeleton, form patterns; empty/loading/error state patterns.
- [ ] `MoneyDisplay` / `MoneyInput` on a decimal library; ESLint ban on `parseFloat`/number math on money in `apps/web`.
- [ ] OpenAPI codegen pipeline: typed client + MSW handlers from `03_API_CONTRACT.yaml` + v3.1.0 overlay; per-endpoint mock/live map `apps/web/lib/api/endpoint-status.ts` mirrored to `docs/coordination/ENDPOINT_STATUS.md`; dev badge showing mocked endpoints.
- [ ] Supabase Auth UI: login, registration, email/phone verification.
- [ ] Role-gated navigation shells for supplier / bank / platform portals per brief §3 layout.
- [ ] Mock fixtures using the Phase 0 identity list (same names/numbers as A's seed).

### Screens in scope (B)

Login/register/verify · portal shells (3) · org-context switcher · language switcher · design-system storybook (or equivalent gallery)

## Ownership & collision guard

A touches only `/apps/api`, `/db`, `/services/ml`, root config. B touches only `/apps/web`. Shared writes this phase: none except append-only coordination logs.

## Dependencies

Phase 0 rulings D-01, D-02 (Agent A cannot run migrations without them).

## Integration checkpoint

On the **deployed** stack: a seeded user logs in through the real UI → `/auth/me` returns live memberships → org switcher calls `POST /auth/context` and the UI re-scopes → language toggle persists via `PATCH /auth/language` → audit rows exist for the switch → RLS smoke test green in CI.

## Definition of done

Checkpoint met and recorded; contract-conformance gate green; both lint bans active; `ENDPOINT_STATUS.md` shows the 4 auth endpoints `live`, everything else `mock`.

## Effort

Agent A: 4–6 days · Agent B: 4–6 days (same calendar window).

## Completion reports

- `docs/completion/PHASE_1_AGENT_A.md` and `docs/completion/PHASE_1_AGENT_B.md` (template: `docs/completion/_TEMPLATE_COMPLETION_REPORT.md`)
- Joint checkpoint evidence in `docs/completion/PHASE_1_CHECKPOINT.md` (written by A, countersigned by B in its report).
