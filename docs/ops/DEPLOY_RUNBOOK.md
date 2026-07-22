# Deployment Runbook — API

**Owner:** Agent A · **Status:** §0–§1 and §3–§4 executed; §2 (Render) pending an account

> **Partially executed, 2026-07-23 (Phase 2, session 1).** Everything that
> does not require a hosting account has now been run for real against the
> hosted Supabase project, using the **production build** (`nest build`, then
> `NODE_ENV=production node apps/api/dist/main.js`) rather than the dev
> server. Steps corrected from that run are marked **[corrected]**.
>
> What remains unproven is §2 alone: no Render account exists, so the service
> has never been created. The blueprint at `render.yaml` (repo root) encodes
> §2's settings so the first deploy is one action rather than a form. Treat
> §2 as a plan; §0, §1, §3 and §4 are now procedure.

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
| **Session pooler** ✅ | `aws-<n>-<region>.pooler.supabase.com` | 5432 | **yes** | yes |
| Transaction pooler | same | 6543 | **no** | yes |

**[corrected]** The pooler hostname prefix is not always `aws-1`. This
project's is `aws-0-ap-northeast-1.pooler.supabase.com` — copy the string
from the dashboard rather than reconstructing it from this table.

Use the session pooler. The direct host fails with `ENOTFOUND` on any
network without IPv6 — which looks like a typo, not a routing problem. The
transaction pooler cannot run DDL, so migrations fail against it.

The pooler username is `postgres.<project-ref>`, not `postgres`.
Percent-encode `@ : / ? # %` in the password (`@` → `%40`).

Verify before anything else:

```bash
npm run db:verify        # connects, or tells you exactly what is wrong
```

**[corrected]** `db:verify` warns unless the server certificate is actually
verified. Either set `PGSSLROOTCERT` to the Supabase CA bundle, or pass
`--insecure-tls` to acknowledge and silence it. It no longer disables
certificate verification silently, so a first run prints the warning; that
is expected, not a failure.

## 1. Database

```bash
npm run db:migrate       # applies 0000-0004, records each in schema_migrations
npm run db:verify        # 15 assertions about the RESULT, not the exit code
```

**[corrected]** Migrations are `0000`–`0004` (five), not `0000`–`0003`, and
`db:verify` runs **15** checks, not 13. Both numbers had drifted; the
expected-migration list is now derived from `db/migrations/` rather than
hand-kept, so this line is the only place left that can go stale.

Result of the 2026-07-23 run: 5/5 migrations recorded, 62 tables, 62
RLS-enabled, 61 policies, all 15 checks pass.

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

**Not yet executed — no Render account exists.** The settings below are
encoded as a blueprint in `render.yaml` at the repo root: Dashboard → New →
Blueprint → select this repo, then paste the five `sync: false` secrets.
Prefer that over entering these by hand; the table is kept as documentation
of what the blueprint asserts.

There is no `.env` file on Render, and none is needed: `loadEnv()` falls
through silently when no file is found, and values already in the
environment always win over a file. Verified by booting the production
build with the variables supplied inline.

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

Then a real token. Getting one without a browser (this is the command that
was missing, and it is how every check below was run):

```bash
TOKEN=$(curl -s -X POST "$SUPABASE_URL/auth/v1/token?grant_type=password" \
  -H "apikey: $SUPABASE_ANON_KEY" -H "Content-Type: application/json" \
  -d '{"email":"owner@alnoor.zimmamless.test","password":"Zimmamless#2026"}' \
  | node -pe "JSON.parse(require('fs').readFileSync(0)).access_token")
ORG=0e000000-0000-4000-8000-000000000002
```

**[corrected]** The previous version of this section was wrong on its
central claim. It expected `/auth/me` without a header to return **403 org
context required**; it returns **200**. `/auth/me` is context-**exempt** by
necessity — a client cannot name an organization until `/auth/me` has told
it which ones exist. Anyone following the old text would have read a
correct deployment as broken.

```bash
curl -s $BASE/v1/auth/me -H "Authorization: Bearer $TOKEN"                                # → 200, memberships, NO activeOrganizationId
curl -s $BASE/v1/auth/me -H "Authorization: Bearer $TOKEN" -H "X-Organization-Id: $ORG"   # → 200, activeOrganizationId set
curl -s $BASE/v1/auth/me -H "Authorization: Bearer $TOKEN" -H "X-Organization-Id: <other org>"  # → 200, activeOrganizationId ABSENT (not adopted, not an error)
curl -s -X POST $BASE/v1/auth/context -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" -d "{\"organizationId\":\"$ORG\"}"               # → 200 (not 201)
curl -s -X PATCH $BASE/v1/auth/language -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" -d '{"language":"AR"}'                           # → 200 {"language":"AR"}
```

**[corrected]** The language body field is `language`, not
`preferredLanguage` — the latter is the field name in the `/auth/me`
*response*, and mixing them up yields a 400 that reads like a broken deploy.

Expected 403s, which are **three different codes, not one** (the old text
claimed a single indistinguishable 403 — see the Phase 1 audit correction):

| Case | Code |
|---|---|
| Header missing on a non-exempt route, or on an exempt **mutation** by a multi-org user | `ORGANIZATION_CONTEXT_REQUIRED` |
| Malformed uuid, or an org the user is not a member of | `ORGANIZATION_CONTEXT_INVALID` (deliberately indistinguishable from each other) |
| A 403 that is neither context nor role | `FORBIDDEN` |

An exempt **mutation** sent by a user with exactly one membership adopts
that membership silently and succeeds — so hard rule 6 holds and the audit
row still names an actor org. Confirm that:

```sql
SELECT action_type, actor_user_id, actor_org_id, correlation_id
FROM audit_logs ORDER BY occurred_at DESC LIMIT 5;
-- every row: all four columns non-NULL
```

## 4. Production configuration check

```sql
SELECT value FROM platform_settings WHERE key = 'demo_time_machine_enabled';
-- must be false
```

`GET /v1/demo/time-travel` must return **404** in production — the guard is
server-side, and hiding the control in the UI is explicitly not sufficient
(ZM-DEMO-004).

Executed 2026-07-23 against the production build: the setting reads `false`
and the route returns 404. Both halves of the two-part guard verified.

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

- **§2 never executed** — no Render account. Everything else in this file
  has now been run against the production build and the hosted database
  (2026-07-23); see the status note at the top.
- ML service (`/services/ml`) not scaffolded — Phase 3.
- No local fallback stack (PA-07): Docker is unavailable on the build
  machine. Needed for the Phase 9 demo fallback.
- CI has never run; the workflow is written but unproven.
