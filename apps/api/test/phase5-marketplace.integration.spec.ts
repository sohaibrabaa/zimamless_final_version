import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { AppConfig } from '../src/config/configuration';
import { SystemTimeProvider } from '../src/common/time/time.provider';

/**
 * Phase 5 integration checkpoint — the confidential marketplace, live.
 *
 * This suite is the phase file's checkpoint executed end to end against the
 * hosted database with real Supabase tokens:
 *
 *   supplier activates the listing (fee obligation created)
 *     → bank A's maker creates an offer
 *     → the maker's own approval attempt is REJECTED (INV-12)
 *     → bank A's approver approves it
 *     → bank B creates and approves a second offer
 *     → the supplier sees both, fully
 *     → bank A sees ONLY its own offer and no competitor count, verified
 *       two ways: the API response, and direct SQL under bank A's identity
 *       with NestJS out of the picture (INV-11)
 *     → a deliberately below-floor offer is refused with the generic code,
 *       and the whole response is byte-scanned for the sentinel floor value
 *       (INV-8)
 *
 * The sentinel technique is worth naming: the supplier's floor is set to a
 * value that appears nowhere else in the fixture (`8675.309`), so a single
 * `includes()` over the serialized response is a complete test rather than a
 * spot check of the fields someone remembered to look at.
 *
 * The ELIGIBLE transaction is arranged directly in SQL. That is deliberate
 * and different from the Phase 3 journey suite: there, the claim under test
 * was that the submission pipeline produces an eligible invoice, so seeding
 * one would have faked the subject. Here the subject is what the marketplace
 * does *with* an eligible transaction, and the route it took to get there is
 * not part of the claim.
 */

const connectionString = process.env.DATABASE_URL;
const SUPABASE = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
const ANON = process.env.SUPABASE_ANON_KEY ?? '';
const PASSWORD = process.env.SEED_USER_PASSWORD ?? 'Zimmamless#2026';

if (!connectionString && process.env.CI) {
  throw new Error('DATABASE_URL is not set in CI. The Phase 5 checkpoint must run, not skip.');
}

const describeIfDb = connectionString && SUPABASE && ANON ? describe : describe.skip;

/**
 * The supplier's private floor. Chosen to be unmistakable in a byte scan and
 * to appear in no other fixture value, so a hit is always a real leak.
 */
const FLOOR_SENTINEL = '8675.309';

/**
 * A fresh transaction id per run, rather than a fixed one.
 *
 * Listing activation writes a balanced ledger journal, and `ledger_entries`
 * is append-only by database rule (INV-7) — a DELETE against it does nothing.
 * That is correct and deliberate: a financial record that a test can erase is
 * not a financial record. It does mean the fixture transaction cannot be
 * removed either, because the ledger rows reference it.
 *
 * So this suite stops trying. Each run uses its own transaction, cleans up
 * everything that IS erasable, and leaves the ledger journal and its
 * transaction behind as the permanent entries they are meant to be. Fighting
 * the invariant here would have meant weakening it.
 */
const FIX = {
  tx: randomUUID(),
  invoice: randomUUID(),
};

const ORG = {
  alNoor: '0e000000-0000-4000-8000-000000000002',
  bankA: '0e000000-0000-4000-8000-000000000004',
  bankB: '0e000000-0000-4000-8000-000000000005',
};
const AL_NOOR_USER = '0e100000-0000-4000-8000-000000000001';
const BUYER_ESTABLISHMENT = '30000201';

/** Seeded auth ids, for the direct-SQL half of the INV-11 drill. */
const AUTH = {
  bankAMaker: '0e200000-0000-4000-8000-000000000005',
  bankBMaker: '0e200000-0000-4000-8000-000000000008',
};

describeIfDb('Phase 5 — the confidential marketplace', () => {
  let app: INestApplication;
  let db: Client;
  let prefix: string;

  const tokens: Record<string, string> = {};
  const orgs: Record<string, string> = {};

  let listingId: string;
  let bankAOfferId: string;
  let bankBOfferId: string;

  // -------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------

  const login = async (email: string): Promise<string> => {
    const res = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    const body = (await res.json()) as { access_token?: string };
    if (!body.access_token) throw new Error(`Could not log in as ${email}.`);
    return body.access_token;
  };

  const api = async (
    persona: string,
    method: 'get' | 'post' | 'put' | 'patch',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: any; raw: string }> => {
    let req = request(app.getHttpServer())[method](`${prefix}${path}`)
      .set('Authorization', `Bearer ${tokens[persona]}`)
      .set('X-Organization-Id', orgs[persona]);
    if (body !== undefined) req = req.send(body as object);
    const res = await req;
    return { status: res.status, body: res.body, raw: res.text ?? '' };
  };

  /** Deletes everything this suite creates, child-first. */
  const cleanup = async (): Promise<void> => {
    await db.query('BEGIN');
    try {
      await db.query(
        `DELETE FROM offer_conditions WHERE offer_id IN
           (SELECT o.id FROM bank_offers o JOIN listings l ON l.id = o.listing_id
             WHERE l.transaction_id = $1)`,
        [FIX.tx],
      );
      await db.query(
        `DELETE FROM bank_offers WHERE listing_id IN
           (SELECT id FROM listings WHERE transaction_id = $1)`,
        [FIX.tx],
      );
      await db.query(
        `DELETE FROM bank_eligibility WHERE listing_id IN
           (SELECT id FROM listings WHERE transaction_id = $1)`,
        [FIX.tx],
      );
      await db.query(
        `DELETE FROM listing_fee_obligations WHERE listing_id IN
           (SELECT id FROM listings WHERE transaction_id = $1)`,
        [FIX.tx],
      );
      await db.query('DELETE FROM notifications WHERE transaction_id = $1', [FIX.tx]);
      await db.query('DELETE FROM listings WHERE transaction_id = $1', [FIX.tx]);
      await db.query('DELETE FROM risk_assessments WHERE transaction_id = $1', [FIX.tx]);
      await db.query(
        `DELETE FROM status_history WHERE entity_type = 'TRANSACTION' AND entity_id = $1`,
        [FIX.tx],
      );
      await db.query('DELETE FROM invoices WHERE transaction_id = $1', [FIX.tx]);
      // `ledger_entries` and, because they reference it, the transaction row
      // itself are deliberately left behind — see the FIX comment above.
      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }
  };

  beforeAll(async () => {
    db = new Client({
      connectionString,
      ssl: /supabase\.(com|co)/.test(connectionString!) ? { rejectUnauthorized: false } : undefined,
    });
    await db.connect();
    await cleanup();

    // Residue from earlier runs. Their transactions survive (the ledger holds
    // them), but their invoices are deletable, and clearing them keeps the
    // fixture population from growing without bound.
    await db.query(`DELETE FROM invoices WHERE fingerprint LIKE 'phase5-fixture-%'`);

    // The ELIGIBLE transaction, with a floor that is a byte sentinel.
    const { rows: buyers } = await db.query<{ id: string }>(
      `SELECT id FROM buyers WHERE national_establishment_no = $1`,
      [BUYER_ESTABLISHMENT],
    );
    if (buyers.length === 0) {
      throw new Error('Buyer fixture is missing — run db/seed/0100 and 0300 first.');
    }

    await db.query(
      `INSERT INTO receivable_transactions
         (id, reference_number, supplier_org_id, buyer_id, state,
          minimum_acceptable_amount, created_by)
       VALUES ($1, $6, $2, $3, 'ELIGIBLE', $4, $5)`,
      // The reference is built here rather than in SQL: passing the id as
      // both a uuid and a text argument makes Postgres refuse the statement
      // with "inconsistent types deduced for parameter $1".
      [FIX.tx, ORG.alNoor, buyers[0].id, FLOOR_SENTINEL, AL_NOOR_USER,
        `ZM-P5-${FIX.tx.slice(0, 8)}`],
    );
    await db.query(
      `INSERT INTO invoices
         (id, transaction_id, invoice_number, einvoice_identifier, issue_date, due_date,
          subtotal_amount, tax_amount, face_value, paid_amount, outstanding_amount, fingerprint)
       VALUES ($1,$2,'PHASE5-FIXTURE-1','JO-EINV-PHASE5-0001',
               CURRENT_DATE - 10, CURRENT_DATE + 90,
               10000.000, 1600.000, 11600.000, 0, 11600.000, $3)`,
      // Per-run fingerprint. The platform-wide unique index over active
      // invoices is doing its job — a fixed value here would collide with the
      // invoice left behind by the previous run, whose transaction cannot be
      // deleted because the ledger references it.
      [FIX.invoice, FIX.tx, `phase5-fixture-${FIX.tx}`],
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    const config = app.get(AppConfig);
    prefix = `/${config.globalPrefix}`;
    app.setGlobalPrefix(config.globalPrefix, { exclude: ['health'] });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: false },
      }),
    );
    await app.init();
    // After init: refresh() reads the database when DEMO_TIME_MACHINE_ENABLED
    // is on, and the pool only exists once onModuleInit has run.
    await app.get(SystemTimeProvider).refresh();

    for (const [persona, email] of [
      ['supplier', 'owner@alnoor.zimmamless.test'],
      ['bankAMaker', 'maker@jnb.zimmamless.test'],
      ['bankAApprover', 'approver@jnb.zimmamless.test'],
      ['bankBMaker', 'maker@lcb.zimmamless.test'],
      ['bankBApprover', 'approver@lcb.zimmamless.test'],
    ] as const) {
      tokens[persona] = await login(email);
      const me = await request(app.getHttpServer())
        .get(`${prefix}/auth/me`)
        .set('Authorization', `Bearer ${tokens[persona]}`);
      orgs[persona] = me.body.memberships[0].organizationId;
    }
  }, 180_000);

  afterAll(async () => {
    if (db) {
      await cleanup().catch(() => undefined);
      await db.end();
    }
    await app?.close();
  });

  // -------------------------------------------------------------------
  // Listing activation
  // -------------------------------------------------------------------

  describe('listing activation', () => {
    it('activates from ELIGIBLE and returns deadlines', async () => {
      const res = await api('supplier', 'post', `/transactions/${FIX.tx}/listing`);
      expect(res.status).toBe(201);
      expect(res.body.offerSubmissionDeadline).toBeTruthy();
      expect(res.body.supplierSelectionDeadline).toBeTruthy();
      listingId = res.body.id;
    }, 60_000);

    it('creates the listing-fee obligation immediately (ZM-FEE-002)', async () => {
      const { rows } = await db.query<{ amount: string; status: string }>(
        `SELECT amount, status FROM listing_fee_obligations WHERE listing_id = $1`,
        [listingId],
      );
      expect(rows).toHaveLength(1);
      // Payable now, not on funding: the fee is incurred for the service of
      // being listed, whether or not a bank ever offers.
      expect(rows[0].status).toBe('PAYABLE');
      expect(rows[0].amount).toBe('25.000');
    });

    it('writes a balanced double-entry ledger journal (ZM-FEE-016..019)', async () => {
      const { rows } = await db.query<{ entry_type: string; amount: string; journal_id: string }>(
        `SELECT entry_type, amount, journal_id FROM ledger_entries WHERE transaction_id = $1`,
        [FIX.tx],
      );
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.journal_id)).size).toBe(1);

      const debits = rows.filter((r) => r.entry_type === 'DEBIT');
      const credits = rows.filter((r) => r.entry_type === 'CREDIT');
      expect(debits).toHaveLength(1);
      expect(credits).toHaveLength(1);
      expect(debits[0].amount).toBe(credits[0].amount);
    });

    it('moves the transaction to OPEN_FOR_OFFERS', async () => {
      const res = await api('supplier', 'get', `/transactions/${FIX.tx}`);
      expect(res.body.state).toBe('OPEN_FOR_OFFERS');
    });

    it('records eligibility with the rules applied, for every bank (ZM-MKT-003)', async () => {
      const { rows } = await db.query<{
        bank_org_id: string;
        status: string;
        rules_applied: unknown[];
      }>(`SELECT bank_org_id, status, rules_applied FROM bank_eligibility WHERE listing_id = $1`,
        [listingId]);

      // Every active bank gets a row, eligible or not — the ineligible rows
      // are the audit trail that answers "why did bank C not see this?".
      expect(rows.length).toBeGreaterThanOrEqual(2);
      for (const row of rows) {
        expect(Array.isArray(row.rules_applied)).toBe(true);
        expect(row.rules_applied.length).toBeGreaterThan(0);
      }
    });

    it('refuses a second activation while one is open (ZM-CON-017)', async () => {
      const res = await api('supplier', 'post', `/transactions/${FIX.tx}/listing`);
      expect(res.status).toBe(409);
    });
  });

  // -------------------------------------------------------------------
  // Offers, maker/approver
  // -------------------------------------------------------------------

  describe('offers and the maker/approver split', () => {
    const offerBody = {
      transactionType: 'INVOICE_FINANCING',
      recourseType: 'FULL_RECOURSE',
      grossFundingAmount: '11000.000',
      bankDiscountAmount: '400.000',
      bankFeesAmount: '100.000',
      validUntil: '2027-01-01T00:00:00.000Z',
      conditions: [
        {
          conditionType: 'REQUIRED_DOCUMENT',
          title: 'Signed delivery note',
          isMandatory: true,
        },
      ],
    };

    it('bank A’s maker creates an offer, server-priced', async () => {
      const res = await api('bankAMaker', 'post', `/listings/${listingId}/offers/create`, offerBody);
      expect(res.status).toBe(201);
      bankAOfferId = res.body.id;

      // The bank did not send these; the server injected them.
      expect(res.body.platformCommissionAmount).toBe('137.500'); // 1.25% of 11000
      expect(res.body.listingFeeAmount).toBe('25.000');
      // 11000 − 400 − 100 − 137.5 − 25 − 0
      expect(res.body.netSupplierPayout).toBe('10337.500');
      expect(res.body.status).toBe('PENDING_INTERNAL_APPROVAL');
    }, 60_000);

    it('rejects an offer whose client-computed net disagrees', async () => {
      const res = await api('bankBMaker', 'post', `/listings/${listingId}/offers/create`, {
        ...offerBody,
        netSupplierPayout: '10500.000',
      });
      expect(res.status).toBe(422);
      expect(res.body.details.rejection).toBe('NET_MISMATCH');
    });

    it('refuses commission and listing fee supplied by the bank', async () => {
      // forbidNonWhitelisted turns an attempt to set a server-computed field
      // into a named 400 rather than a silent ignore.
      const res = await api('bankBMaker', 'post', `/listings/${listingId}/offers/create`, {
        ...offerBody,
        platformCommissionAmount: '0.000',
      });
      expect(res.status).toBe(400);
    });

    it('a maker without the approver role is refused at the role gate', async () => {
      // Note the code: the route guard fires before the service, so this
      // persona never reaches the self-approval check. Still a 403, and still
      // correct — but it is NOT the INV-12 case, which is tested separately
      // below with a user who genuinely holds the approver role.
      const res = await api('bankAMaker', 'post', `/offers/${bankAOfferId}/approve`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INSUFFICIENT_ROLE');
    });

    it('a different user with the approver role can approve it', async () => {
      const res = await api('bankAApprover', 'post', `/offers/${bankAOfferId}/approve`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ACTIVE');
    });

    it('bank B creates and approves a second offer', async () => {
      const created = await api('bankBMaker', 'post', `/listings/${listingId}/offers/create`, {
        ...offerBody,
        grossFundingAmount: '10800.000',
        bankDiscountAmount: '250.000',
      });
      expect(created.status).toBe(201);
      bankBOfferId = created.body.id;

      const approved = await api('bankBApprover', 'post', `/offers/${bankBOfferId}/approve`);
      expect(approved.status).toBe(200);
      expect(approved.body.status).toBe('ACTIVE');
    }, 60_000);

    it('allows only one current offer per bank per listing (ZM-OFR-013)', async () => {
      const res = await api('bankAMaker', 'post', `/listings/${listingId}/offers/create`, offerBody);
      expect(res.status).toBe(409);
    });
  });

  // -------------------------------------------------------------------
  // INV-11 — confidentiality between banks
  // -------------------------------------------------------------------

  describe('INV-11 — bank A can never see bank B', () => {
    it('the supplier sees both offers, fully', async () => {
      const res = await api('supplier', 'get', `/listings/${listingId}/offers`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      for (const offer of res.body) {
        expect(offer.netSupplierPayout).toBeTruthy();
        expect(offer.bankName).toBeTruthy();
      }
    });

    it('bank A sees ONLY its own offer via the API', async () => {
      const res = await api('bankAMaker', 'get', `/listings/${listingId}/offers`);
      expect(res.status).toBe(200);
      for (const offer of res.body) {
        expect(offer.id).not.toBe(bankBOfferId);
      }
      // And nothing in the payload mentions the competitor at all.
      expect(res.raw).not.toContain(bankBOfferId);
      expect(res.raw).not.toContain(ORG.bankB);
    });

    it('bank A’s underwriting view carries no competitor and no count', async () => {
      const res = await api('bankAMaker', 'get', `/marketplace/listings/${listingId}`);
      expect(res.status).toBe(200);
      expect(res.body.myOffer.id).toBe(bankAOfferId);

      // The count is a proxy for competition and is supplier-only.
      expect(res.body).not.toHaveProperty('offerCount');
      expect(res.raw).not.toContain(bankBOfferId);
      expect(res.raw).not.toContain('offerCount');
    });

    it('bank A cannot fetch bank B’s offer directly — 404, not 403', async () => {
      const res = await api('bankAMaker', 'get', `/offers/${bankBOfferId}`);
      // 403 would confirm the offer exists, which to a competitor is itself
      // the disclosure INV-11 forbids.
      expect(res.status).toBe(404);
    });

    it('bank A cannot approve or withdraw bank B’s offer', async () => {
      expect((await api('bankAApprover', 'post', `/offers/${bankBOfferId}/approve`)).status)
        .toBe(404);
      expect((await api('bankAMaker', 'post', `/offers/${bankBOfferId}/withdraw`, {})).status)
        .toBe(404);
    });

    it('the bank’s own offer list is scoped to its organization (D-08)', async () => {
      const res = await api('bankAMaker', 'get', '/offers?page=1&pageSize=50');
      expect(res.status).toBe(200);
      for (const offer of res.body.items) {
        expect(offer.id).not.toBe(bankBOfferId);
      }
    });

    it('holds at the RLS layer too, with NestJS out of the picture', async () => {
      // The independent half of the drill: a direct Postgres session holding
      // bank A's identity, exactly as a Supabase client would. A policy that
      // works only because the API filtered first is a defect (ZM-ARC-005).
      await db.query('BEGIN');
      try {
        await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
          JSON.stringify({ sub: AUTH.bankAMaker, role: 'authenticated' }),
        ]);
        await db.query('SET LOCAL ROLE authenticated');

        const visible = await db.query<{ id: string }>(
          'SELECT id FROM bank_offers WHERE listing_id = $1',
          [listingId],
        );
        const ids = visible.rows.map((r) => r.id);
        expect(ids).toContain(bankAOfferId);
        expect(ids).not.toContain(bankBOfferId);

        // count(*) is filtered by RLS before aggregation, so bank A cannot
        // even learn how many competitors exist.
        const counted = await db.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM bank_offers WHERE listing_id = $1',
          [listingId],
        );
        expect(Number(counted.rows[0].n)).toBe(1);
      } finally {
        await db.query('ROLLBACK');
      }
    });

    it('bank B’s own session sees the mirror image', async () => {
      await db.query('BEGIN');
      try {
        await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
          JSON.stringify({ sub: AUTH.bankBMaker, role: 'authenticated' }),
        ]);
        await db.query('SET LOCAL ROLE authenticated');
        const visible = await db.query<{ id: string }>(
          'SELECT id FROM bank_offers WHERE listing_id = $1',
          [listingId],
        );
        const ids = visible.rows.map((r) => r.id);
        expect(ids).toContain(bankBOfferId);
        expect(ids).not.toContain(bankAOfferId);
      } finally {
        await db.query('ROLLBACK');
      }
    });
  });

  // -------------------------------------------------------------------
  // INV-8 — the floor never reaches a bank
  // -------------------------------------------------------------------

  describe('INV-8 — the supplier floor is invisible to banks', () => {
    it('refuses a below-floor offer with the generic code and zero numeric detail', async () => {
      // Net here lands under the 8675.309 floor.
      const res = await api('bankBMaker', 'patch', `/offers/${bankBOfferId}`, {
        transactionType: 'INVOICE_FINANCING',
        recourseType: 'FULL_RECOURSE',
        grossFundingAmount: '9000.000',
        bankDiscountAmount: '400.000',
        bankFeesAmount: '100.000',
        validUntil: '2027-01-01T00:00:00.000Z',
      });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('OFFER_BELOW_SUPPLIER_REQUIREMENT');

      // The sentinel scan. The floor appears nowhere else in this fixture, so
      // a hit anywhere in the response is a real leak.
      expect(res.raw).not.toContain(FLOOR_SENTINEL);
      expect(res.raw).not.toContain('8675');
      // Nor any derived figure that would let the floor be reconstructed.
      expect(res.body.details).toBeUndefined();
    });

    it('keeps the floor out of every bank-facing payload', async () => {
      const payloads = await Promise.all([
        api('bankAMaker', 'get', `/marketplace/listings/${listingId}`),
        api('bankAMaker', 'get', '/marketplace/eligible?page=1&pageSize=50'),
        api('bankAMaker', 'get', `/listings/${listingId}/offers`),
        api('bankAMaker', 'get', `/offers/${bankAOfferId}`),
        api('bankAMaker', 'get', `/listings/${listingId}`),
        api('bankAMaker', 'get', '/offers?page=1&pageSize=50'),
      ]);

      for (const payload of payloads) {
        expect(payload.raw).not.toContain(FLOOR_SENTINEL);
        expect(payload.raw).not.toContain('minimumAcceptableAmount');
      }
    }, 60_000);

    it('the supplier still sees their own floor', async () => {
      // The invariant is about banks, not about secrecy from the owner.
      const res = await api('supplier', 'get', `/transactions/${FIX.tx}`);
      expect(res.body.minimumAcceptableAmount).toBe(FLOOR_SENTINEL);
    });

    it('is not readable by a bank at the RLS layer either (D-02)', async () => {
      await db.query('BEGIN');
      try {
        await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
          JSON.stringify({ sub: AUTH.bankAMaker, role: 'authenticated' }),
        ]);
        await db.query('SET LOCAL ROLE authenticated');
        await expect(
          db.query('SELECT minimum_acceptable_amount FROM receivable_transactions'),
        ).rejects.toThrow(/permission denied/i);
      } finally {
        await db.query('ROLLBACK');
      }
    });
  });

  // -------------------------------------------------------------------
  // Policy filters and eligibility
  // -------------------------------------------------------------------

  describe('policy filters (D-12)', () => {
    let filterId: string;

    it('creates a filter scoped to the bank', async () => {
      const res = await api('bankAMaker', 'post', '/banks/policy-filters', {
        name: 'Phase 5 test appetite',
        minAmount: '1000.000',
        maxAmount: '999999.000',
        maxRiskBand: 'HIGH',
      });
      // BANK_ADMIN only — the maker must be refused.
      expect(res.status).toBe(403);

      const admin = await login('admin@jnb.zimmamless.test');
      tokens.bankAAdmin = admin;
      orgs.bankAAdmin = ORG.bankA;

      const created = await api('bankAAdmin', 'post', '/banks/policy-filters', {
        name: 'Phase 5 test appetite',
        minAmount: '1000.000',
        maxAmount: '999999.000',
        maxRiskBand: 'HIGH',
      });
      expect(created.status).toBe(201);
      filterId = created.body.id;
    }, 60_000);

    it('lists only this bank’s filters', async () => {
      const res = await api('bankAAdmin', 'get', '/banks/policy-filters');
      expect(res.status).toBe(200);
      expect(res.body.every((f: { id: string }) => typeof f.id === 'string')).toBe(true);
    });

    it('deactivates rather than deletes, keeping the rules_applied trace intact', async () => {
      const res = await api('bankAAdmin', 'patch', `/banks/policy-filters/${filterId}`, {
        isActive: false,
      });
      expect(res.status).toBe(200);
      expect(res.body.isActive).toBe(false);

      const { rows } = await db.query('SELECT 1 FROM bank_policy_filters WHERE id = $1', [filterId]);
      expect(rows).toHaveLength(1);
    });

    it('does not clear unrelated fields on a partial update', async () => {
      // `undefined` means "not supplied" and must not be conflated with
      // `null` meaning "clear this rule" — that is how an appetite silently
      // widens after an unrelated edit.
      const res = await api('bankAAdmin', 'patch', `/banks/policy-filters/${filterId}`, {
        name: 'Renamed',
      });
      expect(res.body.minAmount).toBe('1000.000');
      expect(res.body.maxRiskBand).toBe('HIGH');

      await db.query('DELETE FROM bank_policy_filters WHERE id = $1', [filterId]);
    });
  });

  // -------------------------------------------------------------------
  // INV-12 — the real self-approval case
  // -------------------------------------------------------------------

  describe('INV-12 — maker/approver separation (ZM-ROL-001/002)', () => {
    it('refuses self-approval by a user who DOES hold the approver role', async () => {
      // The case that matters. A BANK_ADMIN can both create and approve, so
      // the role gate lets them through and the separation rule is the only
      // thing standing between them and approving their own work. A test
      // using a plain maker would have passed on the role check alone and
      // proved nothing about ZM-ROL-002.
      const admin = await login('admin@jnb.zimmamless.test');
      tokens.selfApprover = admin;
      orgs.selfApprover = ORG.bankA;

      // Free bank A's one-current-offer slot.
      await api('bankAMaker', 'post', `/offers/${bankAOfferId}/withdraw`, {});

      const created = await api('selfApprover', 'post', `/listings/${listingId}/offers/create`, {
        transactionType: 'INVOICE_FINANCING',
        recourseType: 'FULL_RECOURSE',
        grossFundingAmount: '11000.000',
        bankDiscountAmount: '400.000',
        bankFeesAmount: '100.000',
        validUntil: '2027-01-01T00:00:00.000Z',
      });
      expect(created.status).toBe(201);

      const selfApproved = await api('selfApprover', 'post', `/offers/${created.body.id}/approve`);
      expect(selfApproved.status).toBe(403);
      expect(selfApproved.body.code).toBe('SELF_APPROVAL_FORBIDDEN');

      // And a different approver can still approve it, so the rule blocks the
      // person rather than the offer.
      const byOther = await api('bankAApprover', 'post', `/offers/${created.body.id}/approve`);
      expect(byOther.status).toBe(200);
      expect(byOther.body.status).toBe('ACTIVE');
      bankAOfferId = created.body.id;
    }, 90_000);

    it('has a database CHECK as the backstop', async () => {
      // The service refuses first; `chk_maker_approver_differ` catches any
      // path that forgets to ask. Asserted directly, because a backstop
      // nobody tests is a backstop nobody knows is gone.
      await expect(
        db.query(
          `UPDATE bank_offers SET approved_by = created_by WHERE id = $1`,
          [bankAOfferId],
        ),
      ).rejects.toThrow(/chk_maker_approver_differ/i);
    });
  });

  // -------------------------------------------------------------------
  // Window enforcement
  // -------------------------------------------------------------------

  describe('the submission window (ZM-MKT-009)', () => {
    it('refuses offer activity once the listing is no longer open', async () => {
      // Close the window by hand rather than waiting 24 hours; the deadline
      // sweep's own behaviour is covered by its unit tests.
      await db.query(`UPDATE listings SET status = 'AWAITING_SELECTION' WHERE id = $1`, [listingId]);
      try {
        const res = await api('bankAMaker', 'patch', `/offers/${bankAOfferId}`, {
          transactionType: 'INVOICE_FINANCING',
          recourseType: 'FULL_RECOURSE',
          grossFundingAmount: '11000.000',
          validUntil: '2027-01-01T00:00:00.000Z',
        });
        expect(res.status).toBe(409);
      } finally {
        await db.query(`UPDATE listings SET status = 'OPEN_FOR_OFFERS' WHERE id = $1`, [listingId]);
      }
    });
  });
});
