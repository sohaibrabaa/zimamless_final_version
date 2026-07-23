import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { AppConfig } from '../src/config/configuration';
import { SystemTimeProvider } from '../src/common/time/time.provider';

/**
 * Phase 6 integration checkpoint — selection and contracts, live.
 *
 * The phase file's checkpoint, end to end against the hosted database:
 *
 *   the supplier accepts the LOWER of two offers — proving there is no
 *   best-offer logic anywhere — → the other bank flips to NOT_SELECTED and is
 *   notified without learning anything else → **the concurrency harness: two
 *   parallel accepts on different offers, repeated, every run producing
 *   exactly one 200 and one 409, one SELECTED offer and one snapshot** → both
 *   signatories sign → the contract is FULLY_SIGNED with a hash → the
 *   transaction is CONTRACTED.
 *
 * ## Why the concurrency block is the important one
 *
 * Everything else here would pass against an implementation that checks
 * `locked_at IS NULL` and then updates — the classic read-then-write race
 * that looks correct in every single-threaded test ever written. Only firing
 * two accepts at the same instant, repeatedly, distinguishes that from a
 * `SELECT … FOR UPDATE`. The harness runs its iterations against genuinely
 * separate fixtures so a failure is unambiguous, and asserts on the database
 * afterwards rather than only on the HTTP statuses: one SELECTED offer, one
 * NOT_SELECTED, one selection row, one snapshot.
 *
 * As in Phase 5, the ELIGIBLE transaction and its listing are arranged in
 * SQL. What is under test is what acceptance does, not how the receivable
 * became eligible.
 */

const connectionString = process.env.DATABASE_URL;
const SUPABASE = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
const ANON = process.env.SUPABASE_ANON_KEY ?? '';
const PASSWORD = process.env.SEED_USER_PASSWORD ?? 'Zimmamless#2026';

if (!connectionString && process.env.CI) {
  throw new Error('DATABASE_URL is not set in CI. The Phase 6 checkpoint must run, not skip.');
}

const describeIfDb = connectionString && SUPABASE && ANON ? describe : describe.skip;

const ORG = {
  alNoor: '0e000000-0000-4000-8000-000000000002',
  bankA: '0e000000-0000-4000-8000-000000000004',
  bankB: '0e000000-0000-4000-8000-000000000005',
};
const AL_NOOR_OWNER = '0e100000-0000-4000-8000-000000000001';
const BUYER_ESTABLISHMENT = '30000201';

/** How many times the concurrency harness fires two simultaneous accepts. */
const CONCURRENCY_ITERATIONS = Number(process.env.ZM_ACCEPT_ITERATIONS ?? '8');

interface Fixture {
  transactionId: string;
  invoiceId: string;
  listingId: string;
  offerA: string;
  offerB: string;
}

describeIfDb('Phase 6 — selection and contracts', () => {
  let app: INestApplication;
  let db: Client;
  let prefix: string;

  const tokens: Record<string, string> = {};
  const orgs: Record<string, string> = {};
  const created: Fixture[] = [];

  let main: Fixture;
  let contractId: string;

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

  const api = (
    persona: string,
    method: 'get' | 'post' | 'patch',
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): request.Test => {
    const req = request(app.getHttpServer())[method](`${prefix}${path}`)
      .set('Authorization', `Bearer ${tokens[persona]}`)
      .set('X-Organization-Id', orgs[persona]);
    // Money/state-changing POSTs now require an Idempotency-Key (contract
    // global rule 4). A fresh uuid per call keeps every existing test a
    // distinct logical request — the concurrency harness fires genuinely
    // independent accepts, not accidental replays — while a caller that wants
    // to exercise replay passes an explicit key.
    if (method === 'post') req.set('Idempotency-Key', idempotencyKey ?? randomUUID());
    return body === undefined ? req : req.send(body as object);
  };

  /**
   * A complete OPEN_FOR_OFFERS listing with two ACTIVE offers.
   *
   * Bank A's offer nets LESS than bank B's — deliberately, so that the
   * checkpoint's "accept the lower offer" is a real choice and not a
   * coincidence of which fixture happens to be first.
   */
  const buildFixture = async (options: {
    conditions?: { title: string; mandatory: boolean }[];
  } = {}): Promise<Fixture> => {
    const fixture: Fixture = {
      transactionId: randomUUID(),
      invoiceId: randomUUID(),
      listingId: randomUUID(),
      offerA: randomUUID(),
      offerB: randomUUID(),
    };

    const { rows: buyers } = await db.query<{ id: string }>(
      `SELECT id FROM buyers WHERE national_establishment_no = $1`,
      [BUYER_ESTABLISHMENT],
    );
    if (buyers.length === 0) throw new Error('Buyer fixture missing — run db:seed and 0300.');

    await db.query(
      `INSERT INTO receivable_transactions
         (id, reference_number, supplier_org_id, buyer_id, state, minimum_acceptable_amount, created_by)
       VALUES ($1,$2,$3,$4,'OPEN_FOR_OFFERS','5000.000',$5)`,
      [
        fixture.transactionId,
        `ZM-P6-${fixture.transactionId.slice(0, 8)}`,
        ORG.alNoor,
        buyers[0].id,
        AL_NOOR_OWNER,
      ],
    );
    await db.query(
      `INSERT INTO invoices
         (id, transaction_id, invoice_number, einvoice_identifier, issue_date, due_date,
          subtotal_amount, tax_amount, face_value, paid_amount, outstanding_amount, fingerprint)
       VALUES ($1,$2,$3,$4, CURRENT_DATE - 10, CURRENT_DATE + 90,
               10000.000, 1600.000, 11600.000, 0, 11600.000, $5)`,
      [
        fixture.invoiceId,
        fixture.transactionId,
        `PHASE6-${fixture.transactionId.slice(0, 8)}`,
        `JO-EINV-P6-${fixture.transactionId.slice(0, 8)}`,
        `phase6-fixture-${fixture.transactionId}`,
      ],
    );
    // Declarations affirmed, so the ZM-CON-006 check has something real to
    // read rather than an absence that would pass by accident. The table is
    // one row of booleans keyed on the transaction, not a row per key.
    await db.query(
      `INSERT INTO invoice_declarations
         (transaction_id, declaration_template_version, is_authentic, goods_delivered,
          unpaid_and_not_cancelled, no_known_dispute, not_previously_financed,
          buyer_is_named_entity, contact_is_buyer_rep, accepts_recourse, declared_by)
       VALUES ($1,'v1.0',true,true,true,true,true,true,true,true,$2)`,
      [fixture.transactionId, AL_NOOR_OWNER],
    );

    await db.query(
      `INSERT INTO listings
         (id, transaction_id, round_number, status, activated_at,
          offer_submission_deadline, supplier_selection_deadline, activated_by)
       VALUES ($1,$2,1,'OPEN_FOR_OFFERS', now(), now() + interval '1 day',
               now() + interval '2 days', $3)`,
      [fixture.listingId, fixture.transactionId, AL_NOOR_OWNER],
    );
    for (const bankOrg of [ORG.bankA, ORG.bankB]) {
      await db.query(
        `INSERT INTO bank_eligibility (listing_id, bank_org_id, status, reason, rules_applied)
         VALUES ($1,$2,'ELIGIBLE','fixture','[]'::jsonb)`,
        [fixture.listingId, bankOrg],
      );
    }
    await db.query(
      `INSERT INTO listing_fee_obligations (listing_id, supplier_org_id, amount, status)
       VALUES ($1,$2,25.000,'PAYABLE')`,
      [fixture.listingId, ORG.alNoor],
    );

    // A: gross 9000, net 8390 (the LOWER net). B: gross 9200, net 8437.
    const offers: [string, string, string, string, string, string][] = [
      [fixture.offerA, ORG.bankA, '9000.000', '300.000', '150.000', '8390.000'],
      [fixture.offerB, ORG.bankB, '9200.000', '400.000', '200.000', '8437.000'],
    ];
    for (const [id, bankOrg, gross, discount, fees, net] of offers) {
      const commission = bankOrg === ORG.bankA ? '135.000' : '138.000';
      await db.query(
        `INSERT INTO bank_offers
           (id, listing_id, bank_org_id, status, version_number, transaction_type, recourse_type,
            gross_funding_amount, bank_discount_amount, bank_fees_amount,
            platform_commission_amount, listing_fee_amount, other_deductions_amount,
            net_supplier_payout, valid_until, created_by, approved_by, approved_at, submitted_at)
         VALUES ($1,$2,$3,'ACTIVE',1,'INVOICE_FINANCING','FULL_RECOURSE',
                 $4,$5,$6,$7,25.000,0.000,$8, now() + interval '30 days',
                 $9,$10, now(), now())`,
        [
          id,
          fixture.listingId,
          bankOrg,
          gross,
          discount,
          fees,
          commission,
          net,
          // maker and approver differ — chk_maker_approver_differ is real.
          bankOrg === ORG.bankA
            ? '0e100000-0000-4000-8000-000000000005'
            : '0e100000-0000-4000-8000-000000000008',
          bankOrg === ORG.bankA
            ? '0e100000-0000-4000-8000-000000000006'
            : '0e100000-0000-4000-8000-000000000009',
        ],
      );
    }

    for (const [index, condition] of (options.conditions ?? []).entries()) {
      await db.query(
        `INSERT INTO offer_conditions
           (offer_id, condition_type, title, description, is_mandatory, display_order)
         VALUES ($1,'REQUIRED_DOCUMENT',$2,'Fixture condition',$3,$4)`,
        [fixture.offerA, condition.title, condition.mandatory, index],
      );
    }

    created.push(fixture);
    return fixture;
  };

  /**
   * Removes what can be removed.
   *
   * `ledger_entries` is append-only (INV-7) and nothing here writes to it —
   * Phase 6 creates no journal — so unlike the Phase 5 suite these fixtures
   * are fully deletable. Contracts and signatures come out first, then the
   * documents they point at.
   */
  const cleanup = async (): Promise<void> => {
    for (const fixture of created) {
      await db.query('BEGIN');
      try {
        await db.query(
          `DELETE FROM contract_signatures WHERE contract_id IN
             (SELECT id FROM contracts WHERE transaction_id = $1)`,
          [fixture.transactionId],
        );
        await db.query('DELETE FROM contracts WHERE transaction_id = $1', [fixture.transactionId]);
        await db.query(
          `DELETE FROM documents WHERE subject_type = 'TRANSACTION' AND subject_id = $1`,
          [fixture.transactionId],
        );
        await db.query(
          `DELETE FROM accepted_offer_snapshots WHERE transaction_id = $1`,
          [fixture.transactionId],
        );
        await db.query(
          `DELETE FROM offer_selections WHERE listing_id = $1`,
          [fixture.listingId],
        );
        await db.query(
          `DELETE FROM offer_conditions WHERE offer_id IN
             (SELECT id FROM bank_offers WHERE listing_id = $1)`,
          [fixture.listingId],
        );
        await db.query('DELETE FROM bank_offers WHERE listing_id = $1', [fixture.listingId]);
        await db.query('DELETE FROM bank_eligibility WHERE listing_id = $1', [fixture.listingId]);
        await db.query('DELETE FROM listing_fee_obligations WHERE listing_id = $1', [
          fixture.listingId,
        ]);
        await db.query('DELETE FROM notifications WHERE transaction_id = $1', [
          fixture.transactionId,
        ]);
        await db.query('DELETE FROM listings WHERE id = $1', [fixture.listingId]);
        await db.query(
          `DELETE FROM status_history WHERE entity_type = 'TRANSACTION' AND entity_id = $1`,
          [fixture.transactionId],
        );
        await db.query('DELETE FROM invoice_declarations WHERE transaction_id = $1', [
          fixture.transactionId,
        ]);
        await db.query('DELETE FROM invoices WHERE transaction_id = $1', [fixture.transactionId]);
        // INV-4's trigger refuses to clear locked_at, so an accepted fixture
        // cannot be "unlocked" before deletion. It does not need to be:
        // deleting the row is not an UPDATE, and the trigger is BEFORE UPDATE.
        await db.query('DELETE FROM receivable_transactions WHERE id = $1', [
          fixture.transactionId,
        ]);
        await db.query('COMMIT');
      } catch {
        await db.query('ROLLBACK');
      }
    }
    created.length = 0;
  };

  beforeAll(async () => {
    db = new Client({
      connectionString,
      ssl: /supabase\.(com|co)/.test(connectionString!) ? { rejectUnauthorized: false } : undefined,
    });
    await db.connect();

    // Residue from an interrupted earlier run.
    await db.query(`DELETE FROM invoices WHERE fingerprint LIKE 'phase6-fixture-%'`);

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
    await app.get(SystemTimeProvider).refresh();
    await app.init();

    for (const [persona, email, expectedOrg] of [
      ['supplier', 'owner@alnoor.zimmamless.test', ORG.alNoor],
      ['uploader', 'uploader@alnoor.zimmamless.test', ORG.alNoor],
      ['bankAMaker', 'maker@jnb.zimmamless.test', ORG.bankA],
      ['bankAApprover', 'approver@jnb.zimmamless.test', ORG.bankA],
      ['bankBMaker', 'maker@lcb.zimmamless.test', ORG.bankB],
    ] as const) {
      tokens[persona] = await login(email);
      const me = await request(app.getHttpServer())
        .get(`${prefix}/auth/me`)
        .set('Authorization', `Bearer ${tokens[persona]}`);

      // The fixture's eligibility and offer rows are written against the
      // canonical seeded organization ids, so the header must name the same
      // organization. Taking `memberships[0]` would be ordering-dependent —
      // and the hosted database currently carries duplicate bank
      // organizations from repeated seed runs (see the daily log), which is
      // exactly the condition that makes "the first membership" wrong.
      const membership = (
        me.body.memberships as { organizationId: string }[]
      ).find((m) => m.organizationId === expectedOrg);
      if (!membership) {
        throw new Error(
          `${email} has no membership in the canonical organization ${expectedOrg}. ` +
            'Re-run db:seed.',
        );
      }
      orgs[persona] = membership.organizationId;
    }

    main = await buildFixture();
  }, 240_000);

  // Generous: the concurrency harness leaves a dozen fixtures behind and each
  // one is a fifteen-statement teardown against a hosted pooler.
  afterAll(async () => {
    if (db) {
      await cleanup().catch(() => undefined);
      await db.end();
    }
    await app?.close();
  }, 300_000);

  // -------------------------------------------------------------------
  // ZM-SEL-005/006 — the supplier chooses, and may choose the lower offer
  // -------------------------------------------------------------------

  describe('acceptance', () => {
    it('refuses a role the AS-01 setting does not permit', async () => {
      // SUPPLIER_UPLOADER is admitted by the route guard precisely so the
      // setting can widen to it — and refused by the service because the
      // setting currently does not.
      const res = await api('uploader', 'post', `/offers/${main.offerA}/accept`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INSUFFICIENT_ROLE');
    }, 30_000);

    it('accepts the LOWER of the two offers (ZM-SEL-005/006)', async () => {
      // Bank A nets 8390.000; bank B nets 8437.000. The supplier takes A.
      // If any "best offer" logic existed anywhere, this is where it would
      // surface — as a nudge, a default, or a refusal.
      const res = await api('supplier', 'post', `/offers/${main.offerA}/accept`);
      expect(res.status).toBe(200);
      expect(res.body.netSupplierPayout).toBe('8390.000');
      expect(res.body.snapshotHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(res.body.capturedAt).toBeTruthy();
    }, 60_000);

    it('locks the transaction and moves it to OFFER_ACCEPTED (INV-4)', async () => {
      const { rows } = await db.query<{
        state: string;
        locked_at: Date | null;
        locked_by_offer_id: string | null;
      }>(
        `SELECT state, locked_at, locked_by_offer_id FROM receivable_transactions WHERE id = $1`,
        [main.transactionId],
      );
      expect(rows[0].state).toBe('OFFER_ACCEPTED');
      expect(rows[0].locked_at).not.toBeNull();
      expect(rows[0].locked_by_offer_id).toBe(main.offerA);
    });

    it('marks the other offer NOT_SELECTED and closes the listing', async () => {
      const { rows } = await db.query<{ id: string; status: string }>(
        `SELECT id, status FROM bank_offers WHERE listing_id = $1 ORDER BY status`,
        [main.listingId],
      );
      expect(rows.find((r) => r.id === main.offerA)?.status).toBe('SELECTED');
      expect(rows.find((r) => r.id === main.offerB)?.status).toBe('NOT_SELECTED');

      const { rows: listing } = await db.query<{ status: string }>(
        `SELECT status FROM listings WHERE id = $1`,
        [main.listingId],
      );
      expect(listing[0].status).toBe('OFFER_SELECTED');
    });

    it('tells the losing bank nothing but that it was not selected', async () => {
      const { rows } = await db.query<{ body: string; subject: string }>(
        `SELECT n.body, n.subject FROM notifications n
           JOIN organization_memberships m ON m.user_id = n.recipient_user_id
          WHERE n.transaction_id = $1 AND n.template_key = 'OFFER_NOT_SELECTED'
            AND m.organization_id = $2
          LIMIT 1`,
        [main.transactionId, ORG.bankB],
      );
      expect(rows.length).toBeGreaterThan(0);
      // No winning amount, no margin, no competitor count, no bank name.
      for (const forbidden of ['8390', '9000', 'Jordan National', 'two offers', 'second']) {
        expect(rows[0].body).not.toContain(forbidden);
      }
    });

    it('writes the snapshot with every ZM-SEL-007 field', async () => {
      const { rows } = await db.query<Record<string, unknown>>(
        `SELECT * FROM accepted_offer_snapshots WHERE transaction_id = $1`,
        [main.transactionId],
      );
      expect(rows).toHaveLength(1);
      const snapshot = rows[0];
      for (const field of [
        'bank_org_id',
        'supplier_org_id',
        'source_offer_id',
        'source_offer_version',
        'transaction_type',
        'recourse_type',
        'gross_funding_amount',
        'bank_discount_amount',
        'bank_fees_amount',
        'platform_commission_amount',
        'listing_fee_amount',
        'other_deductions_amount',
        'net_supplier_payout',
        'conditions_snapshot',
        'snapshot_hash',
      ]) {
        expect(snapshot[field]).not.toBeNull();
      }
    });

    it('replays the same acceptance without re-executing it', async () => {
      const before = await db.query(
        `SELECT count(*)::int AS n FROM offer_selections WHERE listing_id = $1`,
        [main.listingId],
      );
      const res = await api('supplier', 'post', `/offers/${main.offerA}/accept`);
      expect(res.status).toBe(200);
      expect(res.body.snapshotHash).toMatch(/^sha256:/);

      const after = await db.query(
        `SELECT count(*)::int AS n FROM offer_selections WHERE listing_id = $1`,
        [main.listingId],
      );
      expect(after.rows[0].n).toBe(before.rows[0].n);
      expect(after.rows[0].n).toBe(1);
    }, 30_000);

    it('refuses to accept the other offer once one is accepted', async () => {
      const res = await api('supplier', 'post', `/offers/${main.offerB}/accept`);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('TRANSACTION_ALREADY_LOCKED');
    }, 30_000);
  });

  // -------------------------------------------------------------------
  // Idempotency-Key (contract global rule 4) — the header is honoured, not
  // merely allowed through CORS.
  // -------------------------------------------------------------------

  describe('Idempotency-Key on a money-moving POST', () => {
    it('refuses a flagged request that omits the header', async () => {
      const fixture = await buildFixture();
      const res = await request(app.getHttpServer())
        .post(`${prefix}/offers/${fixture.offerA}/accept`)
        .set('Authorization', `Bearer ${tokens.supplier}`)
        .set('X-Organization-Id', orgs.supplier);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

      // And it did not execute: no snapshot was written.
      const { rows } = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM accepted_offer_snapshots WHERE transaction_id = $1`,
        [fixture.transactionId],
      );
      expect(rows[0].n).toBe('0');
    }, 60_000);

    it('replays the first response for a repeated key without re-executing', async () => {
      const fixture = await buildFixture();
      const key = randomUUID();

      const first = await api('supplier', 'post', `/offers/${fixture.offerA}/accept`, undefined, key);
      expect(first.status).toBe(200);

      const replay = await api('supplier', 'post', `/offers/${fixture.offerA}/accept`, undefined, key);
      expect(replay.status).toBe(200);
      // Byte-identical to the first response, served from the stored record.
      expect(replay.body).toEqual(first.body);

      // Exactly one snapshot and one selection — the handler ran once.
      const snap = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM accepted_offer_snapshots WHERE transaction_id = $1`,
        [fixture.transactionId],
      );
      expect(snap.rows[0].n).toBe('1');
    }, 60_000);

    it('rejects a key reused for a different request', async () => {
      const fixture = await buildFixture();
      const key = randomUUID();

      const first = await api('supplier', 'post', `/offers/${fixture.offerA}/accept`, undefined, key);
      expect(first.status).toBe(200);

      // Same key, different path (the other offer) — a client error, not a
      // replay. The stored request fingerprint does not match.
      const reused = await api('supplier', 'post', `/offers/${fixture.offerB}/accept`, undefined, key);
      expect(reused.status).toBe(409);
      expect(reused.body.code).toBe('CONFLICT');
    }, 60_000);
  });

  // -------------------------------------------------------------------
  // INV-4 at the database level
  // -------------------------------------------------------------------

  describe('INV-4 — the lock is immutable in the database, not only in the service', () => {
    it('refuses to clear locked_at', async () => {
      // "Unlock and re-accept" is the operation someone will reach for when a
      // deal needs unwinding. It must not exist.
      await expect(
        db.query(`UPDATE receivable_transactions SET locked_at = NULL WHERE id = $1`, [
          main.transactionId,
        ]),
      ).rejects.toThrow(/INV-4/);
    });

    it('refuses to move locked_at to a different time', async () => {
      await expect(
        db.query(`UPDATE receivable_transactions SET locked_at = now() WHERE id = $1`, [
          main.transactionId,
        ]),
      ).rejects.toThrow(/INV-4/);
    });

    it('refuses to repoint locked_by_offer_id at the other bank’s offer', async () => {
      await expect(
        db.query(`UPDATE receivable_transactions SET locked_by_offer_id = $2 WHERE id = $1`, [
          main.transactionId,
          main.offerB,
        ]),
      ).rejects.toThrow(/INV-4/);
    });

    it('still allows unrelated updates to a locked transaction', async () => {
      // The trigger must not freeze the whole row — Phase 7 has to advance
      // the state of a locked transaction.
      await expect(
        db.query(`UPDATE receivable_transactions SET updated_at = now() WHERE id = $1`, [
          main.transactionId,
        ]),
      ).resolves.toBeDefined();
    });
  });

  // -------------------------------------------------------------------
  // ZM-SEL-008 — the snapshot survives the source offer changing
  // -------------------------------------------------------------------

  describe('snapshot immutability (ZM-SEL-008)', () => {
    it('is byte-identical after the source offer is altered underneath it', async () => {
      const { rows: before } = await db.query<Record<string, unknown>>(
        `SELECT * FROM accepted_offer_snapshots WHERE transaction_id = $1`,
        [main.transactionId],
      );

      // Reach past the API and change the offer the snapshot came from. No
      // endpoint permits this — that is the point. The snapshot must not be a
      // view onto a mutable row.
      await db.query(
        `UPDATE bank_offers SET gross_funding_amount = 5000.000, net_supplier_payout = 4390.000
          WHERE id = $1`,
        [main.offerA],
      );

      const { rows: after } = await db.query<Record<string, unknown>>(
        `SELECT * FROM accepted_offer_snapshots WHERE transaction_id = $1`,
        [main.transactionId],
      );
      expect(after[0]).toEqual(before[0]);
      expect(after[0].net_supplier_payout).toBe('8390.000');

      await db.query(
        `UPDATE bank_offers SET gross_funding_amount = 9000.000, net_supplier_payout = 8390.000
          WHERE id = $1`,
        [main.offerA],
      );
    });
  });

  // -------------------------------------------------------------------
  // The concurrency harness (Test Strategy 5.2) — the point of the phase
  // -------------------------------------------------------------------

  describe('INV-1 — concurrent acceptance produces exactly one winner', () => {
    it(
      `survives ${CONCURRENCY_ITERATIONS} rounds of two simultaneous accepts on different offers`,
      async () => {
        for (let round = 0; round < CONCURRENCY_ITERATIONS; round += 1) {
          const fixture = await buildFixture();

          // Fired without awaiting either — two requests genuinely in flight
          // against the same transaction row at the same moment. A
          // read-then-write implementation lets both through here.
          const [first, second] = await Promise.all([
            api('supplier', 'post', `/offers/${fixture.offerA}/accept`),
            api('supplier', 'post', `/offers/${fixture.offerB}/accept`),
          ]);

          const statuses = [first.status, second.status].sort();
          expect(statuses).toEqual([200, 409]);

          const conflict = first.status === 409 ? first : second;
          expect(conflict.body.code).toBe('TRANSACTION_ALREADY_LOCKED');

          // The HTTP statuses alone would not prove the database is
          // consistent — a partial write could still have landed.
          const { rows: offerStates } = await db.query<{ status: string; n: string }>(
            `SELECT status, count(*)::text AS n FROM bank_offers
              WHERE listing_id = $1 GROUP BY status`,
            [fixture.listingId],
          );
          const byStatus = Object.fromEntries(offerStates.map((r) => [r.status, Number(r.n)]));
          expect(byStatus.SELECTED).toBe(1);
          expect(byStatus.NOT_SELECTED).toBe(1);

          const { rows: selections } = await db.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM offer_selections WHERE listing_id = $1`,
            [fixture.listingId],
          );
          expect(Number(selections[0].n)).toBe(1);

          const { rows: snapshots } = await db.query<{ n: string; hash: string }>(
            `SELECT count(*)::text AS n, min(snapshot_hash) AS hash
               FROM accepted_offer_snapshots WHERE transaction_id = $1`,
            [fixture.transactionId],
          );
          expect(Number(snapshots[0].n)).toBe(1);
          expect(snapshots[0].hash).toMatch(/^sha256:/);

          // And the lock points at the offer that actually won.
          const { rows: tx } = await db.query<{ locked_by_offer_id: string }>(
            `SELECT locked_by_offer_id FROM receivable_transactions WHERE id = $1`,
            [fixture.transactionId],
          );
          const { rows: selected } = await db.query<{ id: string }>(
            `SELECT id FROM bank_offers WHERE listing_id = $1 AND status = 'SELECTED'`,
            [fixture.listingId],
          );
          expect(tx[0].locked_by_offer_id).toBe(selected[0].id);
        }
      },
      600_000,
    );

    it('accept-vs-reject-all resolves to one winner too', async () => {
      const fixture = await buildFixture();
      const [accept, reject] = await Promise.all([
        api('supplier', 'post', `/offers/${fixture.offerA}/accept`),
        api('supplier', 'post', `/listings/${fixture.listingId}/reject-all`),
      ]);

      // Whichever wins, the outcome must be internally consistent: either the
      // transaction is locked with a snapshot, or it is back to ELIGIBLE with
      // none. Never both, never neither.
      const { rows } = await db.query<{ state: string; locked_at: Date | null }>(
        `SELECT state, locked_at FROM receivable_transactions WHERE id = $1`,
        [fixture.transactionId],
      );
      const { rows: snapshots } = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM accepted_offer_snapshots WHERE transaction_id = $1`,
        [fixture.transactionId],
      );

      if (accept.status === 200) {
        expect(rows[0].state).toBe('OFFER_ACCEPTED');
        expect(rows[0].locked_at).not.toBeNull();
        expect(Number(snapshots[0].n)).toBe(1);
      } else {
        expect(reject.status).toBe(200);
        expect(rows[0].state).toBe('ELIGIBLE');
        expect(rows[0].locked_at).toBeNull();
        expect(Number(snapshots[0].n)).toBe(0);
      }
    }, 120_000);

    it('accept-vs-withdraw never leaves a selected-but-withdrawn offer', async () => {
      const fixture = await buildFixture();
      const [accept] = await Promise.all([
        api('supplier', 'post', `/offers/${fixture.offerA}/accept`),
        api('bankAMaker', 'post', `/offers/${fixture.offerA}/withdraw`, { reason: 'race' }),
      ]);

      const { rows } = await db.query<{ status: string }>(
        `SELECT status FROM bank_offers WHERE id = $1`,
        [fixture.offerA],
      );
      // The two outcomes are SELECTED (accept won) or WITHDRAWN (withdraw
      // won). What must never happen is an offer that is both, or a snapshot
      // over a withdrawn offer.
      expect(['SELECTED', 'WITHDRAWN']).toContain(rows[0].status);

      const { rows: snapshots } = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM accepted_offer_snapshots WHERE source_offer_id = $1`,
        [fixture.offerA],
      );
      if (rows[0].status === 'WITHDRAWN') {
        expect(accept.status).not.toBe(200);
        expect(Number(snapshots[0].n)).toBe(0);
      } else {
        expect(Number(snapshots[0].n)).toBe(1);
      }
    }, 120_000);
  });

  // -------------------------------------------------------------------
  // Conditions and the pre-contract checks
  // -------------------------------------------------------------------

  describe('conditions (ZM-CON-006)', () => {
    let conditioned: Fixture;
    let mandatoryConditionId: string;

    beforeAll(async () => {
      conditioned = await buildFixture({
        conditions: [
          { title: 'Signed assignment notice', mandatory: true },
          { title: 'Quarterly statements', mandatory: false },
        ],
      });
      const res = await api('supplier', 'post', `/offers/${conditioned.offerA}/accept`);
      expect(res.status).toBe(200);

      const { rows } = await db.query<{ id: string }>(
        `SELECT id FROM offer_conditions WHERE offer_id = $1 AND is_mandatory`,
        [conditioned.offerA],
      );
      mandatoryConditionId = rows[0].id;
    }, 120_000);

    it('puts the transaction in CONDITIONS_PENDING on acceptance', async () => {
      const { rows } = await db.query<{ state: string }>(
        `SELECT state FROM receivable_transactions WHERE id = $1`,
        [conditioned.transactionId],
      );
      expect(rows[0].state).toBe('CONDITIONS_PENDING');
    });

    it('lists the accepted offer’s conditions to both parties', async () => {
      const supplierView = await api(
        'supplier',
        'get',
        `/transactions/${conditioned.transactionId}/conditions`,
      );
      expect(supplierView.status).toBe(200);
      expect(supplierView.body).toHaveLength(2);
      expect(supplierView.body[0].fulfilment).toBe('PENDING');
    }, 30_000);

    it('blocks contract generation and reports ALL findings at once', async () => {
      const res = await api(
        'supplier',
        'post',
        `/transactions/${conditioned.transactionId}/contract`,
      );
      expect(res.status).toBe(422);
      const findings = res.body.details.findings as { code: string; message: string }[];
      expect(findings.map((f) => f.code)).toContain('CONDITION_OUTSTANDING');
      // A list, not a single first-failure string — that shape is the
      // requirement, and `pre-contract-checks.spec.ts` exercises the
      // multi-finding case exhaustively without needing to arrange four
      // simultaneous real-world failures here.
      expect(Array.isArray(findings)).toBe(true);
      expect(findings[0].message).toContain('Signed assignment notice');
    }, 30_000);

    it('refuses a supplier’s attempt to waive the bank’s own condition', async () => {
      const res = await api('supplier', 'post', `/conditions/${mandatoryConditionId}/fulfil`, {
        waiverReason: 'We would rather not.',
      });
      expect(res.status).toBe(403);
    }, 30_000);

    it('refuses a waiver with a blank reason (ZM-CON-006 needs the record)', async () => {
      const res = await api('bankAMaker', 'post', `/conditions/${mandatoryConditionId}/fulfil`, {
        waiverReason: '   ',
      });
      expect(res.status).toBe(422);
    }, 30_000);

    it('accepts the supplier’s fulfilment and returns the transaction to OFFER_ACCEPTED', async () => {
      const res = await api('supplier', 'post', `/conditions/${mandatoryConditionId}/fulfil`, {
        notes: 'Notice countersigned and filed.',
      });
      expect(res.status).toBe(200);
      expect(res.body.fulfilment).toBe('FULFILLED');

      const { rows } = await db.query<{ state: string }>(
        `SELECT state FROM receivable_transactions WHERE id = $1`,
        [conditioned.transactionId],
      );
      // Derived from the conditions, so it moves back on its own — the state
      // can never disagree with the checklist.
      expect(rows[0].state).toBe('OFFER_ACCEPTED');
    }, 30_000);
  });

  // -------------------------------------------------------------------
  // Contract generation and signing
  // -------------------------------------------------------------------

  describe('contract generation and signing', () => {
    beforeAll(async () => {
      // The one ZM-CON-006 condition the seed cannot satisfy on its own: a
      // VERIFIED supplier bank account. Inserted directly, because Phase 2's
      // verification flow is not what this block is testing.
      // `iban_enc` is pgp_sym_encrypt under the runtime ENCRYPTION_KEY, so
      // the fixture encrypts with the same key rather than writing plaintext
      // into a column every reader expects to be ciphertext — the trap
      // db/seed/0300 documents for the buyer contact column.
      await db.query(
        `INSERT INTO supplier_bank_accounts
           (organization_id, iban_enc, iban_last4, bank_name, account_holder_name,
            verification_status, verified_at, is_primary)
         SELECT $1, pgp_sym_encrypt($2, $3), '0302', 'Jordan National Bank',
                'Al-Noor Trading', 'VERIFIED', now(), true
          WHERE NOT EXISTS (
            SELECT 1 FROM supplier_bank_accounts
             WHERE organization_id = $1 AND verification_status = 'VERIFIED')`,
        [ORG.alNoor, 'JO94CBJO0010000000000131000302', process.env.ENCRYPTION_KEY ?? 'dev-key'],
      );
    }, 60_000);

    it('generates the contract from the snapshot, with a document and a hash', async () => {
      const res = await api('supplier', 'post', `/transactions/${main.transactionId}/contract`);
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('PENDING_SIGNATURES');
      expect(res.body.templateVersion).toBe('v1.0');
      expect(res.body.canonicalLanguage).toBe('EN');
      expect(res.body.documentId).toBeTruthy();
      expect(res.body.documentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      contractId = res.body.id;
    }, 120_000);

    it('creates a PENDING slot for every eligible signatory of each party', async () => {
      const { rows } = await db.query<{ signer_capacity: string; status: string }>(
        `SELECT signer_capacity, status FROM contract_signatures WHERE contract_id = $1`,
        [contractId],
      );
      // Both capacities present, every slot PENDING. The count is >= 2 rather
      // than == 2 on purpose: JNB has two authorized signatories in the seed,
      // so it gets two slots. Either of them may sign — see the FULLY_SIGNED
      // test, which does NOT require both.
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(rows.every((r) => r.status === 'PENDING')).toBe(true);
      expect(new Set(rows.map((r) => r.signer_capacity))).toEqual(
        new Set(['SUPPLIER_AUTHORIZED_SIGNATORY', 'BANK_AUTHORIZED_SIGNATORY']),
      );
    });

    it('freezes the terms with their own hash (ZM-CON-005)', async () => {
      const { rows } = await db.query<{ terms_snapshot: Record<string, unknown> }>(
        `SELECT terms_snapshot FROM contracts WHERE id = $1`,
        [contractId],
      );
      const terms = rows[0].terms_snapshot;
      expect(String(terms.termsHash)).toMatch(/^sha256:/);
      expect(String(terms.acceptedOfferSnapshotHash)).toMatch(/^sha256:/);
      expect((terms.commercial as Record<string, string>).netSupplierPayout).toBe('8390.000');
    });

    it('refuses a second generation rather than replacing a signable document', async () => {
      const res = await api('supplier', 'post', `/transactions/${main.transactionId}/contract`);
      expect(res.status).toBe(409);
    }, 30_000);

    it('refuses to sign from a user who is not a signatory on this contract', async () => {
      const res = await api('bankBMaker', 'post', `/contracts/${contractId}/sign`, {
        accepted: true,
      });
      // Bank B is not a party at all, so it cannot even see the contract.
      expect([403, 404]).toContain(res.status);
    }, 30_000);

    it('refuses `accepted: false` rather than treating it as a no-op', async () => {
      const res = await api('supplier', 'post', `/contracts/${contractId}/sign`, {
        accepted: false,
      });
      expect(res.status).toBe(422);
    }, 30_000);

    it('records the supplier’s signature as VERIFIED, not merely SIGNED', async () => {
      const res = await api('supplier', 'post', `/contracts/${contractId}/sign`, {
        accepted: true,
      });
      expect(res.status).toBe(200);
      // ZM-CON-011: only a verified signature counts.
      expect(res.body.status).toBe('PENDING_SIGNATURES');

      const { rows } = await db.query<{
        status: string;
        ip_address: string | null;
        signed_document_hash: string;
        verification_result: Record<string, unknown>;
      }>(
        `SELECT s.status, s.ip_address::text AS ip_address, s.signed_document_hash,
                s.verification_result
           FROM contract_signatures s
          WHERE s.contract_id = $1 AND s.signer_capacity = 'SUPPLIER_AUTHORIZED_SIGNATORY'`,
        [contractId],
      );
      expect(rows[0].status).toBe('VERIFIED');
      expect(rows[0].signed_document_hash).toMatch(/^sha256:/);
      expect((rows[0].verification_result as { verified: boolean }).verified).toBe(true);
    }, 60_000);

    it('reaches FULLY_SIGNED and CONTRACTED when the bank signs too (ZM-CON-012)', async () => {
      const res = await api('bankAApprover', 'post', `/contracts/${contractId}/sign`, {
        accepted: true,
      });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('FULLY_SIGNED');
      expect(res.body.fullySignedAt).toBeTruthy();

      const { rows } = await db.query<{ state: string }>(
        `SELECT state FROM receivable_transactions WHERE id = $1`,
        [main.transactionId],
      );
      expect(rows[0].state).toBe('CONTRACTED');
    }, 60_000);

    it('did not require the bank’s SECOND authorized signatory (ZM-CON-010)', async () => {
      // The seeded JNB has two: the admin and the approver. Only the approver
      // signed. Requiring both would hold the contract hostage to whichever
      // colleague is on leave, and would quietly turn ZM-CON-010's stated
      // default of "one and one" into "all".
      const { rows } = await db.query<{ status: string; n: string }>(
        `SELECT status, count(*)::text AS n FROM contract_signatures
          WHERE contract_id = $1 GROUP BY status`,
        [contractId],
      );
      const byStatus = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
      expect(byStatus.VERIFIED).toBe(2);
      // The unsigned slot stays PENDING rather than being tidied away — that
      // person did not sign, and the record says so.
      expect(byStatus.PENDING).toBeGreaterThanOrEqual(1);
    });

    it('is idempotent on a second signature click', async () => {
      const res = await api('supplier', 'post', `/contracts/${contractId}/sign`, {
        accepted: true,
      });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('FULLY_SIGNED');
    }, 30_000);

    it('shows both parties the contract, and nobody else', async () => {
      const supplier = await api('supplier', 'get', `/transactions/${main.transactionId}/contract`);
      expect(supplier.status).toBe(200);

      const bankA = await api('bankAMaker', 'get', `/transactions/${main.transactionId}/contract`);
      expect(bankA.status).toBe(200);

      const bankB = await api('bankBMaker', 'get', `/transactions/${main.transactionId}/contract`);
      expect(bankB.status).toBe(404);
    }, 60_000);
  });
});
