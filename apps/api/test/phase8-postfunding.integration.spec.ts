import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { AppConfig } from '../src/config/configuration';
import { SystemTimeProvider } from '../src/common/time/time.provider';
import { MaturityService } from '../src/modules/payments/maturity.service';

/**
 * Phase 8 integration checkpoint — the lifecycle after money moves.
 *
 * The checkpoint the phase file names, live against the hosted database:
 *
 *   a funded transaction passes its due date → **`OVERDUE_UNCONFIRMED`, never
 *   `OVERDUE`** → the bank confirms → `OVERDUE` → the bank initiates recourse
 *   → the supplier repays → `SETTLED` → closed `RECOURSE_SETTLED`. A partial
 *   payment recalculates the derived balance. **A dispute pauses the maturity
 *   job.** The buyer notification is stored with delivery evidence.
 *
 * ## Why the overdue block is the important one
 *
 * Everything else here would pass against an implementation that flipped a
 * transaction to `OVERDUE` the moment a date passed. Only asserting the
 * *absence* of that state, after the sweep has genuinely run against a
 * genuinely overdue row, distinguishes a system that waits for evidence from
 * one that assumes the worst about a supplier it cannot see the bank records
 * for.
 *
 * As in Phases 6 and 7, the fixture is arranged up to `FUNDED` in SQL — the
 * route there is proved by the earlier checkpoints, and repeating it would
 * spend minutes per fixture proving something already proved.
 */

const connectionString = process.env.DATABASE_URL;
const SUPABASE = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
const ANON = process.env.SUPABASE_ANON_KEY ?? '';
const PASSWORD = process.env.SEED_USER_PASSWORD ?? 'Zimmamless#2026';

if (!connectionString && process.env.CI) {
  throw new Error('DATABASE_URL is not set in CI. The Phase 8 checkpoint must run, not skip.');
}

const describeIfDb = connectionString && SUPABASE && ANON ? describe : describe.skip;

const ORG = {
  alNoor: '0e000000-0000-4000-8000-000000000002',
  bankA: '0e000000-0000-4000-8000-000000000004',
  bankB: '0e000000-0000-4000-8000-000000000005',
  platform: '0e000000-0000-4000-8000-000000000001',
};
const AL_NOOR_OWNER = '0e100000-0000-4000-8000-000000000001';
const BUYER_ESTABLISHMENT = '30000201';

/** The invoice's frozen figures. The derived balance is computed against these. */
const FACE_VALUE = '11600.000';
const OUTSTANDING = '11600.000';

interface Fixture {
  transactionId: string;
  invoiceId: string;
  listingId: string;
  offerId: string;
  snapshotId: string;
}

describeIfDb('Phase 8 — post-funding lifecycle', () => {
  let app: INestApplication;
  let db: Client;
  let prefix: string;

  const tokens: Record<string, string> = {};
  const orgs: Record<string, string> = {};
  const created: Fixture[] = [];

  let main: Fixture;

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
    method: 'get' | 'post',
    path: string,
    body?: unknown,
  ): request.Test => {
    const req = request(app.getHttpServer())[method](`${prefix}${path}`)
      .set('Authorization', `Bearer ${tokens[persona]}`)
      .set('X-Organization-Id', orgs[persona]);
    if (method === 'post') req.set('Idempotency-Key', randomUUID());
    return body === undefined ? req : req.send(body as object);
  };

  /**
   * A FUNDED transaction with a due date in the past.
   *
   * `dueInDays` is negative for an already-overdue fixture. The snapshot is
   * written directly because everything downstream reads `bank_org_id` from
   * it to decide who the funding bank is.
   */
  const buildFunded = async (dueInDays: number): Promise<Fixture> => {
    const fixture: Fixture = {
      transactionId: randomUUID(),
      invoiceId: randomUUID(),
      listingId: randomUUID(),
      offerId: randomUUID(),
      snapshotId: randomUUID(),
    };

    const { rows: buyers } = await db.query<{ id: string }>(
      `SELECT id FROM buyers WHERE national_establishment_no = $1`,
      [BUYER_ESTABLISHMENT],
    );
    if (buyers.length === 0) throw new Error('Buyer fixture missing — run db:seed and 0300.');

    await db.query(
      `INSERT INTO receivable_transactions
         (id, reference_number, supplier_org_id, buyer_id, state, minimum_acceptable_amount, created_by)
       VALUES ($1,$2,$3,$4,'FUNDED','5000.000',$5)`,
      [
        fixture.transactionId,
        `ZM-P8-${fixture.transactionId.slice(0, 8)}`,
        ORG.alNoor,
        buyers[0].id,
        AL_NOOR_OWNER,
      ],
    );
    await db.query(
      `INSERT INTO invoices
         (id, transaction_id, invoice_number, einvoice_identifier, issue_date, due_date,
          subtotal_amount, tax_amount, face_value, paid_amount, outstanding_amount, fingerprint)
       VALUES ($1,$2,$3,$4, CURRENT_DATE - 60, CURRENT_DATE + $6::integer,
               10000.000, 1600.000, $7::numeric, 0, $8::numeric, $5)`,
      [
        fixture.invoiceId,
        fixture.transactionId,
        `PHASE8-${fixture.transactionId.slice(0, 8)}`,
        `JO-EINV-P8-${fixture.transactionId.slice(0, 8)}`,
        `phase8-fixture-${fixture.transactionId}`,
        dueInDays,
        FACE_VALUE,
        OUTSTANDING,
      ],
    );
    await db.query(
      `INSERT INTO listings
         (id, transaction_id, round_number, status, activated_at,
          offer_submission_deadline, supplier_selection_deadline, activated_by)
       VALUES ($1,$2,1,'OFFER_SELECTED', now() - interval '30 days', now() - interval '29 days',
               now() - interval '28 days', $3)`,
      [fixture.listingId, fixture.transactionId, AL_NOOR_OWNER],
    );
    await db.query(
      `INSERT INTO bank_offers
         (id, listing_id, bank_org_id, status, version_number, transaction_type, recourse_type,
          gross_funding_amount, bank_discount_amount, bank_fees_amount,
          platform_commission_amount, listing_fee_amount, other_deductions_amount,
          net_supplier_payout, valid_until, created_by, approved_by, approved_at, submitted_at)
       VALUES ($1,$2,$3,'SELECTED',1,'INVOICE_FINANCING','FULL_RECOURSE',
               9000.000,300.000,150.000,135.000,25.000,0.000,8390.000,
               now() + interval '30 days',
               '0e100000-0000-4000-8000-000000000005',
               '0e100000-0000-4000-8000-000000000006', now(), now())`,
      [fixture.offerId, fixture.listingId, ORG.bankA],
    );
    // The snapshot hangs off a selection (`selection_id` is NOT NULL and
    // UNIQUE), so the selection row has to exist first.
    const selectionId = randomUUID();
    await db.query(
      `INSERT INTO offer_selections (id, listing_id, offer_id, selected_by)
       VALUES ($1,$2,$3,$4)`,
      [selectionId, fixture.listingId, fixture.offerId, AL_NOOR_OWNER],
    );
    await db.query(
      `INSERT INTO accepted_offer_snapshots
         (id, selection_id, transaction_id, bank_org_id, supplier_org_id, source_offer_id,
          source_offer_version, transaction_type, recourse_type,
          gross_funding_amount, bank_discount_amount, bank_fees_amount,
          platform_commission_amount, listing_fee_amount, other_deductions_amount,
          net_supplier_payout, conditions_snapshot, snapshot_hash)
       VALUES ($1,$2,$3,$4,$5,$6,1,'INVOICE_FINANCING','FULL_RECOURSE',
               9000.000,300.000,150.000,135.000,25.000,0.000,8390.000,
               '[]'::jsonb,$7)`,
      [
        fixture.snapshotId,
        selectionId,
        fixture.transactionId,
        ORG.bankA,
        ORG.alNoor,
        fixture.offerId,
        `phase8-fixture-hash-${fixture.transactionId}`,
      ],
    );

    created.push(fixture);
    return fixture;
  };

  const stateOf = async (transactionId: string): Promise<string> => {
    const { rows } = await db.query<{ state: string }>(
      `SELECT state FROM receivable_transactions WHERE id = $1`,
      [transactionId],
    );
    return rows[0]?.state;
  };

  const cleanup = async (): Promise<void> => {
    for (const fixture of created) {
      await db.query('BEGIN');
      try {
        const { rows: hasLedger } = await db.query(
          `SELECT 1 FROM ledger_entries WHERE transaction_id = $1 LIMIT 1`,
          [fixture.transactionId],
        );
        if (hasLedger.length > 0) {
          // Append-only (INV-7): leave the whole chain rather than half-delete it.
          await db.query('ROLLBACK');
          continue;
        }
        await db.query(
          `DELETE FROM recourse_repayments WHERE recourse_case_id IN
             (SELECT id FROM recourse_cases WHERE transaction_id = $1)`,
          [fixture.transactionId],
        );
        await db.query('DELETE FROM recourse_cases WHERE transaction_id = $1', [
          fixture.transactionId,
        ]);
        await db.query(`DELETE FROM fraud_indicators WHERE fraud_case_id IN
             (SELECT id FROM fraud_cases WHERE transaction_id = $1)`, [fixture.transactionId]);
        await db.query('DELETE FROM fraud_cases WHERE transaction_id = $1', [fixture.transactionId]);
        await db.query('DELETE FROM withdrawal_cases WHERE transaction_id = $1', [fixture.transactionId]);
        await db.query('DELETE FROM relisting_requests WHERE transaction_id = $1', [fixture.transactionId]);
        await db.query('DELETE FROM disputes WHERE transaction_id = $1', [
          fixture.transactionId,
        ]);
        await db.query('DELETE FROM buyer_payments WHERE transaction_id = $1', [
          fixture.transactionId,
        ]);
        await db.query('DELETE FROM accepted_offer_snapshots WHERE transaction_id = $1', [
          fixture.transactionId,
        ]);
        await db.query('DELETE FROM offer_selections WHERE listing_id = $1', [fixture.listingId]);
        await db.query('DELETE FROM bank_offers WHERE listing_id = $1', [fixture.listingId]);
        await db.query('DELETE FROM notifications WHERE transaction_id = $1', [
          fixture.transactionId,
        ]);
        await db.query('DELETE FROM listings WHERE id = $1', [fixture.listingId]);
        await db.query(
          `DELETE FROM status_history WHERE entity_type = 'TRANSACTION' AND entity_id = $1`,
          [fixture.transactionId],
        );
        await db.query('DELETE FROM invoices WHERE transaction_id = $1', [fixture.transactionId]);
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
      ['bankOps', 'ops@jnb.zimmamless.test', ORG.bankA],
      ['otherBank', 'maker@lcb.zimmamless.test', ORG.bankB],
      ['platformOps', 'admin@platform.zimmamless.test', ORG.platform],
      ['compliance', 'compliance@platform.zimmamless.test', ORG.platform],
    ] as const) {
      tokens[persona] = await login(email);
      const me = await request(app.getHttpServer())
        .get(`${prefix}/auth/me`)
        .set('Authorization', `Bearer ${tokens[persona]}`);
      const membership = (me.body.memberships as { organizationId: string }[]).find(
        (m) => m.organizationId === expectedOrg,
      );
      if (!membership) throw new Error(`${email} has no membership in ${expectedOrg}.`);
      orgs[persona] = membership.organizationId;
    }

    // Due 10 days ago: genuinely overdue before the first sweep runs.
    main = await buildFunded(-10);
  }, 300_000);

  afterAll(async () => {
    if (db) {
      await cleanup().catch(() => undefined);
      await db.end();
    }
    await app?.close();
  }, 300_000);

  // -------------------------------------------------------------------
  // ZM-PMT-008..011 — the headline
  // -------------------------------------------------------------------

  describe('a passed due date produces OVERDUE_UNCONFIRMED, never OVERDUE', () => {
    it('moves the transaction to OVERDUE_UNCONFIRMED when the sweep runs', async () => {
      const result = await app.get(MaturityService).sweep();
      expect(result.markedUnconfirmed).toBeGreaterThanOrEqual(1);
      expect(await stateOf(main.transactionId)).toBe('OVERDUE_UNCONFIRMED');
    }, 120_000);

    it('did NOT write OVERDUE — no automated path reaches it', async () => {
      // Asserted against the status history rather than only the current
      // state, so a transient flip through OVERDUE would still be caught.
      const { rows } = await db.query<{ new_status: string }>(
        `SELECT new_status FROM status_history
          WHERE entity_type = 'TRANSACTION' AND entity_id = $1`,
        [main.transactionId],
      );
      expect(rows.map((r) => r.new_status)).not.toContain('OVERDUE');
    }, 30_000);

    it('tells the supplier it is awaiting confirmation, not that they defaulted', async () => {
      const { rows } = await db.query<{ body: string; subject: string }>(
        `SELECT body, subject FROM notifications
          WHERE transaction_id = $1 AND template_key = 'PAYMENT_OVERDUE_UNCONFIRMED'`,
        [main.transactionId],
      );
      expect(rows.length).toBeGreaterThan(0);
      const body = rows[0].body.toLowerCase();
      expect(body).toContain('not a record of non-payment');
      expect(body).not.toContain('default');
    }, 30_000);

    it('is idempotent — a second sweep does not re-mark it', async () => {
      const before = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM status_history
          WHERE entity_id = $1 AND new_status = 'OVERDUE_UNCONFIRMED'`,
        [main.transactionId],
      );
      await app.get(MaturityService).sweep();
      const after = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM status_history
          WHERE entity_id = $1 AND new_status = 'OVERDUE_UNCONFIRMED'`,
        [main.transactionId],
      );
      expect(after.rows[0].count).toBe(before.rows[0].count);
    }, 120_000);
  });

  // -------------------------------------------------------------------
  // D-13 / PA-06 — the derived balance
  // -------------------------------------------------------------------

  describe('the outstanding balance is derived from payments, never stored', () => {
    it('starts at the invoice’s frozen outstanding', async () => {
      const res = await api('bankOps', 'get', `/transactions/${main.transactionId}/payments`);
      expect(res.status).toBe(200);
      expect(res.body.outstandingAmount).toBe(OUTSTANDING);
      expect(res.body.payments).toEqual([]);
      expect(res.body.overdueDays).toBeGreaterThan(0);
    }, 60_000);

    it('recalculates after a partial payment, and moves to PARTIALLY_PAID', async () => {
      const res = await api('bankOps', 'post', `/transactions/${main.transactionId}/payments`, {
        amount: '5000.000',
        paymentDate: '2026-09-02',
        bankReference: 'BUYER-WIRE-1',
        bankInternalNotes: 'Reconciled against statement line 88 — internal only',
      });

      expect(res.status).toBe(201);
      expect(res.body.outstandingAmount).toBe('6600.000');
      expect(res.body.transactionState).toBe('PARTIALLY_PAID');
      expect(await stateOf(main.transactionId)).toBe('PARTIALLY_PAID');
    }, 60_000);

    it('never mutated the invoice’s frozen columns (D-13)', async () => {
      const { rows } = await db.query<{ paid_amount: string; outstanding_amount: string }>(
        `SELECT paid_amount::text, outstanding_amount::text FROM invoices WHERE transaction_id = $1`,
        [main.transactionId],
      );
      // The offer was priced against these. Rewriting them would retroactively
      // change the terms of a deal that already closed.
      expect(rows[0].paid_amount).toBe('0.000');
      expect(rows[0].outstanding_amount).toBe(OUTSTANDING);
    }, 30_000);
  });

  // -------------------------------------------------------------------
  // ZM-PMT-018 — the supplier never sees the bank's working record
  // -------------------------------------------------------------------

  describe('ZM-PMT-018 — bankInternalNotes never reaches the supplier', () => {
    it('gives the supplier amounts and dates but no notes or evidence', async () => {
      const res = await api('supplier', 'get', `/transactions/${main.transactionId}/payments`);
      expect(res.status).toBe(200);
      expect(res.body.payments).toHaveLength(1);

      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain('bankInternalNotes');
      expect(serialized).not.toContain('bank_internal_notes');
      // By value as well as by name, so a renamed field still fails here.
      expect(serialized).not.toContain('statement line 88');
      expect(serialized).not.toContain('evidenceDocumentId');
      expect(serialized).not.toContain('reportedBy');

      // But the supplier does see what it is entitled to.
      expect(res.body.payments[0].amount).toBe('5000.000');
      expect(res.body.outstandingAmount).toBe('6600.000');
    }, 60_000);

    it('does give the bank its own notes back', async () => {
      const res = await api('bankOps', 'get', `/transactions/${main.transactionId}/payments`);
      expect(res.body.payments[0].bankInternalNotes).toContain('statement line 88');
    }, 60_000);

    it('shows a bank that is not party to the transaction nothing at all', async () => {
      const res = await api('otherBank', 'get', `/transactions/${main.transactionId}/payments`);
      // 404, not 403: a bank must not learn the transaction exists.
      expect(res.status).toBe(404);
    }, 60_000);
  });

  // -------------------------------------------------------------------
  // confirm-status — the only route to OVERDUE
  // -------------------------------------------------------------------

  describe('only a bank’s confirmation produces OVERDUE', () => {
    it('refuses a supplier attempting to confirm', async () => {
      const res = await api('supplier', 'post', `/transactions/${main.transactionId}/confirm-status`, {
        status: 'OVERDUE',
      });
      expect([403, 404]).toContain(res.status);
    }, 60_000);

    it('refuses PAID while the recorded payments do not settle the invoice', async () => {
      // The state and the money must not tell a supplier two different stories.
      const res = await api('bankOps', 'post', `/transactions/${main.transactionId}/confirm-status`, {
        status: 'PAID',
      });
      expect(res.status).toBe(422);
      expect(res.body.details?.outstandingAmount).toBe('6600.000');
    }, 60_000);

    it('accepts the bank’s OVERDUE confirmation', async () => {
      const res = await api('bankOps', 'post', `/transactions/${main.transactionId}/confirm-status`, {
        status: 'OVERDUE',
        notes: 'Buyer contacted; payment plan under discussion.',
      });
      expect(res.status).toBe(200);
      expect(res.body.transactionState).toBe('OVERDUE');
      expect(await stateOf(main.transactionId)).toBe('OVERDUE');
    }, 60_000);

    it('records in the audit trail that a bank confirmed it', async () => {
      const { rows } = await db.query<{ new_value: Record<string, unknown> }>(
        `SELECT new_value FROM audit_logs
          WHERE target_entity_id = $1 AND action_type = 'PAYMENT_STATUS_CONFIRMED'
          ORDER BY occurred_at DESC LIMIT 1`,
        [main.transactionId],
      );
      expect(rows[0].new_value).toMatchObject({ state: 'OVERDUE', confirmedByBank: true });
    }, 30_000);
  });

  // -------------------------------------------------------------------
  // ZM-REC-013 — a dispute pauses automation
  // -------------------------------------------------------------------

  describe('ZM-REC-013 — an open dispute pauses the maturity job', () => {
    it('leaves a disputed transaction untouched however overdue it is', async () => {
      const disputed = await buildFunded(-45);
      await db.query(`UPDATE receivable_transactions SET state = 'DISPUTED' WHERE id = $1`, [
        disputed.transactionId,
      ]);

      const result = await app.get(MaturityService).sweep();
      expect(result.skippedPaused).toBeGreaterThanOrEqual(1);

      // Still DISPUTED, and not even a reminder was sent: while the facts are
      // contested the platform says nothing automatic about this invoice.
      expect(await stateOf(disputed.transactionId)).toBe('DISPUTED');
      const { rows } = await db.query(
        `SELECT 1 FROM notifications WHERE transaction_id = $1`,
        [disputed.transactionId],
      );
      expect(rows).toHaveLength(0);
    }, 180_000);
  });

  // -------------------------------------------------------------------
  // ZM-REC-012/013/014 — disputes
  // -------------------------------------------------------------------

  describe('a dispute pauses automation and the platform does not adjudicate', () => {
    let disputed: Fixture;
    let disputeId: string;

    beforeAll(async () => {
      disputed = await buildFunded(-20);
    }, 120_000);

    it('lets the supplier open one, and pauses immediately', async () => {
      const res = await api('supplier', 'post', `/transactions/${disputed.transactionId}/disputes`, {
        disputeType: 'INVOICE_AUTHENTICITY',
        description: 'The buyer disputes having received the goods on this invoice.',
        amount: '4000.000',
      });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('OPEN');
      disputeId = res.body.id;
      expect(await stateOf(disputed.transactionId)).toBe('DISPUTED');
    }, 60_000);

    it('makes the maturity sweep skip it, though it is 20 days overdue', async () => {
      const before = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM notifications WHERE transaction_id = $1`,
        [disputed.transactionId],
      );

      const result = await app.get(MaturityService).sweep();
      expect(result.skippedPaused).toBeGreaterThanOrEqual(1);

      // Still DISPUTED, and not one extra notification: while the facts are
      // contested the platform says nothing automatic about this invoice.
      expect(await stateOf(disputed.transactionId)).toBe('DISPUTED');
      const after = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM notifications WHERE transaction_id = $1`,
        [disputed.transactionId],
      );
      expect(after.rows[0].count).toBe(before.rows[0].count);
    }, 120_000);

    it('refuses a payment while the dispute is open', async () => {
      const res = await api('bankOps', 'post', `/transactions/${disputed.transactionId}/payments`, {
        amount: '1000.000',
        paymentDate: '2026-09-10',
      });
      expect(res.status).toBe(409);
    }, 60_000);

    it('refuses a second dispute on the same transaction', async () => {
      const res = await api('bankOps', 'post', `/transactions/${disputed.transactionId}/disputes`, {
        disputeType: 'OTHER',
        description: 'Duplicate attempt.',
      });
      expect(res.status).toBe(409);
    }, 60_000);

    it('cannot be resolved without someone stating what was agreed', async () => {
      // The platform does not adjudicate, so there is no way to close a
      // dispute that does not involve a human writing down the outcome.
      const res = await api('supplier', 'post', `/disputes/${disputeId}/resolve`, {
        resolutionNotes: '   ',
      });
      expect(res.status).toBe(422);
    }, 60_000);

    it('records the parties’ resolution and returns the transaction to where it was', async () => {
      const res = await api('bankOps', 'post', `/disputes/${disputeId}/resolve`, {
        resolutionNotes: 'Buyer confirmed delivery; supplier withdrew the objection.',
        outcome: 'RESOLVED',
      });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('RESOLVED');
      expect(res.body.resolutionNotes).toContain('withdrew the objection');
      // Back to FUNDED, which is where it was before the dispute — read from
      // the transaction's own status history, not a remembered field.
      expect(await stateOf(disputed.transactionId)).toBe('FUNDED');
    }, 60_000);

    it('records that the platform did NOT adjudicate', async () => {
      const { rows } = await db.query<{ new_value: Record<string, unknown> }>(
        `SELECT new_value FROM audit_logs
          WHERE target_entity_id = $1 AND action_type = 'DISPUTE_RESOLVED'`,
        [disputeId],
      );
      expect(rows[0].new_value).toMatchObject({
        adjudicatedByPlatform: false,
        automationPaused: false,
      });
    }, 30_000);

    it('resumes automation — the next sweep acts on it again', async () => {
      const result = await app.get(MaturityService).sweep();
      expect(result.markedUnconfirmed).toBeGreaterThanOrEqual(1);
      expect(await stateOf(disputed.transactionId)).toBe('OVERDUE_UNCONFIRMED');
    }, 120_000);

    it('is idempotent — resolving a resolved dispute returns it unchanged', async () => {
      const res = await api('bankOps', 'post', `/disputes/${disputeId}/resolve`, {
        resolutionNotes: 'A different note that must not overwrite the record.',
      });
      expect(res.status).toBe(200);
      expect(res.body.resolutionNotes).toContain('withdrew the objection');
    }, 60_000);
  });

  // -------------------------------------------------------------------
  // ZM-REC-002/004 — recourse
  // -------------------------------------------------------------------

  describe('recourse is the bank’s claim, and only the bank’s', () => {
    let recourseFixture: Fixture;
    let caseId: string;

    beforeAll(async () => {
      // A confirmed overdue: recourse follows a bank's confirmation, never an
      // unconfirmed one.
      recourseFixture = await buildFunded(-40);
      await db.query(`UPDATE receivable_transactions SET state = 'OVERDUE' WHERE id = $1`, [
        recourseFixture.transactionId,
      ]);
    }, 120_000);

    it('refuses a supplier attempting to initiate recourse against itself', async () => {
      const res = await api(
        'supplier',
        'post',
        `/transactions/${recourseFixture.transactionId}/recourse`,
        { reason: 'NON_PAYMENT', requestedAmount: '9000.000' },
      );
      expect([403, 404]).toContain(res.status);
    }, 60_000);

    it('refuses a claim larger than the bank advanced (ZM-REC-004)', async () => {
      // The face value is 11,600 but the advance was 9,000. Claiming the face
      // value would recover more than was ever paid out.
      const res = await api(
        'bankOps',
        'post',
        `/transactions/${recourseFixture.transactionId}/recourse`,
        { reason: 'NON_PAYMENT', requestedAmount: '11600.000' },
      );
      expect(res.status).toBe(422);
      expect(res.body.details?.maximum).toBe('9000.000');
    }, 60_000);

    it('opens the case and moves the transaction to RECOURSE_ACTIVE', async () => {
      const res = await api(
        'bankOps',
        'post',
        `/transactions/${recourseFixture.transactionId}/recourse`,
        {
          reason: 'NON_PAYMENT',
          requestedAmount: '9000.000',
          notes: 'Buyer unreachable after three attempts — bank internal',
        },
      );

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('RECOURSE_INITIATED');
      expect(res.body.remainingAmount).toBe('9000.000');
      caseId = res.body.id;

      expect(await stateOf(recourseFixture.transactionId)).toBe('RECOURSE_ACTIVE');
    }, 60_000);

    it('refuses a second open case on the same transaction', async () => {
      const res = await api(
        'bankOps',
        'post',
        `/transactions/${recourseFixture.transactionId}/recourse`,
        { reason: 'NON_PAYMENT', requestedAmount: '1000.000' },
      );
      expect(res.status).toBe(409);
    }, 60_000);

    it('does NOT show the supplier the bank’s free-text notes', async () => {
      const res = await api('supplier', 'get', `/recourse/${caseId}`);
      expect(res.status).toBe(200);

      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain('bank internal');
      expect(serialized).not.toContain('reasonNotes');
      expect(serialized).not.toContain('initiatedBy');
      // But it does see the claim it has to answer.
      expect(res.body.requestedAmount).toBe('9000.000');
      expect(res.body.reason).toBe('NON_PAYMENT');
    }, 60_000);

    it('records NO automatic commission refund (ZM-FEE-016)', async () => {
      const { rows } = await db.query<{ new_value: Record<string, unknown> }>(
        `SELECT new_value FROM audit_logs
          WHERE target_entity_id = $1 AND action_type = 'RECOURSE_INITIATED'`,
        [recourseFixture.transactionId],
      );
      expect(rows[0].new_value).toMatchObject({ commissionRefunded: false });

      // And the commission row itself is untouched — still FINALIZED, not
      // reversed. The platform earned its fee on a transaction that funded.
      const { rows: commission } = await db.query<{ status: string }>(
        `SELECT status FROM commission_calculations WHERE transaction_id = $1`,
        [recourseFixture.transactionId],
      );
      // The fixture has no commission row (it was arranged in SQL, not through
      // acceptance), so the meaningful assertion is that recourse created no
      // reversal of any kind.
      expect(commission.filter((c) => c.status === 'REVERSED')).toHaveLength(0);
    }, 30_000);

    it('lets the supplier dispute, but not mark it settled', async () => {
      const settle = await api('supplier', 'post', `/recourse/${caseId}/status`, {
        status: 'SETTLED',
      });
      // Letting the debtor discharge their own debt is the failure mode here.
      expect(settle.status).toBe(403);
    }, 60_000);

    it('progresses through notification to payment pending', async () => {
      const notified = await api('bankOps', 'post', `/recourse/${caseId}/status`, {
        status: 'SUPPLIER_NOTIFIED',
      });
      expect(notified.status).toBe(200);
      expect(notified.body.status).toBe('SUPPLIER_NOTIFIED');

      const pending = await api('bankOps', 'post', `/recourse/${caseId}/status`, {
        status: 'PAYMENT_PENDING',
      });
      expect(pending.body.status).toBe('PAYMENT_PENDING');
    }, 90_000);

    it('refuses SETTLED while a balance remains', async () => {
      const res = await api('bankOps', 'post', `/recourse/${caseId}/status`, { status: 'SETTLED' });
      expect(res.status).toBe(422);
      expect(res.body.details?.remainingAmount).toBe('9000.000');
    }, 60_000);

    it('records a partial repayment and leaves the case open', async () => {
      const res = await api('supplier', 'post', `/recourse/${caseId}/repay`, {
        amount: '4000.000',
        providerReference: 'SUPPLIER-REPAY-1',
      });
      expect(res.status).toBe(200);
      expect(res.body.repaidAmount).toBe('4000.000');
      expect(res.body.remainingAmount).toBe('5000.000');
      expect(res.body.status).toBe('PAYMENT_PENDING');
    }, 60_000);

    it('settles on the final repayment and closes with RECOURSE_SETTLED', async () => {
      const res = await api('supplier', 'post', `/recourse/${caseId}/repay`, {
        amount: '5000.000',
      });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('SETTLED');
      expect(res.body.remainingAmount).toBe('0.000');

      const { rows } = await db.query<{ state: string; closure_reason: string }>(
        `SELECT state, closure_reason FROM receivable_transactions WHERE id = $1`,
        [recourseFixture.transactionId],
      );
      expect(rows[0].state).toBe('CLOSED');
      expect(rows[0].closure_reason).toBe('RECOURSE_SETTLED');
    }, 60_000);

    it('treats a repayment against a settled case as a no-op, not an error', async () => {
      const res = await api('supplier', 'post', `/recourse/${caseId}/repay`, {
        amount: '100.000',
      });
      expect(res.status).toBe(200);
      expect(res.body.remainingAmount).toBe('0.000');
      expect(res.body.repaidAmount).toBe('9000.000');
    }, 60_000);

    it('kept every repayment row (INV-7)', async () => {
      const { rows } = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM recourse_repayments WHERE recourse_case_id = $1`,
        [caseId],
      );
      expect(Number(rows[0].count)).toBe(2);
    }, 30_000);
  });

  // -------------------------------------------------------------------
  // AS-07 / LT-12 — withdrawal, and ZM-FRD-004 — fraud
  // -------------------------------------------------------------------

  describe('a withdrawal penalty is recorded, never deducted', () => {
    let withdrawn: Fixture;
    let withdrawalId: string;

    beforeAll(async () => {
      withdrawn = await buildFunded(30);
    }, 120_000);

    it('opens a case with the policy’s suggestion for a commercial withdrawal', async () => {
      const res = await api('bankOps', 'post', `/offers/${withdrawn.offerId}/withdrawal-case`, {
        reason: 'BANK_COMMERCIAL_DECISION',
        notes: 'Credit committee reversed the approval.',
      });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('WITHDRAWAL_REQUESTED');
      // The seeded policy charges 500.000 for a bank that simply changed its mind.
      expect(res.body.penaltyApplicable).toBe(true);
      expect(res.body.penaltyAmount).toBe('500.000');
      withdrawalId = res.body.id;
    }, 60_000);

    it('moved no money — the penalty is a number on a case, not a transfer', async () => {
      // No ledger entry, no settlement, no balance change. The rule stated as
      // an assertion about the database rather than a comment in a service.
      const { rows: ledger } = await db.query(
        `SELECT 1 FROM ledger_entries WHERE transaction_id = $1`,
        [withdrawn.transactionId],
      );
      expect(ledger).toHaveLength(0);

      const { rows: audit } = await db.query<{ new_value: Record<string, unknown> }>(
        `SELECT new_value FROM audit_logs
          WHERE target_entity_id = $1 AND action_type = 'WITHDRAWAL_CASE_OPENED'`,
        [withdrawn.transactionId],
      );
      expect(audit[0].new_value).toMatchObject({
        penaltyDeducted: false,
        relistingAutomatic: false,
      });
    }, 30_000);

    it('refuses a bank withdrawing another bank’s offer', async () => {
      const res = await api('otherBank', 'post', `/offers/${withdrawn.offerId}/withdrawal-case`, {
        reason: 'OTHER',
      });
      // 403 from the role guard (this persona is an offer maker, not
      // operations) or 404 from the service (not this bank's offer). Both are
      // correct refusals and which fires first is a routing detail, not a
      // behaviour worth pinning.
      expect([403, 404]).toContain(res.status);
    }, 60_000);

    it('lets an admin waive the penalty the policy proposed', async () => {
      const res = await api('platformOps', 'post', `/withdrawal-cases/${withdrawalId}/decide`, {
        penaltyApplicable: false,
        relistingEligible: true,
        notes: 'Bank notified within an hour and the supplier was not yet relying on the funds.',
      });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('NO_PENALTY');
      // The human overrode the policy, which is the whole point of the policy
      // being a suggestion.
      expect(res.body.penaltyApplicable).toBe(false);
      expect(res.body.penaltyAmount).toBe('0.000');
    }, 60_000);

    it('raises a REQUESTED relisting, not an approved one (ZM-REC-018)', async () => {
      const { rows } = await db.query<{ status: string; notes: string }>(
        `SELECT status, notes FROM relisting_requests WHERE transaction_id = $1`,
        [withdrawn.transactionId],
      );
      expect(rows).toHaveLength(1);
      // Eligibility to relist is not the same as certifying the receivable is
      // still financeable weeks after the deal collapsed.
      expect(rows[0].status).toBe('REQUESTED');
      expect(rows[0].notes).toContain('ZM-REC-018');
    }, 30_000);

    it('refuses a bank deciding its own withdrawal case', async () => {
      const res = await api('bankOps', 'post', `/withdrawal-cases/${withdrawalId}/decide`, {
        penaltyApplicable: false,
        relistingEligible: true,
      });
      expect(res.status).toBe(403);
    }, 60_000);
  });

  describe('ZM-FRD-004 — only compliance records a confirmed finding', () => {
    let suspect: Fixture;
    let fraudCaseId: string;

    beforeAll(async () => {
      suspect = await buildFunded(45);
    }, 120_000);

    it('freezes the transaction the moment a review is opened', async () => {
      const res = await api('bankOps', 'post', `/transactions/${suspect.transactionId}/fraud-review`, {
        summary: 'The same invoice number appears financed at another institution.',
        indicators: ['DOUBLE_FINANCING_SUSPECTED'],
      });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('OPEN');
      fraudCaseId = res.body.id;
      expect(await stateOf(suspect.transactionId)).toBe('FRAUD_REVIEW');
    }, 60_000);

    it('records NO confirmed finding on opening', async () => {
      const { rows } = await db.query<{ new_value: Record<string, unknown> }>(
        `SELECT new_value FROM audit_logs
          WHERE target_entity_id = $1 AND action_type = 'FRAUD_REVIEW_OPENED'`,
        [suspect.transactionId],
      );
      // An indicator is someone noticing something; a finding is a qualified
      // human concluding something.
      expect(rows[0].new_value).toMatchObject({ fundingFrozen: true, confirmedFinding: false });
    }, 30_000);

    it('stops the maturity job as well', async () => {
      const result = await app.get(MaturityService).sweep();
      expect(result.skippedPaused).toBeGreaterThanOrEqual(1);
      expect(await stateOf(suspect.transactionId)).toBe('FRAUD_REVIEW');
    }, 120_000);

    it('hides the case from the parties while it is unproven', async () => {
      // Telling a supplier a fraud review naming them exists, before anything
      // is concluded, turns a suspicion into an accusation they must answer.
      for (const persona of ['supplier', 'bankOps'] as const) {
        const res = await api(persona, 'get', `/fraud-cases/${fraudCaseId}`);
        expect([403, 404]).toContain(res.status);
      }
    }, 90_000);

    it('refuses a bank deciding the case it reported', async () => {
      const res = await api('bankOps', 'post', `/fraud-cases/${fraudCaseId}/decide`, {
        decision: 'BLACKLISTED',
      });
      expect(res.status).toBe(403);
    }, 60_000);

    it('clears on a compliance decision and resumes funding', async () => {
      const res = await api('compliance', 'post', `/fraud-cases/${fraudCaseId}/decide`, {
        decision: 'CLEARED',
        notes: 'The other institution’s reference was for a different invoice.',
      });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('CLEARED');
      expect(await stateOf(suspect.transactionId)).toBe('FUNDED');
    }, 60_000);

    it('records that THIS is the confirmed status', async () => {
      const { rows } = await db.query<{ new_value: Record<string, unknown> }>(
        `SELECT new_value FROM audit_logs
          WHERE target_entity_id = $1 AND action_type = 'FRAUD_CASE_DECIDED'`,
        [fraudCaseId],
      );
      expect(rows[0].new_value).toMatchObject({ status: 'CLEARED', confirmedFinding: false });
    }, 30_000);
  });

  // -------------------------------------------------------------------
  // The inbox and the case desk
  // -------------------------------------------------------------------

  describe('the notification inbox', () => {
    it('shows the supplier its own messages and an unread count', async () => {
      const res = await api('supplier', 'get', '/notifications');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.items)).toBe(true);
      expect(res.body.items.length).toBeGreaterThan(0);
      expect(typeof res.body.unreadCount).toBe('number');
      expect(res.body.items[0].read).toBe(false);
    }, 60_000);

    it('never returns the destination or the gateway reference', async () => {
      // An inbox is for reading messages, not auditing the transport, and the
      // destination can carry a personal phone number.
      const res = await api('supplier', 'get', '/notifications');
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain('destination');
      expect(serialized).not.toContain('providerReference');
    }, 60_000);

    it('marks one read, and the read sticks', async () => {
      const list = await api('supplier', 'get', '/notifications');
      const first = list.body.items[0];

      const read = await api('supplier', 'post', `/notifications/${first.id}/read`);
      expect(read.status).toBe(200);
      expect(read.body.read).toBe(true);

      // Idempotent: re-rendering the inbox must not keep moving the timestamp.
      const again = await api('supplier', 'post', `/notifications/${first.id}/read`);
      expect(again.status).toBe(200);
      expect(again.body.read).toBe(true);
    }, 90_000);

    it('refuses to mark another user’s notification read', async () => {
      const list = await api('supplier', 'get', '/notifications');
      const res = await api('bankOps', 'post', `/notifications/${list.body.items[0].id}/read`);
      // 404, not 403: the existence of a message addressed to another person
      // is not this caller's business.
      expect(res.status).toBe(404);
    }, 60_000);

    it('filters to unread', async () => {
      const res = await api('supplier', 'get', '/notifications?unread=true');
      expect(res.status).toBe(200);
      for (const item of res.body.items) expect(item.read).toBe(false);
    }, 60_000);
  });

  describe('GET /cases — role-scoped', () => {
    it('shows the platform every case type', async () => {
      const res = await api('platformOps', 'get', '/cases');
      expect(res.status).toBe(200);

      const types = new Set(res.body.items.map((c: { type: string }) => c.type));
      // The suite has created all four by this point.
      expect(types.has('RECOURSE')).toBe(true);
      expect(types.has('DISPUTE')).toBe(true);
      expect(types.has('WITHDRAWAL')).toBe(true);
      expect(types.has('FRAUD')).toBe(true);
    }, 60_000);

    it('NEVER shows a fraud case to a bank or a supplier', async () => {
      // Excluded from the query entirely rather than filtered afterwards: a
      // case that never enters the result set cannot leak through a later bug
      // in pagination or serialization.
      for (const persona of ['supplier', 'bankOps'] as const) {
        const res = await api(persona, 'get', '/cases');
        expect(res.status).toBe(200);
        expect(res.body.items.some((c: { type: string }) => c.type === 'FRAUD')).toBe(false);
      }
    }, 90_000);

    it('shows a party its own cases, and only those', async () => {
      const res = await api('supplier', 'get', '/cases');
      expect(res.body.items.length).toBeGreaterThan(0);

      // Every case returned belongs to a transaction this supplier owns.
      const ids = res.body.items
        .map((c: { transactionId: string }) => c.transactionId)
        .filter(Boolean);
      const { rows } = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM receivable_transactions
          WHERE id = ANY($1::uuid[]) AND supplier_org_id <> $2`,
        [ids, ORG.alNoor],
      );
      expect(rows[0].count).toBe('0');
    }, 60_000);

    it('carries no counterparty free text in the summary', async () => {
      const res = await api('supplier', 'get', '/cases');
      const serialized = JSON.stringify(res.body);
      // A list view is exactly where such a field gets rendered without
      // anyone thinking about who is reading it.
      expect(serialized).not.toContain('reasonNotes');
      expect(serialized).not.toContain('adminDecisionNotes');
      expect(serialized).not.toContain('bank internal');
    }, 60_000);

    it('filters by type', async () => {
      const res = await api('platformOps', 'get', '/cases?type=RECOURSE');
      expect(res.status).toBe(200);
      for (const item of res.body.items) expect(item.type).toBe('RECOURSE');
    }, 60_000);
  });

  // -------------------------------------------------------------------
  // INV-7 — closure records, it does not delete
  // -------------------------------------------------------------------

  describe('INV-7 — closing keeps everything', () => {
    it('closes with a reason', async () => {
      const res = await api('bankOps', 'post', `/transactions/${main.transactionId}/close`, {
        closureReason: 'SETTLED_BY_AGREEMENT',
        notes: 'Buyer settled directly with the bank.',
      });
      expect(res.status).toBe(200);
      expect(await stateOf(main.transactionId)).toBe('CLOSED');
    }, 60_000);

    it('kept every payment, notification and history row', async () => {
      for (const table of ['buyer_payments', 'notifications', 'status_history']) {
        const column = table === 'status_history' ? 'entity_id' : 'transaction_id';
        const { rows } = await db.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${table} WHERE ${column} = $1`,
          [main.transactionId],
        );
        expect(Number(rows[0].count)).toBeGreaterThan(0);
      }
    }, 30_000);

    it('is idempotent — closing a closed transaction returns it unchanged', async () => {
      const res = await api('bankOps', 'post', `/transactions/${main.transactionId}/close`, {
        closureReason: 'PAID_IN_FULL',
      });
      expect(res.status).toBe(200);
      // The original reason stands; a second close does not rewrite history.
      expect(res.body.closureReason).toBe('SETTLED_BY_AGREEMENT');
    }, 60_000);
  });
});
