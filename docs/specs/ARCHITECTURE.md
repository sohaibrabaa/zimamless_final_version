# Architecture Note — Backend

**Owner:** Agent A · **Status:** living (started Phase 1)
**Scope:** `/apps/api`, `/services/ml`, `/db`

---

## 1. Topology

```
                       Supabase Auth (JWT issuer)
                              │  verifies
   Browser ──── JWT ─────────►│
      │                       ▼
      │              ┌──────────────────┐
      └── REST /v1 ─►│  NestJS API      │──── service role ────► Supabase Postgres
                     │  (Render)        │                         (RLS enabled)
                     └────────┬─────────┘
                              │ HTTP
                              ▼
                     ┌──────────────────┐
                     │  Python FastAPI  │   OCR, QR, risk inference
                     │  (Render)        │   — Phase 3 onward
                     └──────────────────┘
```

The browser never talks to Postgres directly in normal operation. It *can* —
Supabase exposes PostgREST with the anon key — which is exactly why RLS is a
real layer here and not decoration (§4).

## 2. Authorization is two independent layers

This is the single most important structural decision in the backend, and
ZM-ARC-003..005 is explicit about it.

| Layer | Enforces | Bypassed by |
|---|---|---|
| **NestJS guard** (primary) | JWT validity, org context, roles per membership | nothing in-process |
| **Postgres RLS** (backup) | tenant isolation, column privileges | the service role only |

The API connects as the service role, which bypasses RLS by design — it has
already done its own authorization and needs to serve legitimate cross-org
reads (a bank viewing a supplier's invoice during underwriting).

**A policy that only works because NestJS filtered first is a defect.** The
persona suite (`apps/api/test/rls-personas.integration.spec.ts`) connects to
Postgres with NestJS entirely out of the picture and asserts the policies
hold on their own.

### Request pipeline

```
CorrelationIdMiddleware   assign/propagate X-Correlation-Id into AsyncLocalStorage
        ↓
AuthGuard (global)        1. verify Supabase JWT → sync users row (PA-04)
                          2. resolve X-Organization-Id → ACTIVE membership (403)
                          3. @RequireRoles against roles held IN THAT ORG
        ↓
ValidationPipe            whitelist + forbidNonWhitelisted
        ↓
Controller → Service      domain logic; clock via TimeProvider; money via Money
        ↓
AuditInterceptor          every non-GET → audit_logs (actor user, actor org, correlation id)
        ↓
AllExceptionsFilter       contract Error envelope; stack traces never leave the process
```

Roles are resolved **per membership**, never globally. A user who is
`PLATFORM_SUPPORT` in the platform org and `SUPPLIER_VIEWER` in a supplier
org holds neither role while acting in the other context.

### 403 semantics (cross-cutting rule 1)

Missing header, malformed id, and non-member all return **403** with the
same shape. They are deliberately indistinguishable: a 404-vs-403 split
would let a caller enumerate which organization ids exist.

## 3. Money

`numeric(18,3)` in the database, `Money` (decimal.js) in code, a 3-dp string
on the wire. Never a float, never a JSON number.

- **Rounding is defined once**: HALF_UP at 3 dp, in `common/money/money.ts`.
  Commission calculation, offer validation, and the settlement split all
  round through it, so the DB CHECKs (`chk_net_formula`,
  `chk_settlement_split`), the service computation, and the API string
  cannot disagree. Banker's rounding would make the settlement CHECK fail
  intermittently on half-cases.
- `Money.from()` **rejects a JavaScript number outright** rather than
  converting it. A lint rule can be silenced with a disable comment; a
  thrown error cannot.
- `node-postgres` returns `numeric` as a string precisely to avoid this
  precision loss — `Money.fromDb()` is the only sanctioned reader.

## 4. RLS coverage

The frozen schema enables RLS on **8 tables of 59** and writes **2
policies**, with no GRANTs at all. On Supabase, where `anon` and
`authenticated` receive broad default privileges, that leaves 51 tables
readable *and writable* by anyone holding the anon key. Migration `0003`
closes this (raised as Q-02).

**Posture:** deny by default, then grant back narrowly.

1. `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated`
2. `anon` receives nothing at all.
3. `authenticated` receives `SELECT` only — never INSERT/UPDATE/DELETE.
   **Every mutation goes through the API.**
4. Column-level revokes where a row is legitimately visible but a column is
   not (§4.1).
5. RLS enabled on all 61 tables; **58 policies** across all of them.

### 4.1 Column-level revokes

Row-level security is row-level: if a bank may see a transaction row, it
sees *every column* of it, including the supplier's floor. Three columns
need to be narrower than their rows:

| Column | Rule | Ruling |
|---|---|---|
| `receivable_transactions.minimum_acceptable_amount` | revoked from `authenticated` entirely | D-02, INV-8 |
| `funding_otps.otp_hash` | revoked — nobody reads it by direct SQL | 0003, follows D-02's pattern |
| `buyer_payments.bank_internal_notes` | revoked — supplier must never see it | ZM-PMT-018 |

The floor is revoked from the *owning supplier* too, not just from banks.
Suppliers read their own floor through the API (service role). A row-level
"own transaction" exception would reopen the hole for any bank that can
reach the row through `tx_read`.

### 4.2 Coverage checklist

All 61 tables have RLS enabled and at least one policy. `npm run db:verify`
asserts this and **fails if any table lacks a policy** — so a table added in
a later phase without one breaks the build rather than shipping open.

| Group | Tables | Read rule |
|---|---|---|
| Identity | `users`, `organizations`, `organization_memberships`, `membership_roles` | own row / own orgs; platform sees all |
| Onboarding | `supplier_applications`, `sla_clock_events`, `supplier_bank_accounts`, `consent_records`, `information_requests` | owning org; platform |
| Government | `government_verification_requests`, `government_data_snapshots`, `entity_field_values` | subject's org; platform |
| Buyers | `buyers`, `supplier_buyer_relationships`, `buyer_resolution_attempts` | own relationship; platform |
| Documents | `documents`, `document_extractions` | owner org; platform |
| Transactions | `receivable_transactions`*, `invoices`, `invoice_items`, `invoice_declarations`, `verification_runs`, `verification_checks` | supplier; eligible bank; platform |
| Risk | `risk_model_versions`, `risk_assessments` | model versions readable; assessments party-scoped |
| Marketplace | `listings`, `bank_eligibility`, `bank_policy_filters`, `bank_offers`*, `offer_conditions`, `offer_selections`, `accepted_offer_snapshots` | **own bank only** (INV-11) |
| Contracts | `contract_templates`, `contracts`, `contract_signatures`, `assignment_records` | contract parties; platform |
| Funding | `funding_otps`, `funding_otp_events`, `settlements`, `settlement_attempts`, `commission_tiers`, `commission_calculations`, `listing_fee_obligations`, `ledger_entries` | transaction parties; platform |
| Post-funding | `buyer_payments`, `recourse_cases`, `recourse_repayments`, `disputes`, `withdrawal_cases`, `fraud_cases`, `fraud_indicators`, `case_evidence`, `relisting_requests` | parties; fraud is platform-only |
| Notifications | `notification_templates`, `notifications` | own recipient row |
| Audit/config | `audit_logs`, `status_history`, `platform_settings`, `demo_time_offsets`, `webhook_events` | own org's audit; platform |

\* policy inherited from the frozen schema, unchanged.

## 5. TimeProvider

Every clock read in `src/modules/**` and `src/jobs/**` goes through the
injected `TimeProvider`. An ESLint rule bans `new Date()` and `Date.now()`
in those trees, and the ban is active from Phase 1 because retrofitting it
is rated high-cost (risk R-05).

The demo time machine adds an offset in exactly one place. It is guarded
**twice, server-side** — the `DEMO_TIME_MACHINE_ENABLED` env var *and* the
`demo_time_machine_enabled` platform setting must both be true. Hiding the
UI is explicitly not sufficient. The API refuses to boot if the env flag is
true while `NODE_ENV=production`.

## 6. Correlation IDs and logging

`X-Correlation-Id` is accepted from the client or generated, stored in
`AsyncLocalStorage`, echoed in the response header, included in every log
line, written to `audit_logs.correlation_id`, and returned in the error
envelope — so a user-reported error id reaches the exact log lines and audit
rows.

Logs are structured JSON with a redaction pass over
`minimum_acceptable_amount`, `otp`, `otp_hash`, IBANs, tokens, and the
service-role key. INV-8 is an *absence* property, and logs are one of the
places absence is easiest to lose.

## 7. Migrations

| File | Contents |
|---|---|
| `0000_prerequisites.sql` | `CREATE EXTENSION citext` — the frozen schema uses the type but never enables it (D-15) |
| `0001_frozen_schema.sql` | **Generated** from `docs/02_DATABASE_SCHEMA.sql`, minus the one D-01 statement |
| `0002_additive_amendment.sql` | The approved amendment, verbatim |
| `0003_rls_policies.sql` | RLS completion, grants, column revokes (Q-02) |

`0001` is generated by `db/tools/build-0001.mjs`, which removes exactly the
D-01 statement and refuses to run if it cannot find it. CI re-runs it with
`--check`, so "0001 is the frozen schema" is mechanically verified rather
than asserted. `db/ci/000_supabase_compat.sql` is **not** a migration — it
supplies the roles, `auth` schema, and `auth.uid()` that Supabase provides,
so CI can run the RLS suite against plain Postgres.

## 8. Adapters

Government (CCD/ISTD/GAM/e-invoice), settlement, signature, notification,
and screening each sit behind an interface with a `dummy` and a
`production` implementation, selected by configuration. Domain logic never
imports a concrete adapter. All integrations are dummy in V3 — but **every
internal workflow genuinely works**; the demo is not a mockup.

## 9. Environments

See `ENVIRONMENTS.md` for the full variable list. The rule that matters:
**the service-role key never leaves the server.** It bypasses RLS entirely,
so anyone holding it can read every supplier's floor and every bank's
offers. It must never appear in `/apps/web`, in any `NEXT_PUBLIC_*`
variable, in a client bundle, or in a log line.
