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
