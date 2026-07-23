#!/usr/bin/env node
/**
 * Migration runner.
 *
 *   node db/tools/migrate.mjs            apply all pending migrations
 *   node db/tools/migrate.mjs --status   list applied / pending, apply nothing
 *   node db/tools/migrate.mjs --dry-run  parse and order, apply nothing
 *   node db/tools/migrate.mjs --reset    DROP and recreate the public schema first
 *   node db/tools/migrate.mjs --baseline <name>|all
 *                                        record as applied WITHOUT running
 *   node db/tools/migrate.mjs --rebaseline <name>
 *                                        re-record an applied migration's
 *                                        checksum (see the flag's comment)
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
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Load the repo-root .env, as verify.mjs and seed.mjs do. Without this the
// runner is the only tool in the set that needs DATABASE_URL exported by
// hand, which is the kind of inconsistency that gets "fixed" by pasting a
// live connection string onto a command line.
try {
  for (const line of readFileSync(join(REPO_ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
} catch {
  // Absent in CI, where DATABASE_URL comes from the environment.
}

const args = new Set(process.argv.slice(2));
const statusOnly = args.has('--status');
const dryRun = args.has('--dry-run');
const reset = args.has('--reset');
/**
 * --baseline <name>: record a migration as applied WITHOUT running it.
 *
 * For a database whose early migrations were applied by hand (pasted into
 * the Supabase SQL editor, say) before the runner existed. Without this the
 * runner sees them as pending and re-running them fails on the first
 * CREATE TYPE that already exists — leaving no way to adopt the database
 * short of dropping it.
 *
 * Deliberately per-migration and explicit rather than a blanket "mark
 * everything applied": baselining a migration that was NOT actually applied
 * silently skips it forever, and the failure surfaces much later as a
 * missing table. `db:verify` is the check that the claim was true.
 */
const baselineNames = [];
/**
 * --rebaseline <name>: update the stored checksum of an ALREADY-APPLIED
 * migration to the current file's bytes.
 *
 * For the one situation --baseline cannot reach: a migration recorded with
 * a checksum whose source bytes no longer exist anywhere — applied from a
 * working copy that was edited before being committed, or recorded on a
 * checkout with different line endings. The drift check then fails forever
 * and no further migration can be applied, even though the database is
 * correct.
 *
 * Deliberately narrower than --baseline: it refuses "all", refuses a
 * migration that is not already recorded, and prints both checksums, so
 * "the file changed and I want to overwrite history" cannot be done by
 * reflex. It asserts the database already contains this migration's effect;
 * `db:verify` is what checks that claim. Use it only after verifying.
 */
const rebaselineNames = [];
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--baseline' || argv[i] === '--rebaseline') {
      const flag = argv[i];
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        console.error(
          flag === '--baseline'
            ? 'FATAL: --baseline requires a migration name, or "all".'
            : 'FATAL: --rebaseline requires an explicit migration name ("all" is not accepted).',
        );
        process.exit(1);
      }
      if (flag === '--rebaseline') {
        if (value === 'all') {
          console.error(
            'FATAL: --rebaseline does not accept "all". Rewriting every recorded\n' +
              'checksum at once is indistinguishable from silently accepting real drift.\n' +
              'Name each migration you have verified.',
          );
          process.exit(1);
        }
        rebaselineNames.push(value);
      } else {
        baselineNames.push(value);
      }
      i++;
    }
  }
}

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

  // --rebaseline: re-record the checksum of an already-applied migration.
  // Runs before the drift check, since resolving that check is its purpose.
  for (const name of rebaselineNames) {
    const migration = migrations.find((m) => m.name === name);
    if (!migration) {
      console.error(`FATAL: no migration file named "${name}".`);
      process.exit(1);
    }
    const row = applied.get(name);
    if (!row) {
      console.error(
        `FATAL: ${name} is not recorded as applied, so there is nothing to re-baseline.\n` +
          'Use --baseline to record a migration that was applied by hand.',
      );
      process.exit(1);
    }
    if (row.checksum === migration.checksum) {
      console.log(`  [rebaseline] ${name} — checksum already matches, nothing to do`);
      continue;
    }
    await client.query('UPDATE schema_migrations SET checksum = $2 WHERE name = $1', [
      name,
      migration.checksum,
    ]);
    applied.set(name, { ...row, checksum: migration.checksum });
    console.log(`  [rebaseline] ${name}`);
    console.log(`      was: ${row.checksum}`);
    console.log(`      now: ${migration.checksum}`);
  }
  if (rebaselineNames.length > 0) {
    console.log(
      '\nRe-baselined. This asserted that the database already contains what these\n' +
        'migrations describe; it did not check. Run `npm run db:verify`.\n',
    );
  }

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

  // --baseline: record as applied without executing. Runs before the
  // pending calculation so a baselined migration is not then applied.
  if (baselineNames.length > 0) {
    const wanted = baselineNames.includes('all')
      ? migrations.map((m) => m.name)
      : baselineNames;

    for (const name of wanted) {
      const migration = migrations.find((m) => m.name === name);
      if (!migration) {
        console.error(`FATAL: no migration file named "${name}".`);
        process.exit(1);
      }
      if (applied.has(name)) {
        console.log(`  [baseline] ${name} — already recorded, skipping`);
        continue;
      }
      await client.query(
        'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING',
        [migration.name, migration.checksum],
      );
      applied.set(name, { name, checksum: migration.checksum, applied_at: new Date() });
      console.log(`  [baseline] ${name} — recorded as applied (NOT executed)`);
    }
    console.log(
      '\nBaselined. Run `npm run db:verify` to confirm the database really does\n' +
        'contain what these migrations describe — baselining asserts it, and\n' +
        'only verification checks it.\n',
    );
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
