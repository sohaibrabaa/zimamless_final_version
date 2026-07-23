#!/usr/bin/env node
/**
 * Phase 5 checkpoint scenario — a listing with two approvable draft offers.
 *
 *   node db/tools/scenario-phase5.mjs           create (or top up) the scenario
 *   node db/tools/scenario-phase5.mjs --status  report what is present
 *   node db/tools/scenario-phase5.mjs --purge   remove what can be removed
 *
 * The Phase 5 phase file lists this as a seed. It is not written as SQL, and
 * that is the whole design of the file.
 *
 * A listing is not a row. Activating one creates a listing-fee obligation, a
 * balanced double-entry ledger journal, an eligibility decision for every
 * active bank with the specific rules that produced it, a notification per
 * eligible bank, and a transaction state change — all inside one transaction
 * (ZM-FEE-001..005, ZM-MKT-003). An offer is not a row either: its
 * commission comes from the active tier, its listing-fee component from the
 * unpaid obligation, and its net is recomputed by the server and checked
 * against the database's own CHECK constraint. Hand-writing any of that in
 * SQL would produce a listing that looks right in the UI and was never
 * priced, never evaluated, and never audited — the exact failure the Phase 2
 * audit found in reverse, where residue from live runs had been described as
 * seeded fixtures. So this script calls the API, with real Supabase logins,
 * as the personas who are entitled to perform each step.
 *
 * What it DOES arrange directly in SQL is the ELIGIBLE transaction and its
 * invoice, for the same reason the Phase 5 integration suite does: the
 * subject here is what the marketplace does *with* an eligible transaction,
 * and the route it took to become eligible is not part of what is being
 * demonstrated. The Phase 3 journey suite is what proves that route.
 *
 * The two offers are left in PENDING_INTERNAL_APPROVAL — "approvable" in the
 * phase file's sense. Approving them here would consume the checkpoint's most
 * important moment: the maker's own approval attempt being refused (INV-12)
 * and a second, different user approving. Those are demonstrated, not seeded.
 *
 * Requires the API to be running (npm run dev -w @zimmamless/api) and the
 * base seed to have been applied (db/tools/seed.mjs, 0100/0200/0300).
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

const {
  DATABASE_URL,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  NODE_ENV,
  SEED_USER_PASSWORD = 'Zimmamless#2026',
  API_BASE_URL = 'http://localhost:3000/v1',
} = process.env;

for (const [k, v] of Object.entries({ DATABASE_URL, SUPABASE_URL, SUPABASE_ANON_KEY })) {
  if (!v) {
    console.error(`FATAL: ${k} is not set.`);
    process.exit(1);
  }
}

if (NODE_ENV === 'production') {
  console.error('FATAL: refusing to run the demo scenario with NODE_ENV=production.');
  process.exit(1);
}

const supabase = SUPABASE_URL.replace(/\/+$/, '');
const status = process.argv.includes('--status');
const purge = process.argv.includes('--purge');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
// Fixed ids, so a re-run finds its own work instead of accumulating listings,
// and so Agent B and the demo script can hard-code a URL. These sit in the
// `0e900000` block, which no other seed or suite uses.

const FIX = {
  tx: '0e900000-0000-4000-8000-000000000001',
  invoice: '0e900000-0000-4000-8000-000000000002',
};

const AL_NOOR_ORG = '0e000000-0000-4000-8000-000000000002';
const AL_NOOR_OWNER = '0e100000-0000-4000-8000-000000000001';
const BUYER_ESTABLISHMENT = '30000201'; // Amman Retail Group — the demo pairing

/**
 * The supplier's private floor: 8 000.000 JOD against an 11 600.000 invoice.
 *
 * Deliberately low enough that both seeded offers clear it. The below-floor
 * refusal is a *demonstration* step — the presenter lowers an offer live and
 * the generic 422 comes back — not something to bake in, because a seeded
 * rejected offer proves nothing about the code path that rejects it.
 */
const FLOOR = '8000.000';

/**
 * Two offers whose numbers are worth looking at side by side: bank B advances
 * more gross but charges more in fees, so the ranking by gross and the
 * ranking by net disagree. That is exactly the point of the comparison
 * screen — the net payout is the anchor, and the biggest headline number is
 * not automatically the best deal.
 *
 * Commission is 1.5% of gross (tier 1, 0–10 000) and the listing fee is
 * 25.000, both injected by the server; the arithmetic below is only here so
 * the console can say what to expect.
 *
 *   A: 9 000.000 − 300.000 − 150.000 − 135.000 − 25.000 = 8 390.000
 *   B: 9 200.000 − 520.000 − 180.000 − 138.000 − 25.000 = 8 337.000
 */
const OFFERS = [
  {
    persona: 'bankAMaker',
    email: 'maker@jnb.zimmamless.test',
    bank: 'Jordan National Bank',
    expectedNet: '8390.000',
    body: {
      transactionType: 'INVOICE_FINANCING',
      recourseType: 'FULL_RECOURSE',
      grossFundingAmount: '9000.000',
      bankDiscountAmount: '300.000',
      bankFeesAmount: '150.000',
      otherDeductionsAmount: '0.000',
      conditions: [
        {
          conditionType: 'REQUIRED_DOCUMENT',
          title: 'Signed assignment notice to the buyer',
          description: 'Countersigned by the buyer’s accounts-payable contact.',
          isMandatory: true,
        },
        {
          conditionType: 'FUNDING_TIMELINE',
          title: 'Disbursement within 2 business days of contract signature',
          isMandatory: false,
        },
      ],
    },
  },
  {
    persona: 'bankBMaker',
    email: 'maker@lcb.zimmamless.test',
    bank: 'Levant Commercial Bank',
    expectedNet: '8337.000',
    body: {
      transactionType: 'RECEIVABLE_PURCHASE',
      recourseType: 'NON_RECOURSE',
      grossFundingAmount: '9200.000',
      bankDiscountAmount: '520.000',
      bankFeesAmount: '180.000',
      otherDeductionsAmount: '0.000',
      conditions: [
        {
          conditionType: 'REQUIRED_GUARANTEE',
          title: 'Personal guarantee from the authorized signatory',
          isMandatory: true,
        },
      ],
    },
  },
];

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

const client = new pg.Client({
  connectionString: DATABASE_URL,
  ssl: /supabase\.(com|co)/.test(DATABASE_URL) ? { rejectUnauthorized: false } : undefined,
});

async function login(email) {
  const res = await fetch(`${supabase}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: SEED_USER_PASSWORD }),
  });
  const body = await res.json();
  if (!body.access_token) {
    throw new Error(`Could not log in as ${email} (${res.status}). Has db:seed been run?`);
  }
  const me = await fetch(`${API_BASE_URL}/auth/me`, {
    headers: { Authorization: `Bearer ${body.access_token}` },
  });
  if (!me.ok) {
    throw new Error(
      `The API did not answer /auth/me (${me.status}). Is it running at ${API_BASE_URL}?`,
    );
  }
  const profile = await me.json();
  return { token: body.access_token, orgId: profile.memberships[0].organizationId };
}

async function api(session, method, path, body) {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${session.token}`,
      'X-Organization-Id': session.orgId,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed, raw: text };
}

/** What is on the ground right now. */
async function report() {
  const { rows: tx } = await client.query(
    `SELECT state, minimum_acceptable_amount FROM receivable_transactions WHERE id = $1`,
    [FIX.tx],
  );
  if (tx.length === 0) {
    console.log('Scenario transaction: absent.');
    return null;
  }
  const { rows: listings } = await client.query(
    `SELECT id, status, offer_submission_deadline, supplier_selection_deadline
       FROM listings WHERE transaction_id = $1 ORDER BY activated_at DESC`,
    [FIX.tx],
  );
  console.log(`Scenario transaction: ${tx[0].state} (floor ${tx[0].minimum_acceptable_amount})`);
  for (const l of listings) {
    const { rows: offers } = await client.query(
      `SELECT o.status, o.net_supplier_payout, org.legal_name
         FROM bank_offers o JOIN organizations org ON org.id = o.bank_org_id
        WHERE o.listing_id = $1 ORDER BY org.legal_name`,
      [l.id],
    );
    console.log(`  listing ${l.id} — ${l.status}`);
    console.log(`    offers close ${l.offer_submission_deadline.toISOString()}`);
    console.log(`    selection by ${l.supplier_selection_deadline.toISOString()}`);
    for (const o of offers) {
      console.log(`    · ${o.legal_name}: ${o.status}, net ${o.net_supplier_payout}`);
    }
    if (offers.length === 0) console.log('    · no offers');
  }
  return listings[0] ?? null;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

try {
  await client.connect();

  if (status) {
    await report();
    process.exit(0);
  }

  if (purge) {
    // Child-first, and stopping short of the ledger. `ledger_entries` is
    // append-only by database rule (INV-7) and the transaction row is
    // referenced by it, so both survive a purge. That is not a limitation to
    // work around — a financial journal a script can erase is not a journal.
    console.log('--purge: removing the removable half of the scenario …');
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM offer_conditions WHERE offer_id IN
         (SELECT o.id FROM bank_offers o JOIN listings l ON l.id = o.listing_id
           WHERE l.transaction_id = $1)`,
      [FIX.tx],
    );
    for (const [table, column] of [
      ['bank_offers', 'listing_id'],
      ['bank_eligibility', 'listing_id'],
      ['listing_fee_obligations', 'listing_id'],
    ]) {
      await client.query(
        `DELETE FROM ${table} WHERE ${column} IN (SELECT id FROM listings WHERE transaction_id = $1)`,
        [FIX.tx],
      );
    }
    await client.query('DELETE FROM notifications WHERE transaction_id = $1', [FIX.tx]);
    await client.query('DELETE FROM listings WHERE transaction_id = $1', [FIX.tx]);
    await client.query('DELETE FROM risk_assessments WHERE transaction_id = $1', [FIX.tx]);
    await client.query(
      `DELETE FROM status_history WHERE entity_type = 'TRANSACTION' AND entity_id = $1`,
      [FIX.tx],
    );
    await client.query(
      `UPDATE receivable_transactions SET state = 'ELIGIBLE' WHERE id = $1`,
      [FIX.tx],
    );
    await client.query('COMMIT');
    console.log('  done. The transaction is back to ELIGIBLE and can be listed again.\n');
  }

  // --- the eligible transaction -------------------------------------------

  const { rows: buyers } = await client.query(
    `SELECT id FROM buyers WHERE national_establishment_no = $1`,
    [BUYER_ESTABLISHMENT],
  );
  if (buyers.length === 0) {
    throw new Error('Buyer fixture missing. Run db/tools/seed.mjs and db/seed/0300 first.');
  }

  await client.query(
    `INSERT INTO receivable_transactions
       (id, reference_number, supplier_org_id, buyer_id, state,
        minimum_acceptable_amount, created_by)
     VALUES ($1,$2,$3,$4,'ELIGIBLE',$5,$6)
     ON CONFLICT (id) DO NOTHING`,
    [FIX.tx, 'ZM-DEMO-P5-0001', AL_NOOR_ORG, buyers[0].id, FLOOR, AL_NOOR_OWNER],
  );
  await client.query(
    `INSERT INTO invoices
       (id, transaction_id, invoice_number, einvoice_identifier, issue_date, due_date,
        subtotal_amount, tax_amount, face_value, paid_amount, outstanding_amount, fingerprint)
     VALUES ($1,$2,'DEMO-P5-0001','JO-EINV-DEMO-P5-0001',
             CURRENT_DATE - 10, CURRENT_DATE + 90,
             10000.000, 1600.000, 11600.000, 0, 11600.000, $3)
     ON CONFLICT (id) DO NOTHING`,
    [FIX.invoice, FIX.tx, 'demo-scenario-phase5'],
  );

  // --- activation ----------------------------------------------------------

  const supplier = await login('owner@alnoor.zimmamless.test');

  const { rows: existing } = await client.query(
    `SELECT id FROM listings
      WHERE transaction_id = $1 AND status IN ('OPEN_FOR_OFFERS','OFFER_PERIOD_CLOSED','AWAITING_SELECTION')
      ORDER BY activated_at DESC LIMIT 1`,
    [FIX.tx],
  );

  let listingId = existing[0]?.id;
  if (listingId) {
    console.log(`Listing already open: ${listingId}`);
  } else {
    const res = await api(supplier, 'POST', `/transactions/${FIX.tx}/listing`);
    if (res.status !== 201) {
      throw new Error(`Listing activation failed (${res.status}): ${res.raw}`);
    }
    listingId = res.body.id;
    console.log(`Listing activated: ${listingId}`);
    console.log(`  offers close ${res.body.offerSubmissionDeadline}`);
    console.log(`  selection by ${res.body.supplierSelectionDeadline}`);
  }

  // --- the two approvable offers ------------------------------------------

  for (const offer of OFFERS) {
    const session = await login(offer.email);
    const res = await api(session, 'POST', `/listings/${listingId}/offers/create`, {
      ...offer.body,
      // A validity that outlives the selection window, so the offer is still
      // acceptable at any point the demo reaches it.
      validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });

    if (res.status === 201) {
      console.log(
        `${offer.bank}: offer ${res.body.id} — ${res.body.status}, net ${res.body.netSupplierPayout}`,
      );
      if (res.body.netSupplierPayout !== offer.expectedNet) {
        // Not fatal: the tier or the listing fee may legitimately have been
        // reconfigured. But the comment above claims a number, and a claim
        // that has quietly stopped being true is worse than no claim.
        console.log(
          `  NOTE: expected ${offer.expectedNet}. The comment in this file is now stale ` +
            '— check the active commission tier and the listing fee.',
        );
      }
    } else if (res.status === 409) {
      console.log(`${offer.bank}: already has a current offer on this listing — left alone.`);
    } else {
      throw new Error(`${offer.bank} offer failed (${res.status}): ${res.raw}`);
    }
  }

  console.log('\nScenario ready. What it is set up to demonstrate:\n');
  console.log('  · two offers awaiting internal approval — GET /v1/offers?status=PENDING_INTERNAL_APPROVAL');
  console.log('  · the maker\'s own approval attempt is refused (INV-12, SELF_APPROVAL_FORBIDDEN)');
  console.log('  · approver@jnb / approver@lcb approve, and the offers become ACTIVE');
  console.log('  · the supplier then sees both in full; each bank sees only its own');
  console.log(`  · the supplier's floor is ${FLOOR} and appears in no bank-facing response`);
  console.log('  · gross ranks A below B; net ranks B below A — the comparison screen\'s point');
  console.log('\nCurrent state:\n');
  await report();
} catch (err) {
  console.error(`\nFATAL: ${err.message}`);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
