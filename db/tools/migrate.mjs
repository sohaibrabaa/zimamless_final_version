#!/usr/bin/env node
/**
 * Migration runner.
 *
 *   node db/tools/migrate.mjs            apply all pending migrations
 *   node db/tools/migrate.mjs --status   list applied / pending, apply nothing
 *   node db/tools/migrate.mjs --dry-run  parse and order, apply nothing
 *   node db/tools/migrate.mjs --reset    DROP and recreate the public schema first
 *
 * Connection comes from DATABASE_URL. For Supabase use the session-mode
 * pooler (port 5432) or the direct connection — DDL does not work over the
 * transaction-mode pooler on port 6543.
 *
 * Each migration runs inside its own transaction and is recorded in
 * schema_migrations with a checksum. A file whose contents changed after
 * being applied is a hard error: migrations are append-only, so fixes ship
 * as a new file rather than an edit to an applied one.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

const args = new Set(process.argv.slice(2));
const statusOnly = args.has('--status');
const dryRun = args.has('--dry-run');
const reset = args.has('--reset');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('FATAL: DATABASE_URL is not set. See .env.example.');
  process.exit(1);
}

if (reset && process.env.ALLOW_DESTRUCTIVE !== 'true') {
  console.error(
    'FATAL: --reset drops the entire public schema.\n' +
      'Re-run with ALLOW_DESTRUCTIVE=true if that is genuinely what you want.',
  );
  process.exit(1);
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

const migrations = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((name) => {
    const sql = readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
    return { name, sql, checksum: sha256(sql) };
  });

if (migrations.length === 0) {
  console.error(`FATAL: no .sql files found in ${MIGRATIONS_DIR}`);
  process.exit(1);
}

// Supabase requires TLS; its certificate chain is not in Node's default
// trust store, so verification is disabled for this admin-only connection.
const needsTls = /supabase\.(com|co)/.test(connectionString) || process.env.PGSSLMODE === 'require';
const client = new pg.Client({
  connectionString,
  ssl: needsTls ? { rejectUnauthorized: false } : undefined,
});

const label = connectionString.replace(/:\/\/[^@]*@/, '://***:***@');

try {
  await client.connect();
  console.log(`Connected: ${label}\n`);

  if (reset) {
    console.log('--reset: dropping and recreating schema public …');
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
    // Restore the grants Supabase expects on the schema itself. Table-level
    // privileges are then set deliberately by migration 0003.
    await client.query('GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role');
    await client.query('GRANT ALL ON SCHEMA public TO postgres');
    console.log('  done.\n');
  }

  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);

  const { rows: appliedRows } = await client.query(
    'SELECT name, checksum, applied_at FROM schema_migrations',
  );
  const applied = new Map(appliedRows.map((r) => [r.name, r]));

  // Drift check before doing anything: an applied migration whose file
  // changed means the database and the repo disagree about history.
  const drifted = migrations.filter(
    (m) => applied.has(m.name) && applied.get(m.name).checksum !== m.checksum,
  );
  if (drifted.length > 0) {
    console.error('FATAL: these applied migrations have been modified on disk:\n');
    for (const m of drifted) console.error(`  ${m.name}`);
    console.error(
      '\nMigrations are append-only. Revert the edits and ship the change as a\n' +
        'new migration, or rebuild the database with --reset if it is disposable.',
    );
    process.exit(1);
  }

  const pending = migrations.filter((m) => !applied.has(m.name));

  console.log('Migration status');
  console.log('----------------');
  for (const m of migrations) {
    const row = applied.get(m.name);
    console.log(
      row
        ? `  [applied] ${m.name}  (${new Date(row.applied_at).toISOString()})`
        : `  [pending] ${m.name}`,
    );
  }
  console.log('');

  if (statusOnly) process.exit(0);

  if (pending.length === 0) {
    console.log('Nothing to apply — database is up to date.');
    process.exit(0);
  }

  if (dryRun) {
    console.log(`--dry-run: would apply ${pending.length} migration(s). Nothing changed.`);
    process.exit(0);
  }

  for (const m of pending) {
    process.stdout.write(`Applying ${m.name} … `);
    try {
      await client.query('BEGIN');
      await client.query(m.sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
        m.name,
        m.checksum,
      ]);
      await client.query('COMMIT');
      console.log('ok');
    } catch (err) {
      await client.query('ROLLBACK');
      console.log('FAILED\n');
      console.error(`  ${err.message}`);
      if (err.position) {
        // Point at the offending statement — a 57k-line migration is not
        // something anyone should have to bisect by hand.
        const upto = m.sql.slice(0, Number(err.position));
        const line = upto.split('\n').length;
        const context = m.sql.split('\n').slice(Math.max(0, line - 4), line + 2);
        console.error(`  at ${m.name}:${line}\n`);
        for (const l of context) console.error(`    ${l}`);
      }
      if (err.detail) console.error(`\n  detail: ${err.detail}`);
      if (err.hint) console.error(`  hint:   ${err.hint}`);
      console.error('\nRolled back. No partial migration was recorded.');
      process.exit(1);
    }
  }

  console.log(`\nApplied ${pending.length} migration(s).`);
} finally {
  await client.end().catch(() => {});
}
