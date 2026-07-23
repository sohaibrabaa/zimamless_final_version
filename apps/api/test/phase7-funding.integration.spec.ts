import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { AppConfig } from '../src/config/configuration';
import { SystemTimeProvider } from '../src/common/time/time.provider';
import { FundingDeadlinesService } from '../src/modules/funding/funding-deadlines.service';

/**
 * Phase 7 integration checkpoint — funding, settlement and the ledger, live.
 *
 * Four named invariants are proved here against the hosted database, because
 * each is a claim that cannot be established by a unit test:
 *
 *   **INV-10** — `FUNDED` requires the supplier's OTP *and* the bank's
 *   settlement evidence. The bank marking the transfer sent is not enough,
 *   and the test proves that by looking at the transaction's state in the
 *   database after the bank has done everything it can do.
 *
 *   **INV-6** — every journal balances. Asserted by summing debits and
 *   credits per `journal_id` in SQL, and separately by proving the clearing
 *   accounts net to exactly zero once the payout completes. Money that
 *   arrives and leaves must leave no residue.
 *
 *   **INV-5** — the commission is `CALCULATED` at acceptance and `FINALIZED`
 *   only on `PAYOUT_COMPLETED`. The platform does not book revenue for a
 *   payout that has not happened.
 *
 *   **INV-13** — a settlement never pays twice. Two retries fired at the same
 *   instant, repeatedly, against a row lock; exactly one payout each time.
 *
 * ## What is arranged in SQL and why
 *
 * The offer is accepted through the API — that call is what writes the
 * snapshot and the commission record, so it is under test. Contract
 * generation and signing are *not*: Phase 6's checkpoint proves that path in
 * full, and repeating it here would spend four minutes per fixture proving
 * something already proved. The transaction is moved to `CONTRACTED` in SQL
 * instead, which is the state funding starts from.
 */

const connectionString = process.env.DATABASE_URL;
const SUPABASE = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
const ANON = process.env.SUPABASE_ANON_KEY ?? '';
const PASSWORD = process.env.SEED_USER_PASSWORD ?? 'Zimmamless#2026';

if (!connectionString && process.env.CI) {
  throw new Error('DATABASE_URL is not set in CI. The Phase 7 checkpoint must run, not skip.');
}

const describeIfDb = connectionString && SUPABASE && ANON ? describe : describe.skip;

const ORG = {
  alNoor: '0e000000-0000-4000-8000-000000000002',
  bankA: '0e000000-0000-4000-8000-000000000004',
  bankB: '0e000000-0000-4000-8000-000000000005',
};
const AL_NOOR_OWNER = '0e100000-0000-4000-8000-000000000001';
const BUYER_ESTABLISHMENT = '30000201';

/** The fixture's money, fixed so every assertion below can name real numbers. */
const GROSS = '9000.000';
const COMMISSION = '135.000';
const LISTING_FEE = '25.000';
const NET = '8390.000';
/** gross − bank discount (300) − bank fees (150). What the platform actually distributes. */
const DISTRIBUTABLE = '8550.000';

const RETRY_ITERATIONS = Number(process.env.ZM_RETRY_ITERATIONS ?? '5');

interface Fixture {
  transactionId: string;
  invoiceId: string;
  listingId: string;
  offerId: string;
}

describeIfDb('Phase 7 — funding, settlement and the ledger', () => {
  let app: INestApplication;
  let db: Client;
  let prefix: string;

  const tokens: Record<string, string> = {};
  const orgs: Record<string, string> = {};
  const created: Fixture[] = [];

  let main: Fixture;
  let settlementId: string;

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
    method: 'get' | 'post',
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): request.Test => {
    const req = request(app.getHttpServer())[method](`${prefix}${path}`)
      .set('Authorization', `Bearer ${tokens[persona]}`)
      .set('X-Organization-Id', orgs[persona]);
    if (method === 'post') req.set('Idempotency-Key', idempotencyKey ?? randomUUID());
    return body === undefined ? req : req.send(body as object);
  };

  /** An accepted, contracted transaction — the state funding starts from. */
  const buildContracted = async (): Promise<Fixture> => {
    const fixture: Fixture = {
      transactionId: randomUUID(),
      invoiceId: randomUUID(),
      listingId: randomUUID(),
      offerId: randomUUID(),
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
        `ZM-P7-${fixture.transactionId.slice(0, 8)}`,
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
        `PHASE7-${fixture.transactionId.slice(0, 8)}`,
        `JO-EINV-P7-${fixture.transactionId.slice(0, 8)}`,
        `phase7-fixture-${fixture.transactionId}`,
      ],
    );
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
    await db.query(
      `INSERT INTO bank_eligibility (listing_id, bank_org_id, status, reason, rules_applied)
       VALUES ($1,$2,'ELIGIBLE','fixture','[]'::jsonb)`,
      [fixture.listingId, ORG.bankA],
    );
    await db.query(
      `INSERT INTO listing_fee_obligations (listing_id, supplier_org_id, amount, status)
       VALUES ($1,$2,25.000,'PAYABLE')`,
      [fixture.listingId, ORG.alNoor],
    );
    await db.query(
      `INSERT INTO bank_offers
         (id, listing_id, bank_org_id, status, version_number, transaction_type, recourse_type,
          gross_funding_amount, bank_discount_amount, bank_fees_amount,
          platform_commission_amount, listing_fee_amount, other_deductions_amount,
          net_supplier_payout, valid_until, created_by, approved_by, approved_at, submitted_at)
       VALUES ($1,$2,$3,'ACTIVE',1,'INVOICE_FINANCING','FULL_RECOURSE',
               $4,300.000,150.000,$5,$6,0.000,$7, now() + interval '30 days',
               '0e100000-0000-4000-8000-000000000005',
               '0e100000-0000-4000-8000-000000000006', now(), now())`,
      [fixture.offerId, fixture.listingId, ORG.bankA, GROSS, COMMISSION, LISTING_FEE, NET],
    );

    created.push(fixture);

    // Accepted through the API: this is the call that writes the snapshot and
    // the commission record, both of which are under test below.
    const accept = await api('supplier', 'post', `/offers/${fixture.offerId}/accept`);
    if (accept.status !== 200) {
      throw new Error(`Fixture acceptance failed: ${accept.status} ${JSON.stringify(accept.body)}`);
    }

    // Contract generation and signing are Phase 6's checkpoint, proved there
    // in full. Funding starts from CONTRACTED, so that is where this fixture
    // is placed.
    await db.query(
      `UPDATE receivable_transactions SET state = 'CONTRACTED' WHERE id = $1`,
      [fixture.transactionId],
    );

    return fixture;
  };

  /**
   * Removes what can be removed.
   *
   * `ledger_entries` is append-only (INV-7) and this phase writes to it, so
   * unlike Phase 6 these fixtures are *not* fully deletable — the journals
   * stay. That is the invariant working, not a leak: deleting them would
   * require the very UPDATE/DELETE path the append-only trigger exists to
   * refuse. The transaction rows they reference therefore also stay.
   */
  const cleanup = async (): Promise<void> => {
    for (const fixture of created) {
      await db.query('BEGIN');
      try {
        const { rows: hasLedger } = await db.query(
          `SELECT 1 FROM ledger_entries WHERE transaction_id = $1 LIMIT 1`,
          [fixture.transactionId],
        );
        if (hasLedger.length > 0) {
          // Leave the whole chain intact rather than half-deleting it.
          await db.query('ROLLBACK');
          continue;
        }
        await db.query('DELETE FROM funding_otp_events WHERE transaction_id = $1', [
          fixture.transactionId,
        ]);
        await db.query('DELETE FROM funding_otps WHERE transaction_id = $1', [
          fixture.transactionId,
        ]);
        await db.query('DELETE FROM commission_calculations WHERE transaction_id = $1', [
          fixture.transactionId,
        ]);
        await db.query('DELETE FROM accepted_offer_snapshots WHERE transaction_id = $1', [
          fixture.transactionId,
        ]);
        await db.query('DELETE FROM offer_selections WHERE listing_id = $1', [fixture.listingId]);
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
      if (!membership) {
        throw new Error(`${email} has no membership in ${expectedOrg}. Re-run db:seed.`);
      }
      orgs[persona] = membership.organizationId;
    }

    main = await buildContracted();
  }, 300_000);

  afterAll(async () => {
    if (db) {
      await cleanup().catch(() => undefined);
      await db.end();
    }
    await app?.close();
  }, 300_000);

  // -------------------------------------------------------------------
  // INV-5, first half — CALCULATED at acceptance
  // -------------------------------------------------------------------

  describe('INV-5 — the commission is calculated at acceptance, not finalized', () => {
    it('records the commission the moment the offer is accepted', async () => {
      const { rows } = await db.query<{ status: string; commission_amount: string; basis_amount: string }>(
        `SELECT status, commission_amount::text, basis_amount::text
           FROM commission_calculations WHERE transaction_id = $1`,
        [main.transactionId],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('CALCULATED');
      expect(rows[0].commission_amount).toBe(COMMISSION);
      // ZM-FEE-002: the basis is the gross funding amount, never the face value.
      expect(rows[0].basis_amount).toBe(GROSS);
    }, 30_000);

    it('leaves finalized_at null — no revenue is booked for an unpaid payout', async () => {
      const { rows } = await db.query<{ finalized_at: Date | null }>(
        `SELECT finalized_at FROM commission_calculations WHERE transaction_id = $1`,
        [main.transactionId],
      );
      expect(rows[0].finalized_at).toBeNull();
    }, 30_000);
  });

  // -------------------------------------------------------------------
  // INV-10 — the bank cannot fund alone
  // -------------------------------------------------------------------

  describe('INV-10 — FUNDED needs both parties', () => {
    it('lets the bank mark the transfer sent', async () => {
      const res = await api('bankOps', 'post', `/transactions/${main.transactionId}/funding/mark-sent`, {
        providerReference: 'WIRE-P7-001',
      });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('FUNDING_RECEIVED');
      expect(res.body.grossFundingAmount).toBe(GROSS);
      expect(res.body.netSupplierPayout).toBe(NET);
      settlementId = res.body.id;
    }, 60_000);

    it('does NOT reach FUNDED — the state is FUNDING_CONFIRMATION_PENDING', async () => {
      const { rows } = await db.query<{ state: string }>(
        `SELECT state FROM receivable_transactions WHERE id = $1`,
        [main.transactionId],
      );
      // This is the whole invariant. The bank has done everything it can do.
      expect(rows[0].state).toBe('FUNDING_CONFIRMATION_PENDING');
    }, 30_000);

    it('uses the settlement id as its own idempotency key (INV-13 by construction)', async () => {
      const { rows } = await db.query<{ id: string; idempotency_key: string }>(
        `SELECT id, idempotency_key FROM settlements WHERE transaction_id = $1`,
        [main.transactionId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].idempotency_key).toBe(rows[0].id);
    }, 30_000);

    it('absorbs a second mark-sent instead of creating a second settlement', async () => {
      const before = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ledger_entries WHERE transaction_id = $1`,
        [main.transactionId],
      );

      const res = await api('bankOps', 'post', `/transactions/${main.transactionId}/funding/mark-sent`, {
        providerReference: 'WIRE-P7-DUPLICATE',
      });

      // 200 with the existing settlement, not 409. The service is idempotent
      // by observation: a bank clicking twice has not made a mistake worth an
      // error, and what actually matters is that nothing happened twice.
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(settlementId);

      const { rows } = await db.query(`SELECT id FROM settlements WHERE transaction_id = $1`, [
        main.transactionId,
      ]);
      expect(rows).toHaveLength(1);

      // And no second journal — the real test of "nothing happened twice".
      const after = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ledger_entries WHERE transaction_id = $1`,
        [main.transactionId],
      );
      expect(after.rows[0].count).toBe(before.rows[0].count);
    }, 60_000);

    it('refuses mark-sent from a bank that is not the funding party', async () => {
      const other = await buildContracted();
      const res = await api('otherBank', 'post', `/transactions/${other.transactionId}/funding/mark-sent`, {});
      expect([403, 404]).toContain(res.status);
    }, 120_000);
  });

  // -------------------------------------------------------------------
  // ZM-FND-005/009 — the OTP
  // -------------------------------------------------------------------

  describe('the funding OTP', () => {
    let issuedCode: string;

    it('returns the plaintext code exactly once, to the bank', async () => {
      const res = await api('bankOps', 'post', `/transactions/${main.transactionId}/funding/otp`);
      expect(res.status).toBe(201);
      expect(res.body.otp).toMatch(/^\d{6}$/);
      expect(typeof res.body.expiresAt).toBe('string');
      issuedCode = res.body.otp;
    }, 60_000);

    it('never persists the plaintext anywhere (ZM-FND-005)', async () => {
      const { rows } = await db.query<Record<string, unknown>>(
        `SELECT * FROM funding_otps WHERE transaction_id = $1`,
        [main.transactionId],
      );
      expect(rows).toHaveLength(1);

      // Not "there is no column called otp" — every value in the row, so a
      // future column that happened to carry it would fail here too.
      const serialized = JSON.stringify(rows[0]);
      expect(serialized).not.toContain(issuedCode);
    }, 30_000);

    it('refuses the supplier a code — issuing it is the bank’s act', async () => {
      const res = await api('supplier', 'post', `/transactions/${main.transactionId}/funding/otp`);
      expect(res.status).toBe(403);
    }, 30_000);

    it('rejects a wrong code with attemptsRemaining and nothing else', async () => {
      const wrong = issuedCode === '000000' ? '111111' : '000000';
      const res = await api('supplier', 'post', `/transactions/${main.transactionId}/funding/confirm`, {
        otp: wrong,
      });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('OTP_INVALID');
      expect(typeof res.body.attemptsRemaining).toBe('number');

      // The failure must not leak the shape of the answer. Nothing in the
      // body may hint at expiry, prior use, or correctness.
      const body = JSON.stringify(res.body).toLowerCase();
      expect(body).not.toContain('expired');
      expect(body).not.toContain('already');
      expect(body).not.toContain(issuedCode);
    }, 60_000);

    it('reaches FUNDED on the correct code — the supplier’s half of INV-10', async () => {
      const res = await api('supplier', 'post', `/transactions/${main.transactionId}/funding/confirm`, {
        otp: issuedCode,
      });

      expect(res.status).toBe(200);
      expect(res.body.transactionState).toBe('FUNDED');

      const { rows } = await db.query<{ state: string }>(
        `SELECT state FROM receivable_transactions WHERE id = $1`,
        [main.transactionId],
      );
      expect(rows[0].state).toBe('FUNDED');
    }, 90_000);

    it('refuses the same code a second time, with the identical generic failure', async () => {
      const res = await api('supplier', 'post', `/transactions/${main.transactionId}/funding/confirm`, {
        otp: issuedCode,
      });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('OTP_INVALID');
    }, 60_000);
  });

  // -------------------------------------------------------------------
  // INV-5, second half — FINALIZED only on PAYOUT_COMPLETED
  // -------------------------------------------------------------------

  describe('INV-5 — finalized only once the payout completes', () => {
    it('completes the payout after funding', async () => {
      const res = await api('bankOps', 'get', `/transactions/${main.transactionId}/settlement`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('PAYOUT_COMPLETED');
      expect(res.body.payoutCompletedAt).toBeTruthy();
    }, 60_000);

    it('finalizes the commission, and only then', async () => {
      const { rows } = await db.query<{ status: string; finalized_at: Date | null }>(
        `SELECT status, finalized_at FROM commission_calculations WHERE transaction_id = $1`,
        [main.transactionId],
      );
      expect(rows[0].status).toBe('FINALIZED');
      expect(rows[0].finalized_at).not.toBeNull();
    }, 30_000);
  });

  // -------------------------------------------------------------------
  // INV-6 — every journal balances, and clearing nets to zero
  // -------------------------------------------------------------------

  describe('INV-6 — the ledger balances', () => {
    it('has no unbalanced journal for this transaction', async () => {
      const { rows } = await db.query<{ journal_id: string; difference: string }>(
        `SELECT journal_id,
                (SUM(CASE WHEN entry_type = 'DEBIT'  THEN amount ELSE 0 END)
               - SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE 0 END))::text AS difference
           FROM ledger_entries
          WHERE transaction_id = $1
          GROUP BY journal_id
         HAVING SUM(CASE WHEN entry_type = 'DEBIT'  THEN amount ELSE 0 END)
              <> SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE 0 END)`,
        [main.transactionId],
      );
      expect(rows).toEqual([]);
    }, 30_000);

    it('posted more than one journal — funding received, then distribution, then payout', async () => {
      const { rows } = await db.query<{ count: string }>(
        `SELECT count(DISTINCT journal_id)::text AS count
           FROM ledger_entries WHERE transaction_id = $1`,
        [main.transactionId],
      );
      expect(Number(rows[0].count)).toBeGreaterThanOrEqual(2);
    }, 30_000);

    it('nets every clearing account to exactly zero once the payout completes', async () => {
      const { rows } = await db.query<{ account_kind: string; balance: string }>(
        `SELECT account_kind,
                (SUM(CASE WHEN entry_type = 'DEBIT'  THEN amount ELSE 0 END)
               - SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE 0 END))::text AS balance
           FROM ledger_entries
          WHERE transaction_id = $1 AND account_kind::text LIKE '%CLEARING%'
          GROUP BY account_kind`,
        [main.transactionId],
      );

      // Money that arrived and left leaves no residue. A non-zero clearing
      // balance means the platform is holding funds it does not know about —
      // the single most important thing this ledger exists to make impossible.
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(Number(row.balance)).toBe(0);
      }
    }, 30_000);

    it('posts what actually moves, not the headline gross', async () => {
      // Gross 9000 less the bank's own discount (300) and fees (150) is
      // 8550 — the amount the platform distributes. Posting 9000 would strand
      // 450 in clearing forever, which is exactly the bug this asserts against.
      const { rows } = await db.query<{ total: string }>(
        `SELECT COALESCE(SUM(amount), 0)::text AS total
           FROM ledger_entries
          WHERE transaction_id = $1 AND entry_type = 'DEBIT'
            AND account_kind::text LIKE '%CLEARING%'`,
        [main.transactionId],
      );
      expect(rows[0].total).toBe(DISTRIBUTABLE);
    }, 30_000);

    it('is append-only — an UPDATE on a posted entry changes nothing (INV-7)', async () => {
      const { rows } = await db.query<{ id: string; amount: string }>(
        `SELECT id, amount::text FROM ledger_entries WHERE transaction_id = $1 LIMIT 1`,
        [main.transactionId],
      );

      // The schema enforces this with `CREATE RULE … DO INSTEAD NOTHING`, not
      // a raising trigger, so the write is *discarded* rather than refused.
      // That is a stronger guarantee than an error, and it is also quieter —
      // which is exactly why it deserves a test: nothing would tell you.
      const attempt = await db.query(
        `UPDATE ledger_entries SET amount = amount + 1 WHERE id = $1`,
        [rows[0].id],
      );
      expect(attempt.rowCount).toBe(0);

      const after = await db.query<{ amount: string }>(
        `SELECT amount::text FROM ledger_entries WHERE id = $1`,
        [rows[0].id],
      );
      expect(after.rows[0].amount).toBe(rows[0].amount);
    }, 30_000);
  });

  // -------------------------------------------------------------------
  // INV-13 — a retried settlement never pays twice
  // -------------------------------------------------------------------

  describe('INV-13 — concurrent retries produce exactly one payout', () => {
    it(`survives ${RETRY_ITERATIONS} rounds of two simultaneous retries`, async () => {
      const before = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM settlement_attempts WHERE settlement_id = $1`,
        [settlementId],
      );

      for (let i = 0; i < RETRY_ITERATIONS; i += 1) {
        // Two retries fired at the same instant with *different* keys, so the
        // idempotency interceptor cannot be what saves this — the row lock has
        // to be. Both must resolve, and neither may produce a second payout.
        const [a, b] = await Promise.all([
          api('bankOps', 'post', `/settlements/${settlementId}/retry`),
          api('bankOps', 'post', `/settlements/${settlementId}/retry`),
        ]);
        expect([200, 409]).toContain(a.status);
        expect([200, 409]).toContain(b.status);
      }

      const after = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM settlement_attempts WHERE settlement_id = $1`,
        [settlementId],
      );

      // The settlement was already PAYOUT_COMPLETED, so no retry may reach
      // the rail at all: the attempt count must not have moved.
      expect(after.rows[0].count).toBe(before.rows[0].count);
    }, 180_000);

    it('still reports exactly one completed payout afterwards', async () => {
      const { rows } = await db.query<{ status: string; retry_count: number; payout_completed_at: Date }>(
        `SELECT status, retry_count, payout_completed_at FROM settlements WHERE id = $1`,
        [settlementId],
      );
      expect(rows[0].status).toBe('PAYOUT_COMPLETED');
      expect(rows[0].payout_completed_at).not.toBeNull();
    }, 30_000);

    it('posted no fourth journal — funding, distribution, payout, and nothing else', async () => {
      const { rows } = await db.query<{ count: string }>(
        `SELECT count(DISTINCT journal_id)::text AS count
           FROM ledger_entries WHERE settlement_id = $1`,
        [settlementId],
      );
      // Three journals is the whole life of a settled transaction. A second
      // payout would appear here as a fourth, whatever its description said.
      expect(Number(rows[0].count)).toBe(3);
    }, 30_000);
  });

  // -------------------------------------------------------------------
  // Hard rule 3 — the supplier's floor never reaches a bank
  // -------------------------------------------------------------------

  describe('INV-8 — minimumAcceptableAmount never reaches a bank', () => {
    it('is absent from every funding response the bank receives', async () => {
      const settlement = await api('bankOps', 'get', `/transactions/${main.transactionId}/settlement`);
      const markSentRetry = await api(
        'bankOps',
        'post',
        `/transactions/${main.transactionId}/funding/mark-sent`,
        {},
      );

      for (const res of [settlement, markSentRetry]) {
        const body = JSON.stringify(res.body);
        expect(body).not.toContain('minimumAcceptableAmount');
        expect(body).not.toContain('minimum_acceptable_amount');
        // The fixture's floor is 5000.000. Its absence by value as well as by
        // name catches a leak under a renamed field.
        expect(body).not.toContain('5000.000');
      }
    }, 90_000);
  });

  // -------------------------------------------------------------------
  // AS-04 — a stalled confirmation escalates to Operations Admin
  // -------------------------------------------------------------------

  describe('AS-04 — stalled confirmation escalates, and not to the super admin', () => {
    it('escalates a confirmation left pending past the window', async () => {
      const stalled = await buildContracted();
      await api('bankOps', 'post', `/transactions/${stalled.transactionId}/funding/mark-sent`, {
        providerReference: 'WIRE-STALLED',
      });

      // Age the transfer past the escalation window rather than waiting a day.
      await db.query(
        `UPDATE settlements SET bank_marked_sent_at = now() - interval '30 hours'
          WHERE transaction_id = $1`,
        [stalled.transactionId],
      );

      const result = await app.get(FundingDeadlinesService).sweep();
      expect(result.escalated).toBeGreaterThanOrEqual(1);

      // Asserted per *recipient*, not per role in the union of their roles.
      // The seeded operations admin also holds PLATFORM_SUPER_ADMIN on the
      // same membership, so "no super admin was notified" would be false for
      // a correct implementation. What AS-04 actually requires is that every
      // recipient was chosen for being an operations admin.
      const { rows } = await db.query<{ recipient: string; is_ops: boolean }>(
        `SELECT n.recipient_user_id AS recipient,
                EXISTS (
                  SELECT 1
                    FROM organization_memberships m
                    JOIN membership_roles r ON r.membership_id = m.id
                   WHERE m.user_id = n.recipient_user_id
                     AND m.status = 'ACTIVE'
                     AND r.role = 'PLATFORM_OPS_ADMIN'
                ) AS is_ops
           FROM notifications n
          WHERE n.transaction_id = $1
            AND n.template_key = 'FUNDING_CONFIRMATION_ESCALATED'`,
        [stalled.transactionId],
      );

      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.is_ops).toBe(true);
      }
    }, 240_000);
  });
});
