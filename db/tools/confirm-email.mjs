/**
 * Confirm a Supabase Auth user's email without the confirmation link.
 *
 *   node db/tools/confirm-email.mjs someone@example.com
 *   npm run confirm:email -w db -- someone@example.com
 *
 * Why this exists: the confirmation email's link points at the machine
 * running the web app (localhost:3001). Opened anywhere else — a phone, a
 * different laptop — it dead-ends on ERR_CONNECTION_FAILED. For a local
 * demo the operator IS the administrator, so confirming server-side is the
 * honest equivalent of clicking the link. Dev-only: refuses production, and
 * only flips `email_confirmed_at` — it never touches passwords or roles.
 *
 * (The lasting fix is the Supabase dashboard: Authentication → Sign In /
 * Providers → Email → turn "Confirm email" off. Then signUp returns a live
 * session immediately and this tool becomes unnecessary.)
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

const { DATABASE_URL, NODE_ENV } = process.env;
if (!DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is not set.');
  process.exit(1);
}
if (NODE_ENV === 'production') {
  console.error('FATAL: refusing to hand-confirm users with NODE_ENV=production.');
  process.exit(1);
}

const email = (process.argv[2] ?? '').trim().toLowerCase();
if (!email || !email.includes('@')) {
  console.error('Usage: node db/tools/confirm-email.mjs <email>');
  process.exit(1);
}

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();
try {
  const { rows } = await client.query(
    `UPDATE auth.users
        SET email_confirmed_at = COALESCE(email_confirmed_at, now())
      WHERE lower(email) = $1
      RETURNING id, email, email_confirmed_at`,
    [email],
  );
  if (rows.length === 0) {
    console.error(`No auth user with email ${email}. Register first, then re-run.`);
    process.exit(1);
  }
  const u = rows[0];
  console.log(`Confirmed: ${u.email} (user ${u.id}, confirmed at ${u.email_confirmed_at.toISOString()})`);
  console.log('They can sign in now — no email link needed.');
} finally {
  await client.end();
}
