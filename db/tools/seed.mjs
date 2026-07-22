#!/usr/bin/env node
/**
 * Development seed.
 *
 *   node db/tools/seed.mjs           create/update the seed population
 *   node db/tools/seed.mjs --purge   delete seeded rows first (dev only)
 *
 * Creates real Supabase Auth users via the admin API and the matching
 * platform rows, so Agent B can log in the moment Phase 1 lands. Auth users
 * are created first: the platform `users` row carries auth_user_id, and
 * seeding one without the other produces an account that can sign in but
 * has no memberships — which presents as a mysteriously empty /auth/me.
 *
 * Idempotent. Re-running updates in place rather than duplicating, so it is
 * safe to run after every migration change.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { ORGANIZATIONS, USERS, BUYERS, SEED_PASSWORD } from '../seed/identities.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

try {
  for (const line of readFileSync(join(repoRoot, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {
  /* environment-provided config (CI) */
}

const { DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NODE_ENV } = process.env;

for (const [k, v] of Object.entries({ DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY })) {
  if (!v) {
    console.error(`FATAL: ${k} is not set. The seed needs it to create auth users.`);
    process.exit(1);
  }
}

// These are test accounts with a published password. Creating them on a
// production database would be handing out working logins.
if (NODE_ENV === 'production') {
  console.error(
    'FATAL: refusing to seed with NODE_ENV=production.\n' +
      'The seed creates accounts with a well-known password documented in\n' +
      'docs/specs/GOV_DUMMY_DATA.md.',
  );
  process.exit(1);
}

const purge = process.argv.includes('--purge');

const needsTls = /supabase\.(com|co)/.test(DATABASE_URL) || process.env.PGSSLMODE === 'require';
const client = new pg.Client({
  connectionString: DATABASE_URL,
  ssl: needsTls ? { rejectUnauthorized: false } : undefined,
});

// --- Supabase Auth admin API -----------------------------------------------

const authHeaders = {
  apikey: SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
};

async function findAuthUser(email) {
  const url = new URL('/auth/v1/admin/users', SUPABASE_URL);
  url.searchParams.set('page', '1');
  url.searchParams.set('per_page', '200');
  const res = await fetch(url, { headers: authHeaders });
  if (!res.ok) throw new Error(`Auth admin list failed (${res.status}): ${await res.text()}`);
  const body = await res.json();
  return (body.users ?? []).find((u) => u.email?.toLowerCase() === email.toLowerCase()) ?? null;
}

async function upsertAuthUser(email, fullName) {
  const existing = await findAuthUser(email);
  if (existing) {
    // Reset the password so a re-run recovers an account whose password was
    // changed by hand during testing.
    const res = await fetch(new URL(`/auth/v1/admin/users/${existing.id}`, SUPABASE_URL), {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ password: SEED_PASSWORD, email_confirm: true }),
    });
    if (!res.ok) throw new Error(`Auth update failed for ${email} (${res.status}): ${await res.text()}`);
    return { id: existing.id, created: false };
  }

  const res = await fetch(new URL('/auth/v1/admin/users', SUPABASE_URL), {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      email,
      password: SEED_PASSWORD,
      // Confirmed on creation: email verification is Agent B's flow against
      // Supabase directly (PA-04), and seeded personas must be able to log
      // in without an inbox.
      email_confirm: true,
      user_metadata: { full_name: fullName, seeded: true },
    }),
  });
  if (!res.ok) throw new Error(`Auth create failed for ${email} (${res.status}): ${await res.text()}`);
  const body = await res.json();
  return { id: body.id, created: true };
}

// --- Seed ------------------------------------------------------------------

const stats = { orgs: 0, authCreated: 0, authExisting: 0, users: 0, memberships: 0, roles: 0, buyers: 0 };

try {
  await client.connect();
  console.log(`Seeding ${DATABASE_URL.replace(/:\/\/[^@]*@/, '://***:***@')}\n`);

  const { rows: check } = await client.query(
    `SELECT to_regclass('public.organizations') IS NOT NULL AS ready`,
  );
  if (!check[0].ready) {
    console.error('FATAL: the schema is not migrated (organizations does not exist).');
    console.error('Run the migrations first — see docs/ops/RUN_MIGRATIONS_MANUALLY.md.');
    process.exit(1);
  }

  if (purge) {
    console.log('--purge: removing previously seeded rows …');
    await client.query('BEGIN');
    // Order matters: children before parents, and audit_logs references
    // users. Only seeded organizations are touched, identified by their
    // reserved establishment-number ranges.
    await client.query(`
      DELETE FROM audit_logs WHERE actor_user_id IN (
        SELECT id FROM users WHERE email LIKE '%@%.zimmamless.test');
      DELETE FROM membership_roles WHERE membership_id IN (
        SELECT id FROM organization_memberships WHERE user_id IN (
          SELECT id FROM users WHERE email LIKE '%@%.zimmamless.test'));
      DELETE FROM organization_memberships WHERE user_id IN (
        SELECT id FROM users WHERE email LIKE '%@%.zimmamless.test');
      DELETE FROM users WHERE email LIKE '%@%.zimmamless.test';
      DELETE FROM buyers WHERE national_establishment_no LIKE '3000%';
      DELETE FROM organizations
        WHERE national_establishment_no LIKE '2000%'
           OR national_establishment_no LIKE '4000%';
    `);
    await client.query('COMMIT');
    console.log('  done.\n');
  }

  // --- Organizations -------------------------------------------------------
  const orgIds = new Map();
  for (const org of ORGANIZATIONS) {
    const { rows } = await client.query(
      `INSERT INTO organizations
         (organization_type, legal_name, status, national_establishment_no,
          commercial_registration_no, tax_number, bank_licence_number, swift_code,
          contact_email, platform_terms_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'v1.0')
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        org.type,
        org.legalName,
        org.status,
        org.nationalEstablishmentNo,
        org.commercialRegistrationNo ?? null,
        org.taxNumber ?? null,
        org.bankLicenceNumber ?? null,
        org.swiftCode ?? null,
        `contact@${org.slug}.zimmamless.test`,
      ],
    );

    // ON CONFLICT DO NOTHING returns no row when the org already exists (the
    // uq_org_national_no partial index covers suppliers only, so banks and
    // the platform are matched by name).
    let id = rows[0]?.id;
    if (!id) {
      const found = await client.query(
        `SELECT id FROM organizations
          WHERE national_establishment_no = $1 AND organization_type = $2 LIMIT 1`,
        [org.nationalEstablishmentNo, org.type],
      );
      id = found.rows[0]?.id;
      if (!id) throw new Error(`Could not create or find organization ${org.slug}`);
    } else {
      stats.orgs++;
    }
    orgIds.set(org.slug, id);
  }
  console.log(`Organizations: ${orgIds.size} present (${stats.orgs} created)`);

  // --- Users, auth accounts, memberships, roles ----------------------------
  for (const user of USERS) {
    const auth = await upsertAuthUser(user.email, user.fullName);
    auth.created ? stats.authCreated++ : stats.authExisting++;

    const { rows: userRows } = await client.query(
      `INSERT INTO users (auth_user_id, full_name, email, phone_number, preferred_language, status)
       VALUES ($1,$2,$3,$4,'EN','ACTIVE')
       ON CONFLICT (email) DO UPDATE
         SET auth_user_id = EXCLUDED.auth_user_id,
             full_name    = EXCLUDED.full_name,
             phone_number = EXCLUDED.phone_number,
             updated_at   = now()
       RETURNING id`,
      [auth.id, user.fullName, user.email, user.phoneNumber],
    );
    const userId = userRows[0].id;
    stats.users++;

    for (const m of user.memberships) {
      const orgId = orgIds.get(m.org);
      if (!orgId) throw new Error(`Unknown org slug "${m.org}" for ${user.email}`);

      const { rows: memRows } = await client.query(
        `INSERT INTO organization_memberships
           (user_id, organization_id, status, is_authorized_signatory, job_title)
         VALUES ($1,$2,'ACTIVE',$3,$4)
         ON CONFLICT (user_id, organization_id) DO UPDATE
           SET status = 'ACTIVE', is_authorized_signatory = EXCLUDED.is_authorized_signatory
         RETURNING id`,
        [userId, orgId, m.isAuthorizedSignatory, m.roles[0].replace(/_/g, ' ').toLowerCase()],
      );
      const membershipId = memRows[0].id;
      stats.memberships++;

      for (const role of m.roles) {
        await client.query(
          `INSERT INTO membership_roles (membership_id, role)
           VALUES ($1,$2) ON CONFLICT (membership_id, role) DO NOTHING`,
          [membershipId, role],
        );
        stats.roles++;
      }
    }
  }
  console.log(
    `Users: ${stats.users} (auth: ${stats.authCreated} created, ${stats.authExisting} existing)`,
  );
  console.log(`Memberships: ${stats.memberships}, role grants: ${stats.roles}`);

  // --- Buyers --------------------------------------------------------------
  for (const b of BUYERS) {
    await client.query(
      `INSERT INTO buyers
         (national_establishment_no, legal_company_name, registry_status, governorate,
          company_type, registered_address, last_verified_at)
       VALUES ($1,$2,$3,$4,'LLC',$5, now())
       ON CONFLICT (national_establishment_no) DO UPDATE
         SET legal_company_name = EXCLUDED.legal_company_name,
             registry_status    = EXCLUDED.registry_status,
             updated_at         = now()`,
      [b.no, b.name, b.status, b.governorate, `${b.governorate}, Jordan`],
    );
    stats.buyers++;
  }
  console.log(`Buyers: ${stats.buyers} (3 ACTIVE, 3 blocked for block-state screens)`);

  console.log('\nSeed complete. Personas can now sign in:');
  console.log(`  password for every account: ${SEED_PASSWORD}`);
  console.log('  supplier : owner@alnoor.zimmamless.test');
  console.log('  bank     : maker@jnb.zimmamless.test / approver@jnb.zimmamless.test');
  console.log('  platform : admin@platform.zimmamless.test');
  console.log('  multi-org: multi@platform.zimmamless.test  (platform + petra)');
} catch (err) {
  console.error(`\nFATAL: ${err.message}`);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
