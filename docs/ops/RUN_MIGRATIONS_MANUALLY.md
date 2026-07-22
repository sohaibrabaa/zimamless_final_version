# Running the migrations by hand (Supabase SQL editor)

For applying the schema without giving out the database password. The
automated path is `npm run db:migrate` with `DATABASE_URL` set — see
`DEPLOY_RUNBOOK.md`. Both produce identical state, including the
`schema_migrations` bookkeeping, so you can switch between them freely.

**Order matters.** `0000 → 0001 → 0002 → 0003`. Each file is wrapped in a
transaction and refuses to apply twice, so a failure leaves nothing behind
and a double-paste is harmless.

---

## Step 0 — Inspect first (the project already has tables)

Run this before anything else and send me the output. It tells us whether
we're looking at an empty project, a partial run of *this* schema, or an
unrelated schema that would collide.

```sql
-- What is already in public?
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
ORDER BY table_name;

-- Have these migrations been run before?
SELECT to_regclass('public.schema_migrations') IS NOT NULL AS has_migration_table;

-- Which of OUR types already exist? (non-zero = a partial 0001 run)
SELECT count(*) AS our_types_present
FROM pg_type t
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'public'
  AND t.typname IN ('user_status','organization_type','transaction_state',
                    'offer_status','settlement_status','risk_band');

-- Is citext enabled? (0 = migration 0000 is required, as expected)
SELECT count(*) AS citext_enabled FROM pg_extension WHERE extname = 'citext';
```

**Do not proceed past this step until we've read the result together.**

- *Empty public schema* → go to Step 1.
- *Our tables/types partially present* → a previous run died midway. We
  decide together whether to drop and restart; I will not tell you to drop
  anything before seeing what is in there.
- *Unrelated tables present* → they will not collide by name, but say so
  and I will check before we add 59 tables alongside them.

---

## Steps 1–4 — Apply the migrations

Paste each file **in full** into the Supabase SQL editor (Dashboard → SQL
Editor → New query) and Run. Wait for success before starting the next.

| Step | Paste this file | What it does | Expect |
|---|---|---|---|
| 1 | `db/migrations/_manual/0000_prerequisites.sql` | Enables `citext` | `Success. No rows returned` |
| 2 | `db/migrations/_manual/0001_frozen_schema.sql` | The frozen schema: 44 types, 59 tables, 17 settings rows | Slowest step, a few seconds |
| 3 | `db/migrations/_manual/0002_additive_amendment.sql` | D-01 fingerprint fix, D-02 floor revoke, `relisting_requests`, `webhook_events`, 3 settings keys | |
| 4 | `db/migrations/_manual/0003_rls_policies.sql` | RLS on all 61 tables, ~50 policies, privilege baseline, column revokes | |

Use the files under `_manual/` — not the ones directly in `migrations/`.
The `_manual/` copies add the transaction wrapper and the
`schema_migrations` record. (They're generated: `node db/tools/manual-bundle.mjs`.)

### If a step fails

The transaction rolls back on its own — nothing is half-applied and the
migration is not recorded. Send me the full error text including the
`ERROR:`, `DETAIL:`, and `HINT:` lines. Do not edit the SQL to get past an
error: if a migration is wrong, that is mine to fix at source, and a local
edit would silently desynchronise your database from the repo.

---

## Step 5 — Verify

```sql
-- 1. All four migrations recorded, in order.
SELECT name, applied_at FROM schema_migrations ORDER BY name;
--    expect exactly 4 rows: 0000, 0001, 0002, 0003

-- 2. Table and policy counts.
SELECT
  (SELECT count(*) FROM pg_tables WHERE schemaname = 'public')            AS tables,
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public')          AS policies,
  (SELECT count(*) FROM pg_tables
    WHERE schemaname = 'public' AND rowsecurity)                          AS rls_enabled;
--    expect tables 62 (61 + schema_migrations), policies ~50, rls_enabled 61

-- 3. No table left unprotected. MUST return zero rows.
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
  AND tablename <> 'schema_migrations'
  AND (NOT rowsecurity
       OR tablename NOT IN (SELECT tablename FROM pg_policies WHERE schemaname='public'))
ORDER BY tablename;

-- 4. D-02: the supplier floor is not selectable by authenticated.
--    MUST return zero rows.
SELECT column_name FROM information_schema.column_privileges
WHERE table_name = 'receivable_transactions'
  AND grantee = 'authenticated'
  AND privilege_type = 'SELECT'
  AND column_name = 'minimum_acceptable_amount';

-- 5. D-01: the replacement fingerprint index exists and is partial.
SELECT indexdef FROM pg_indexes
WHERE indexname = 'uq_active_invoice_fingerprint';
--    expect: ... ON public.invoices USING btree (fingerprint)
--            WHERE is_active_fingerprint

-- 6. anon can read nothing in public. MUST return zero rows.
SELECT table_name FROM information_schema.table_privileges
WHERE grantee = 'anon' AND table_schema = 'public';
```

Send me the output of all six and I'll confirm the database matches what the
API expects before I wire anything to it.

---

## What this does NOT do

- **No auth users.** The `users` table is the platform's own, keyed to
  `auth.users` by `auth_user_id`. Persona logins are created by the seed
  (`npm run db:seed`), which needs the service-role key and therefore the
  automated path. Until then `/auth/me` has nobody to return.
- **No seed data.** Migrations create structure only. `platform_settings`
  is the one exception — the frozen schema seeds its 17 operational keys.
- **No `.env` on your machine is required for this path**, but the API
  itself will need `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and
  `SUPABASE_SERVICE_ROLE_KEY` before it can serve a request.
