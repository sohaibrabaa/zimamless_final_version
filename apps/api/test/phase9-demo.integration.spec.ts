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
 * Phase 9 — the demo time machine (ZM-DEMO-003/004).
 *
 * The behaviour that matters, live against the hosted database: a funded
 * transaction whose due date is still in the future does **not** mature on its
 * own, and then a forward jump of the demo clock makes the very next maturity
 * sweep move it to `OVERDUE_UNCONFIRMED` — never `OVERDUE`. That is the whole
 * point of the time machine: it lets a judge watch weeks pass in seconds while
 * every date decision in the domain moves together, because the offset is
 * applied in one place (`SystemTimeProvider.now()`) and nothing in the domain
 * reads a wall clock.
 *
 * The guards are tested as first-class behaviour, not an afterthought: the
 * endpoint is a 404 to anyone until the platform setting arms it, and a 403 to
 * a supplier even when it is armed.
 */

const connectionString = process.env.DATABASE_URL;
const SUPABASE = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
const ANON = process.env.SUPABASE_ANON_KEY ?? '';
const PASSWORD = process.env.SEED_USER_PASSWORD ?? 'Zimmamless#2026';

const describeIfDb = connectionString && SUPABASE && ANON ? describe : describe.skip;

const ORG = {
  alNoor: '0e000000-0000-4000-8000-000000000002',
  platform: '0e000000-0000-4000-8000-000000000001',
};
const AL_NOOR_OWNER = '0e100000-0000-4000-8000-000000000001';
const BUYER_ESTABLISHMENT = '30000201';

describeIfDb('Phase 9 — demo time machine', () => {
  let app: INestApplication;
  let db: Client;
  let prefix: string;
  const tokens: Record<string, string> = {};
  const orgs: Record<string, string> = {};
  const createdTransactions: string[] = [];

  let futureTx: string;

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

  const api = (persona: string, method: 'get' | 'post', path: string, body?: unknown): request.Test => {
    const req = request(app.getHttpServer())[method](`${prefix}${path}`)
      .set('Authorization', `Bearer ${tokens[persona]}`)
      .set('X-Organization-Id', orgs[persona]);
    return body === undefined ? req : req.send(body as object);
  };

  /** A minimal FUNDED transaction whose invoice is due `dueInDays` from today. */
  const buildFunded = async (dueInDays: number): Promise<string> => {
    const transactionId = randomUUID();
    const { rows: buyers } = await db.query<{ id: string }>(
      `SELECT id FROM buyers WHERE national_establishment_no = $1`,
      [BUYER_ESTABLISHMENT],
    );
    if (buyers.length === 0) throw new Error('Buyer fixture missing — run db:seed.');

    await db.query(
      `INSERT INTO receivable_transactions
         (id, reference_number, supplier_org_id, buyer_id, state, minimum_acceptable_amount, created_by)
       VALUES ($1,$2,$3,$4,'FUNDED','5000.000',$5)`,
      [transactionId, `ZM-P9-${transactionId.slice(0, 8)}`, ORG.alNoor, buyers[0].id, AL_NOOR_OWNER],
    );
    await db.query(
      `INSERT INTO invoices
         (id, transaction_id, invoice_number, einvoice_identifier, issue_date, due_date,
          subtotal_amount, tax_amount, face_value, paid_amount, outstanding_amount, fingerprint)
       VALUES ($1,$2,$3,$4, CURRENT_DATE - 30, CURRENT_DATE + $5::integer,
               10000.000, 1600.000, 11600.000, 0, 11600.000, $6)`,
      [
        randomUUID(),
        transactionId,
        `PHASE9-${transactionId.slice(0, 8)}`,
        `JO-EINV-P9-${transactionId.slice(0, 8)}`,
        dueInDays,
        `phase9-fixture-${transactionId}`,
      ],
    );
    createdTransactions.push(transactionId);
    return transactionId;
  };

  const stateOf = async (id: string): Promise<string> => {
    const { rows } = await db.query<{ state: string }>(
      `SELECT state FROM receivable_transactions WHERE id = $1`,
      [id],
    );
    return rows[0]?.state;
  };

  const arm = (on: boolean) =>
    db.query(
      `UPDATE platform_settings SET value = $1::jsonb WHERE key = 'demo_time_machine_enabled'`,
      [JSON.stringify(on)],
    );

  const setOffset = async (days: number) => {
    await db.query(`INSERT INTO demo_time_offsets (offset_days, note) VALUES ($1,'test')`, [days]);
    await app.get(SystemTimeProvider).refresh();
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
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    for (const [persona, email, org] of [
      ['supplier', 'owner@alnoor.zimmamless.test', ORG.alNoor],
      ['platformOps', 'admin@platform.zimmamless.test', ORG.platform],
    ] as const) {
      tokens[persona] = await login(email);
      orgs[persona] = org;
    }

    // Start from a known, disarmed, zero-offset clock.
    await arm(false);
    await setOffset(0);

    // Due 30 days out: not overdue at real time.
    futureTx = await buildFunded(30);
  }, 120_000);

  afterAll(async () => {
    // Leave the demo clock exactly as it was found: disarmed and at zero. A
    // test that moved a shared clock and left it moved would silently break
    // every suite and the live server that runs against this same database.
    if (app) {
      await setOffset(0).catch(() => undefined);
      await arm(false).catch(() => undefined);
    }
    for (const id of createdTransactions) {
      await db.query('DELETE FROM status_history WHERE entity_id = $1', [id]).catch(() => undefined);
      await db.query('DELETE FROM notifications WHERE transaction_id = $1', [id]).catch(() => undefined);
      await db.query('DELETE FROM audit_logs WHERE target_entity_id = $1', [id]).catch(() => undefined);
      await db.query('DELETE FROM invoices WHERE transaction_id = $1', [id]).catch(() => undefined);
      await db.query('DELETE FROM receivable_transactions WHERE id = $1', [id]).catch(() => undefined);
    }
    if (db) await db.end();
    await app?.close();
  }, 120_000);

  describe('the guards', () => {
    it('is a 404 while the platform setting is disarmed, even to a platform admin', async () => {
      await arm(false);
      await app.get(SystemTimeProvider).refresh();
      const res = await api('platformOps', 'post', '/demo/time-travel', { offsetDays: 10 });
      expect(res.status).toBe(404);
    }, 60_000);

    it('is a 403 to a supplier once armed — a role wall, not just the env guard', async () => {
      await arm(true);
      await app.get(SystemTimeProvider).refresh();
      const res = await api('supplier', 'post', '/demo/time-travel', { offsetDays: 10 });
      expect(res.status).toBe(403);
    }, 60_000);

    it('rejects a non-integer offset', async () => {
      await arm(true);
      const res = await api('platformOps', 'post', '/demo/time-travel', { offsetDays: 1.5 });
      expect(res.status).toBe(400);
    }, 60_000);
  });

  describe('a forward jump drives the maturity sweep', () => {
    it('leaves a not-yet-due transaction FUNDED before any jump', async () => {
      await arm(true);
      await setOffset(0);
      await app.get(MaturityService).sweep();
      expect(await stateOf(futureTx)).toBe('FUNDED');
    }, 120_000);

    it('moves it to OVERDUE_UNCONFIRMED after jumping past its due date', async () => {
      const res = await api('platformOps', 'post', '/demo/time-travel', { offsetDays: 45 });
      expect(res.status).toBe(200);
      expect(res.body.offsetDays).toBe(45);

      // The controller refreshed the provider synchronously, so the sweep the
      // MaturityService runs now reads the moved clock.
      await app.get(MaturityService).sweep();
      expect(await stateOf(futureTx)).toBe('OVERDUE_UNCONFIRMED');
    }, 120_000);

    it('never passed through OVERDUE — the clock cannot manufacture a default', async () => {
      const { rows } = await db.query<{ new_status: string }>(
        `SELECT new_status FROM status_history WHERE entity_id = $1 AND entity_type = 'TRANSACTION'`,
        [futureTx],
      );
      const states = rows.map((r) => r.new_status);
      expect(states).toContain('OVERDUE_UNCONFIRMED');
      expect(states).not.toContain('OVERDUE');
    }, 60_000);

    it('returns the clock to real time when the offset is set back to 0', async () => {
      const res = await api('platformOps', 'post', '/demo/time-travel', { offsetDays: 0 });
      expect(res.status).toBe(200);
      expect(res.body.offsetDays).toBe(0);
      expect(app.get(SystemTimeProvider).currentOffsetDays()).toBe(0);
    }, 60_000);
  });
});
