# Deployment Runbook — API

**Owner:** Agent A · **Status:** draft (Phase 1; executed in Phase 9)

> **This runbook has not been executed.** It is written from the actual
> repo layout and verified commands, but no deployment has happened. Treat
> every step as unproven until the first run, and correct this file as you
> go — a runbook that was never run is a plan, not a procedure.

---

## 0. Prerequisites

| Need | Where |
|---|---|
| Supabase project | Hosted; ref `mryiqprvofulsencpsrx` |
| `DATABASE_URL` (session pooler) | Dashboard → Connect → **Session pooler** |
| Supabase keys | Settings → API |
| Render account | api + ml services (PA-07) |

### 0.1 Getting DATABASE_URL right

This is the step that has already cost time. Supabase offers three strings:

| | Host | Port | DDL | IPv4 |
|---|---|---|---|---|
| Direct | `db.<ref>.supabase.co` | 5432 | yes | **no — IPv6 only** |
| **Session pooler** ✅ | `aws-1-<region>.pooler.supabase.com` | 5432 | **yes** | yes |
| Transaction pooler | same | 6543 | **no** | yes |

Use the session pooler. The direct host fails with `ENOTFOUND` on any
network without IPv6 — which looks like a typo, not a routing problem. The
transaction pooler cannot run DDL, so migrations fail against it.

The pooler username is `postgres.<project-ref>`, not `postgres`.
Percent-encode `@ : / ? # %` in the password (`@` → `%40`).

Verify before anything else:

```bash
npm run db:verify        # connects, or tells you exactly what is wrong
```

## 1. Database

```bash
npm run db:migrate       # applies 0000-0003, records each in schema_migrations
npm run db:verify        # 13 assertions about the RESULT, not the exit code
```

`db:verify` is not optional. It asserts RLS on every table, the D-02 floor
revoke, `anon` stripped, writes revoked from `authenticated`, the D-01 index
present, all 7 helper functions, and the append-only rules. A migration run
that exits 0 while leaving a table unprotected is exactly the failure this
catches.

If migrations were applied by hand through the SQL editor, run `db:verify`
anyway — **especially** then. The editor stops at the first error in a
multi-statement script, so a partial apply looks like a successful one.

### Seed (non-production only)

```bash
psql "$DATABASE_URL" -f db/seed/0100_seed_dev.sql
```

Idempotent, fixed UUIDs. Creates 15 auth accounts with the published
password `Zimmamless#2026` — **never run against production.**

## 2. API service (Render)

| Setting | Value |
|---|---|
| Root directory | repo root |
| Build | `npm ci && npm run build -w @zimmamless/api` |
| Start | `node apps/api/dist/main.js` |
| Health check path | `/health` |
| Node version | 22 |

### Environment

```
NODE_ENV=production
PORT=<Render provides>
API_GLOBAL_PREFIX=v1
DATABASE_URL=<session pooler>
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_ANON_KEY=<anon>
SUPABASE_SERVICE_ROLE_KEY=<service_role>   # server-only, never in the web app
SUPABASE_JWT_SECRET=<only for legacy HS256 projects>
LOG_LEVEL=info
CORS_ORIGINS=https://<agent-b-vercel-domain>
DEMO_TIME_MACHINE_ENABLED=false
```

The API **refuses to boot** if `DEMO_TIME_MACHINE_ENABLED=true` while
`NODE_ENV=production`. That is intentional; do not work around it.

## 3. Smoke checks

```bash
BASE=https://<service>.onrender.com

curl -sf $BASE/health                       # → {"status":"ok",...}
curl -s  $BASE/v1/auth/me                   # → 401, envelope with correlationId
curl -si $BASE/v1/auth/me | grep -i x-correlation-id   # header present
curl -s  $BASE/docs-json | head -c 200      # OpenAPI served
```

Then a real token (get one by signing in as a seeded persona through Agent
B's login, or via the Supabase auth REST endpoint):

```bash
TOKEN=<jwt>; ORG=0e000000-0000-4000-8000-000000000002
curl -s $BASE/v1/auth/me -H "Authorization: Bearer $TOKEN"                      # → 403, org context required
curl -s $BASE/v1/auth/me -H "Authorization: Bearer $TOKEN" -H "X-Organization-Id: $ORG"   # → memberships
```

Expected: no context → 403; wrong org → the **same** 403; correct org →
user + memberships. Then confirm an `audit_logs` row exists for the context
switch, carrying `actor_user_id`, `actor_org_id`, and `correlation_id`.

## 4. Production configuration check

```sql
SELECT value FROM platform_settings WHERE key = 'demo_time_machine_enabled';
-- must be false
```

`GET /v1/demo/time-travel` must return **404** in production — the guard is
server-side, and hiding the control in the UI is explicitly not sufficient
(ZM-DEMO-004).

## 5. Rollback

Migrations are additive and have no down-scripts by design: financial and
audit rows are append-only, so rolling a schema *backwards* risks data loss.

- **Bad deploy** → redeploy the previous commit on Render. The schema is
  forward-compatible within a phase.
- **Bad migration** → fix forward with a new additive migration. Never
  `DROP` a column carrying data.
- **Emergency** → Supabase point-in-time restore (paid tiers), accepting the
  loss of everything after the restore point.

## 6. Known gaps

- Never executed end to end.
- ML service (`/services/ml`) not scaffolded — Phase 3.
- No local fallback stack (PA-07): Docker is unavailable on the build
  machine. Needed for the Phase 9 demo fallback.
- CI has never run; the workflow is written but unproven.
