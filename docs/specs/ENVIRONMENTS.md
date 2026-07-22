# Environment & Configuration Reference

**Owner:** Agent A · **Status:** living (started Phase 1)

Every variable the backend reads, every `platform_settings` key, and the
rules about secrets. `.env.example` is the copy-paste template; this file
explains what each value is and what goes wrong when it is missing.

---

## 1. The one rule that matters

**`SUPABASE_SERVICE_ROLE_KEY` never leaves the server.**

It bypasses RLS entirely. Anyone holding it can read every supplier's
`minimum_acceptable_amount` and every bank's offers — the two things the
product most promises to keep private. It must never appear in:

- anything under `/apps/web`
- any `NEXT_PUBLIC_*` variable (Next.js inlines those into the client bundle)
- a log line, an error payload, or a support ticket
- a committed file — `.env` is gitignored; `.env.example` carries blanks only

If it is ever exposed, rotate it in the Supabase dashboard immediately;
changing the password does not invalidate it.

## 2. API variables

### Required — the API refuses to boot without these

| Variable | Example | Notes |
|---|---|---|
| `DATABASE_URL` | `postgresql://postgres.<ref>:<pw>@aws-1-<region>.pooler.supabase.com:5432/postgres` | **Session pooler, port 5432.** See §2.1. |
| `SUPABASE_URL` | `https://<ref>.supabase.co` | Project URL |
| `SUPABASE_ANON_KEY` | `eyJhbGciOi…` | Public; Agent B uses the same value |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJhbGciOi…` | **Server-only.** See §1 |

Validation happens once, at boot, and fails loudly. A missing service-role
key must not become a 500 on the first authenticated request.

### 2.1 Choosing the right DATABASE_URL

Supabase offers three connection strings and they are not interchangeable:

| | Host | Port | DDL? | IPv4? |
|---|---|---|---|---|
| Direct | `db.<ref>.supabase.co` | 5432 | yes | **no — IPv6 only** |
| **Session pooler** | `aws-1-<region>.pooler.supabase.com` | 5432 | **yes** | yes |
| Transaction pooler | `aws-1-<region>.pooler.supabase.com` | 6543 | **no** | yes |

Use the **session pooler**. The direct host resolves to IPv6 only, so on a
network without IPv6 every connection fails with `ENOTFOUND` — which reads
like a wrong hostname rather than a routing problem. The transaction pooler
cannot run DDL, so migrations fail against it.

Note the username differs: the pooler uses `postgres.<project-ref>`, not
`postgres`. Percent-encode `@ : / ? # %` in the password (`@` → `%40`).

### Optional

| Variable | Default | Notes |
|---|---|---|
| `SUPABASE_JWT_SECRET` | — | **Legacy HS256 projects only.** Leave blank for projects with asymmetric signing keys; the API then verifies against the project JWKS. Setting it wrongly presents as every request returning 401. |
| `NODE_ENV` | `development` | `development` \| `test` \| `production` |
| `PORT` | `3000` | |
| `API_GLOBAL_PREFIX` | `v1` | The contract's servers block is `http://localhost:3000/v1` |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `CORS_ORIGINS` | `http://localhost:3000` | Comma-separated. Agent B's dev server needs an entry. |
| `ML_SERVICE_URL` | `http://localhost:8000` | Unused until Phase 3 |
| `ML_SERVICE_TIMEOUT_MS` | `5000` | On timeout, risk falls back to rules-only with a visible flag |
| `DEMO_TIME_MACHINE_ENABLED` | `false` | §4 |
| `ZM_SPEC_ONLY` | — | Internal. Set by the OpenAPI emitter so it can build the module graph with no database. Never set it for a running server. |

## 3. platform_settings

Runtime configuration, editable by platform admins without a deploy. Seeded
by migration `0001` (17 keys) and `0002` (3 more).

| Key | Default | Governs |
|---|---|---|
| `offer_submission_window_hours` | `24` | Listing activation → offer deadline |
| `supplier_selection_window_hours` | `12` | Offer close → selection deadline |
| `gov_snapshot_freshness_days` | `90` | Government snapshot validity |
| `sla_business_hours` | Sun–Thu 08:00–17:00 Asia/Amman | Onboarding SLA clock |
| `sla_target_business_hours` | `24` | Onboarding decision SLA |
| `otp_validity_minutes` | `15` | Funding OTP |
| `otp_max_attempts` | `5` | Funding OTP |
| `otp_max_resends` | `3` | Funding OTP |
| `funding_confirmation_escalation_hours` | `24` | Stalled-confirmation escalation (AS-04) |
| `settlement_max_retries` | `3` | Automatic payout retries |
| `listing_fee_amount` | `25.000` | Flat listing fee, JOD (AS-06) |
| `default_fee_payer` | `SUPPLIER` | ZM-FEE-009 |
| `min_tenor_days` | `7` | Minimum days to maturity to list (AS-08) |
| `reminder_thresholds_pct` | `[50,15]` | Selection reminders (AS-02) |
| `maturity_reminder_days` | `[30,14,7]` | Pre-maturity notifications |
| `default_language` | `EN` | ZM-I18N-003 — never inferred from locale |
| `demo_time_machine_enabled` | `false` | **Must be false in production** |
| `withdrawal_penalty_policy` | per-reason object | LT-12 — recorded, never auto-deducted |
| `commission_refund_on_recourse` | `NONE` | LT-11 |
| `relisting_fee_policy` | `CHARGE_PER_ROUND` | ZM-MKT-017 |

## 4. The demo time machine is guarded twice

Both must be true for `/demo/time-travel` to exist; otherwise it 404s:

1. `DEMO_TIME_MACHINE_ENABLED=true` (environment)
2. `demo_time_machine_enabled = true` (platform setting)

Server-side by design — ZM-DEMO-004 is explicit that hiding the UI is not
sufficient. **The API refuses to start if the env flag is true while
`NODE_ENV=production`**, so a production deployment cannot be
time-travelled even by mistake.

Agent B learns whether to show the control from the optional `demo` block on
`GET /auth/me` (D-10), which is absent entirely in production.

## 5. Local setup

```bash
cp .env.example .env       # then fill in the four required values
npm ci
npm run db:migrate         # applies 0000-0003
npm run db:verify          # asserts the schema is what the API expects
psql "$DATABASE_URL" -f db/seed/0100_seed_dev.sql
npm run start:dev -w @zimmamless/api
```

Verify: `curl localhost:3000/health` → `{"status":"ok",…}`, and
`localhost:3000/docs` for the served OpenAPI.

Seeded personas all use password `Zimmamless#2026` — see
`docs/specs/GOV_DUMMY_DATA.md` §6.

## 6. CI

CI needs no Supabase project. It runs plain Postgres 15 and applies
`db/ci/000_supabase_compat.sql` first, which supplies the roles, the `auth`
schema, and `auth.uid()`. Only `DATABASE_URL` and `NODE_ENV=test` are set;
the OpenAPI emitter substitutes placeholders for the Supabase variables
because emitting a route list needs no credentials.

## 7. Deployment (PA-07)

| Service | Host | Notes |
|---|---|---|
| Web | Vercel | Agent B |
| API | Render | This service |
| ML | Render | Phase 3 onward |
| DB/Auth/Storage | Supabase | |

Production differences: `NODE_ENV=production`,
`DEMO_TIME_MACHINE_ENABLED=false`, `LOG_LEVEL=info`, `CORS_ORIGINS` set to
the real web origin only. Full steps in `docs/ops/DEPLOY_RUNBOOK.md`.
