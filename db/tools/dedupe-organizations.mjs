#!/usr/bin/env node
/**
 * Remediate duplicate organizations in a hosted database.
 *
 *   node db/tools/dedupe-organizations.mjs           dry run — report only
 *   node db/tools/dedupe-organizations.mjs --apply    remap references, delete dupes
 *
 * Why this exists
 * ---------------
 * `uq_org_national_no` is a PARTIAL unique index covering suppliers only, so a
 * bank or the platform org had nothing to conflict with, and every re-run of
 * the seed's old `ON CONFLICT DO NOTHING` insert added a fresh copy. The
 * hosted database accumulated several identical bank organizations. The seed
 * is fixed (it now looks before inserting), so no NEW duplicates appear — but
 * the ones already there have to be merged, and that cannot be a blind DELETE:
 * a duplicate may be referenced by memberships, offers, eligibility, audit
 * rows. Those references must move to the surviving row first.
 *
 * What it does
 * ------------
 * A duplicate group is rows sharing (organization_type, national_establishment
 * _no, legal_name) with a non-null establishment number — identical
 * organizations, never a coincidental match. The OLDEST row (min created_at)
 * survives as canonical; the rest are merged into it:
 *
 *   1. every foreign key that references organizations(id) — discovered from
 *      the catalogue, not hard-coded — is repointed from the duplicate to the
 *      canonical id;
 *   2. where repointing would collide with a row the canonical org already has
 *      (a user who is a member of both), the duplicate-side row is redundant
 *      and is removed instead;
 *   3. the now-unreferenced duplicate organization is deleted.
 *
 * Everything for one group runs in a single transaction with a savepoint, so a
 * surprise leaves that group untouched and reported rather than half-merged.
 * Read-only until `--apply`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

try {
  for (const line of readFileSync(join(repoRoot, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {
  /* environment-provided config (CI) */
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('FATAL: DATABASE_URL is not set (checked .env and the environment).');
  process.exit(1);
}

const apply = process.argv.includes('--apply');
const needsTls = /supabase\.(com|co)/.test(connectionString) || process.env.PGSSLMODE === 'require';
const client = new pg.Client({
  connectionString,
  ssl: needsTls ? { rejectUnauthorized: false } : undefined,
});

/**
 * Every column in `public` that is a foreign key onto organizations(id).
 * Discovered rather than listed, so a table added in a later phase is covered
 * without editing this tool.
 */
async function organizationReferences() {
  const { rows } = await client.query(`
    SELECT tc.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name
       AND kcu.constraint_schema = tc.constraint_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
       AND ccu.constraint_schema = tc.constraint_schema
     WHERE tc.constraint_type = 'FOREIGN KEY'
       AND tc.table_schema = 'public'
       AND ccu.table_name = 'organizations'
       AND ccu.column_name = 'id'
     ORDER BY tc.table_name, kcu.column_name
  `);
  return rows.map((r) => ({ table: r.table_name, column: r.column_name }));
}

async function duplicateGroups() {
  const { rows } = await client.query(`
    SELECT organization_type, national_establishment_no, legal_name,
           array_agg(id ORDER BY created_at) AS ids
      FROM organizations
     WHERE national_establishment_no IS NOT NULL
     GROUP BY organization_type, national_establishment_no, legal_name
    HAVING count(*) > 1
     ORDER BY organization_type, legal_name
  `);
  return rows.map((r) => ({
    type: r.organization_type,
    establishmentNo: r.national_establishment_no,
    legalName: r.legal_name,
    canonical: r.ids[0],
    duplicates: r.ids.slice(1),
  }));
}

/** How many rows point at an organization id, per referencing column. */
async function referenceCounts(refs, orgId) {
  const counts = [];
  for (const ref of refs) {
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM ${ident(ref.table)} WHERE ${ident(ref.column)} = $1`,
      [orgId],
    );
    if (rows[0].n > 0) counts.push({ ...ref, n: rows[0].n });
  }
  return counts;
}

/**
 * Merge one duplicate id into the canonical id. Assumes an open transaction.
 *
 * The bulk repoint is tried first. Where a table has a unique constraint that
 * the canonical org already satisfies — `bank_eligibility (listing_id,
 * bank_org_id)`, `organization_memberships (user_id, organization_id)` — the
 * repoint would violate it, because the duplicate's row is redundant with one
 * the canonical org already has. That case falls back to a row-by-row pass:
 * move what can be moved, drop what would collide. Membership role grants are
 * removed by the ON DELETE CASCADE on `membership_roles.membership_id`.
 */
async function mergeDuplicate(refs, canonical, duplicate) {
  const moved = [];
  for (const ref of refs) {
    const table = ident(ref.table);
    const column = ident(ref.column);

    await client.query('SAVEPOINT ref');
    try {
      const res = await client.query(
        `UPDATE ${table} SET ${column} = $1 WHERE ${column} = $2`,
        [canonical, duplicate],
      );
      await client.query('RELEASE SAVEPOINT ref');
      if (res.rowCount) moved.push(`${ref.table}.${ref.column}: →${res.rowCount}`);
    } catch (err) {
      if (err.code !== '23505') throw err; // only a unique collision is recoverable
      await client.query('ROLLBACK TO SAVEPOINT ref');
      await client.query('RELEASE SAVEPOINT ref');

      // Row by row, addressing each physical row by ctid so no assumption is
      // made about the table's key shape.
      const { rows } = await client.query(
        `SELECT ctid FROM ${table} WHERE ${column} = $1`,
        [duplicate],
      );
      let repointed = 0;
      let dropped = 0;
      for (const row of rows) {
        await client.query('SAVEPOINT one');
        try {
          await client.query(`UPDATE ${table} SET ${column} = $1 WHERE ctid = $2`, [
            canonical,
            row.ctid,
          ]);
          await client.query('RELEASE SAVEPOINT one');
          repointed++;
        } catch (inner) {
          if (inner.code !== '23505') throw inner;
          await client.query('ROLLBACK TO SAVEPOINT one');
          await client.query('RELEASE SAVEPOINT one');
          await client.query(`DELETE FROM ${table} WHERE ctid = $1`, [row.ctid]);
          dropped++;
        }
      }
      moved.push(`${ref.table}.${ref.column}: →${repointed}, dropped ${dropped} redundant`);
    }
  }

  await client.query(`DELETE FROM organizations WHERE id = $1`, [duplicate]);
  return moved;
}

/** Quote an identifier from the catalogue. Defensive — these come from pg, not a user. */
function ident(name) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`Unsafe identifier: ${name}`);
  return `"${name}"`;
}

try {
  await client.connect();
  console.log(`${apply ? 'APPLYING to' : 'Dry run against'} ${connectionString.replace(/:\/\/[^@]*@/, '://***:***@')}\n`);

  const refs = await organizationReferences();
  const groups = await duplicateGroups();

  if (groups.length === 0) {
    console.log('No duplicate organizations found. Nothing to do.');
    process.exit(0);
  }

  console.log(`Found ${groups.length} duplicate group(s):\n`);
  let failures = 0;

  for (const g of groups) {
    console.log(`• ${g.type} "${g.legalName}" (est. ${g.establishmentNo})`);
    console.log(`    keep     ${g.canonical}`);
    for (const dup of g.duplicates) {
      const counts = await referenceCounts(refs, dup);
      const summary = counts.length
        ? counts.map((c) => `${c.table}.${c.column}=${c.n}`).join(', ')
        : 'no references';
      console.log(`    merge    ${dup}  (${summary})`);

      if (apply) {
        await client.query('BEGIN');
        try {
          const moved = await mergeDuplicate(refs, g.canonical, dup);
          await client.query('COMMIT');
          console.log(`      merged: ${moved.length ? moved.join('; ') : 'no references to move'}; org deleted`);
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          failures++;
          console.error(`      FAILED (left untouched): ${err.message}`);
        }
      }
    }
    console.log('');
  }

  if (!apply) {
    console.log('Dry run only. Re-run with --apply to perform the merge.');
  } else if (failures) {
    console.error(`${failures} group(s) could not be merged and were left intact. See above.`);
    process.exit(1);
  } else {
    console.log('All duplicate organizations merged into their canonical row.');
  }
} catch (err) {
  console.error(`\nFATAL: ${err.message}`);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
