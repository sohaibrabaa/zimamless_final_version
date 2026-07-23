#!/usr/bin/env node
/**
 * Verifies that a database matches what the API expects.
 *
 *   node db/tools/verify.mjs
 *
 * Runs the checks from docs/ops/RUN_MIGRATIONS_MANUALLY.md Step 5 and fails
 * loudly on any that do not hold. Safe to run repeatedly — it only reads.
 *
 * This exists because "the migrations ran" and "the database is correct" are
 * different claims. A manual paste can skip a file, apply them out of order,
 * or stop at the first error in a multi-statement editor; none of that is
 * visible later without asking the database directly. CI runs this after
 * migrating, and it doubles as the post-deploy smoke check in the runbook.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Load .env without a dependency — this tool runs before/outside Nest.
try {
  for (const line of readFileSync(join(repoRoot, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {
  // No .env is fine when DATABASE_URL comes from the environment (CI).
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('FATAL: DATABASE_URL is not set (checked .env and the environment).');
  process.exit(1);
}

const needsTls = /supabase\.(com|co)/.test(connectionString) || process.env.PGSSLMODE === 'require';

/**
 * TLS posture.
 *
 * Supabase's poolers present a chain rooted in their own CA, which is not in
 * Node's trust store, so full verification requires their CA certificate —
 * point PGSSLROOTCERT at it (downloadable from the project's database
 * settings) and the connection is genuinely verified.
 *
 * Without it the connection is still encrypted but the peer is unauthenticated.
 * That is the historical behaviour and it stays the fallback, because a tool
 * that cannot connect verifies nothing — but it now says so on every run
 * rather than passing silently. `--insecure-tls` acknowledges the trade-off
 * and quiets the warning.
 */
const caPath = process.env.PGSSLROOTCERT;
const acknowledged = process.argv.includes('--insecure-tls');
let ssl;
if (needsTls) {
  if (caPath) {
    ssl = { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
  } else {
    ssl = { rejectUnauthorized: false };
    if (!acknowledged) {
      console.warn(
        'WARNING: connecting with TLS but NOT verifying the server certificate.\n' +
          '         Set PGSSLROOTCERT to the Supabase CA to verify it, or pass\n' +
          '         --insecure-tls to acknowledge and silence this.\n',
      );
    }
  }
}

const client = new pg.Client({ connectionString, ssl });

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

try {
  await client.connect();
  console.log(`Verifying ${connectionString.replace(/:\/\/[^@]*@/, '://***:***@')}\n`);

  // --- 1. Migrations recorded ------------------------------------------
  // Derived from the directory, never a hand-kept list: the previous literal
  // silently stopped covering 0004 the moment it was added.
  const expected = readdirSync(join(repoRoot, 'db/migrations'))
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  let applied = [];
  try {
    const { rows } = await client.query('SELECT name FROM schema_migrations ORDER BY name');
    applied = rows.map((r) => r.name);
  } catch {
    check('schema_migrations exists', false, 'table missing — migrations were not run by the runner or the _manual bundle');
  }
  const missing = expected.filter((e) => !applied.includes(e));
  check(
    `all ${expected.length} migrations recorded`,
    missing.length === 0,
    missing.length ? `missing: ${missing.join(', ')}` : `${applied.length} recorded`,
  );

  // --- 2. citext (D-15) -------------------------------------------------
  const { rows: ext } = await client.query(`SELECT 1 FROM pg_extension WHERE extname = 'citext'`);
  check('citext extension enabled (D-15)', ext.length === 1);

  // --- 3. Table and policy counts --------------------------------------
  const { rows: counts } = await client.query(`
    SELECT
      (SELECT count(*)::int FROM pg_tables WHERE schemaname='public')                     AS tables,
      (SELECT count(*)::int FROM pg_policies WHERE schemaname='public')                   AS policies,
      (SELECT count(*)::int FROM pg_tables WHERE schemaname='public' AND rowsecurity)     AS rls_enabled
  `);
  const { tables, policies, rls_enabled } = counts[0];
  // 59 frozen + 2 from 0002 + schema_migrations = 62.
  check('table count', tables >= 62, `${tables} (expected >= 62)`);
  check('policy count', policies >= 45, `${policies} (expected ~50)`);
  // Floor, not a target: every table in public carries RLS today (62 of 62,
  // schema_migrations included). The label used to read "expected 61", which
  // made a passing run look like a discrepancy and misled a review into
  // "correcting" the completion report's correct figure.
  check('RLS-enabled tables', rls_enabled >= 61, `${rls_enabled} of ${tables} (minimum 61)`);

  // --- 4. No table left unprotected (the coverage invariant) ------------
  const { rows: unprotected } = await client.query(`
    SELECT tablename FROM pg_tables
    WHERE schemaname='public'
      AND tablename <> 'schema_migrations'
      AND (NOT rowsecurity
           OR tablename NOT IN (SELECT tablename FROM pg_policies WHERE schemaname='public'))
    ORDER BY tablename
  `);
  check(
    'every table has RLS and at least one policy',
    unprotected.length === 0,
    unprotected.length ? `unprotected: ${unprotected.map((r) => r.tablename).join(', ')}` : undefined,
  );

  // --- 5. D-02 — the supplier floor is not selectable -------------------
  const { rows: floor } = await client.query(`
    SELECT 1 FROM information_schema.column_privileges
    WHERE table_name='receivable_transactions' AND grantee='authenticated'
      AND privilege_type='SELECT' AND column_name='minimum_acceptable_amount'
  `);
  check('D-02: minimum_acceptable_amount not selectable by authenticated', floor.length === 0);

  // --- 6. Column revokes added by 0003 and 0006 ------------------------
  for (const [table, column, label] of [
    ['funding_otps', 'otp_hash', 'otp_hash'],
    ['buyer_payments', 'bank_internal_notes', 'bank_internal_notes (ZM-PMT-018)'],
    // ZM-RSK-013: a bank must not be able to read the scoring weights out
    // of the database and reconstruct what the API deliberately withholds.
    ['risk_model_versions', 'weights', 'risk model weights (ZM-RSK-013)'],
    ['risk_model_versions', 'training_metrics', 'risk model training_metrics (ZM-RSK-013)'],
  ]) {
    const { rows } = await client.query(
      `SELECT 1 FROM information_schema.column_privileges
        WHERE table_name=$1 AND grantee='authenticated'
          AND privilege_type='SELECT' AND column_name=$2`,
      [table, column],
    );
    check(`${label} not selectable by authenticated`, rows.length === 0);
  }

  // --- 7. anon has nothing ---------------------------------------------
  const { rows: anon } = await client.query(`
    SELECT table_name FROM information_schema.table_privileges
    WHERE grantee='anon' AND table_schema='public'
  `);
  check('anon has no privileges in public', anon.length === 0, anon.length ? `${anon.length} grants remain` : undefined);

  // --- 8. Writes revoked from authenticated ----------------------------
  const { rows: writes } = await client.query(`
    SELECT DISTINCT table_name FROM information_schema.table_privileges
    WHERE grantee='authenticated' AND table_schema='public'
      AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')
  `);
  check(
    'authenticated has no write privileges (all writes go through the API)',
    writes.length === 0,
    writes.length ? `${writes.length} table(s) still writable` : undefined,
  );

  // --- 9. D-01 — the replacement fingerprint index ----------------------
  const { rows: idx } = await client.query(
    `SELECT indexdef FROM pg_indexes WHERE indexname='uq_active_invoice_fingerprint'`,
  );
  check(
    'D-01: uq_active_invoice_fingerprint exists and is partial on is_active_fingerprint',
    idx.length === 1 && /is_active_fingerprint/.test(idx[0].indexdef),
    idx.length ? undefined : 'index missing',
  );

  // --- 10. Helper functions the policies depend on ----------------------
  const { rows: fns } = await client.query(`
    SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND proname IN
      ('current_user_org_ids','current_user_is_platform','app_current_user_id',
       'app_can_see_tx','app_is_tx_party','app_has_buyer_relationship','app_can_see_offer')
  `);
  check('all 7 RLS helper functions present', fns.length === 7, `${fns.length}/7`);

  // --- 11. Frozen platform settings -------------------------------------
  const { rows: settings } = await client.query(`SELECT count(*)::int AS n FROM platform_settings`);
  // 17 from the frozen schema + 3 from migration 0002.
  check('platform_settings seeded', settings[0].n >= 20, `${settings[0].n} keys (expected 20)`);

  // --- 12. Append-only rules on audit and ledger ------------------------
  const { rows: rules } = await client.query(`
    SELECT rulename FROM pg_rules
    WHERE schemaname='public'
      AND rulename IN ('audit_no_update','audit_no_delete','ledger_no_update','ledger_no_delete')
  `);
  check('append-only rules on audit_logs and ledger_entries (INV-7)', rules.length === 4, `${rules.length}/4`);

  console.log('');
  const failed = results.filter((r) => !r.pass);
  if (failed.length) {
    console.error(`${failed.length} check(s) FAILED. The database does not match what the API expects.`);
    console.error('Do not treat the migration run as complete until these pass.');
    process.exit(1);
  }
  console.log(`All ${results.length} checks passed. Database matches the expected schema.`);
} catch (err) {
  console.error(`\nFATAL: ${err.message}`);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
