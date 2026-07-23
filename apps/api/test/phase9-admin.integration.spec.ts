import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { AppConfig } from '../src/config/configuration';

/**
 * Phase 9 — the admin surface, cancellation, and relisting, live.
 *
 * Six contract paths that took the coverage to 83/83: settings (read/patch),
 * commission tiers (read/create), the audit trail, the relisting approval, and
 * the two supplier lifecycle actions (cancel, relist-request). The behaviours
 * worth proving against the real database are the ones a fake DB cannot see —
 * a settings PATCH that must reject an unknown key and audit a known one, a
 * relisting request the `uq_open_relisting_request` index refuses to duplicate,
 * and a cancel whose stage policy is enforced by the service rather than the
 * state machine.
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

describeIfDb('Phase 9 — admin surface, cancel, relisting', () => {
  let app: INestApplication;
  let db: Client;
  let prefix: string;
  const tokens: Record<string, string> = {};
  const orgs: Record<string, string> = {};
  const createdTransactions: string[] = [];
  let originalReminderDays: unknown;

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

  const api = (persona: string, method: 'get' | 'post' | 'patch', path: string, body?: unknown): request.Test => {
    const req = request(app.getHttpServer())[method](`${prefix}${path}`)
      .set('Authorization', `Bearer ${tokens[persona]}`)
      .set('X-Organization-Id', orgs[persona]);
    return body === undefined ? req : req.send(body as object);
  };

  /** A transaction directly in a given state, owned by Al-Noor. */
  const buildTx = async (state: string): Promise<string> => {
    const id = randomUUID();
    const { rows: buyers } = await db.query<{ id: string }>(
      `SELECT id FROM buyers WHERE national_establishment_no = $1`,
      [BUYER_ESTABLISHMENT],
    );
    await db.query(
      `INSERT INTO receivable_transactions
         (id, reference_number, supplier_org_id, buyer_id, state, minimum_acceptable_amount, created_by)
       VALUES ($1,$2,$3,$4,$5::transaction_state,'5000.000',$6)`,
      [id, `ZM-P9A-${id.slice(0, 8)}`, ORG.alNoor, buyers[0].id, state, AL_NOOR_OWNER],
    );
    createdTransactions.push(id);
    return id;
  };

  const stateOf = async (id: string): Promise<string> => {
    const { rows } = await db.query<{ state: string }>(
      `SELECT state FROM receivable_transactions WHERE id = $1`,
      [id],
    );
    return rows[0]?.state;
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
      ['admin', 'admin@platform.zimmamless.test', ORG.platform],
      ['support', 'multi@platform.zimmamless.test', ORG.platform],
    ] as const) {
      tokens[persona] = await login(email);
      orgs[persona] = org;
    }

    const row = await db.query<{ value: unknown }>(
      `SELECT value FROM platform_settings WHERE key = 'maturity_reminder_days'`,
    );
    originalReminderDays = row.rows[0]?.value;
  }, 120_000);

  afterAll(async () => {
    // Restore the one setting the tests write, so the shared DB is left as found.
    if (db && originalReminderDays !== undefined) {
      await db
        .query(`UPDATE platform_settings SET value = $1::jsonb WHERE key = 'maturity_reminder_days'`, [
          JSON.stringify(originalReminderDays),
        ])
        .catch(() => undefined);
    }
    for (const id of createdTransactions) {
      await db.query('DELETE FROM relisting_requests WHERE transaction_id = $1', [id]).catch(() => undefined);
      await db.query('DELETE FROM status_history WHERE entity_id = $1', [id]).catch(() => undefined);
      await db.query('DELETE FROM audit_logs WHERE target_entity_id = $1', [id]).catch(() => undefined);
      await db.query('DELETE FROM bank_offers WHERE listing_id IN (SELECT id FROM listings WHERE transaction_id = $1)', [id]).catch(() => undefined);
      await db.query('DELETE FROM listings WHERE transaction_id = $1', [id]).catch(() => undefined);
      await db.query('DELETE FROM receivable_transactions WHERE id = $1', [id]).catch(() => undefined);
    }
    if (db) await db.end();
    await app?.close();
  }, 120_000);

  describe('settings', () => {
    it('returns the settings map to platform staff', async () => {
      const res = await api('admin', 'get', '/admin/settings');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('maturity_reminder_days');
      expect(res.body).toHaveProperty('demo_time_machine_enabled');
    }, 60_000);

    it('refuses the settings map to a supplier', async () => {
      const res = await api('supplier', 'get', '/admin/settings');
      expect([403, 404]).toContain(res.status);
    }, 60_000);

    it('patches a known key and audits the change', async () => {
      const res = await api('admin', 'patch', '/admin/settings', { maturity_reminder_days: [30, 14, 7, 3] });
      expect(res.status).toBe(200);
      expect(res.body.maturity_reminder_days).toEqual([30, 14, 7, 3]);

      const audit = await db.query(
        `SELECT 1 FROM audit_logs WHERE action_type = 'PLATFORM_SETTING_UPDATED'
           AND new_value->>'key' = 'maturity_reminder_days' ORDER BY occurred_at DESC LIMIT 1`,
      );
      expect(audit.rows.length).toBe(1);
    }, 60_000);

    it('rejects an unknown setting key rather than inventing it', async () => {
      const res = await api('admin', 'patch', '/admin/settings', { not_a_real_setting: true });
      expect(res.status).toBe(422);
    }, 60_000);

    it('refuses a PATCH from a read-only support role', async () => {
      const res = await api('support', 'patch', '/admin/settings', { maturity_reminder_days: [30] });
      expect(res.status).toBe(403);
    }, 60_000);
  });

  describe('commission tiers', () => {
    it('lists tiers to platform staff', async () => {
      const res = await api('admin', 'get', '/admin/commission-tiers');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    }, 60_000);

    it('creates a tier for a super admin, with money as 3-dp strings', async () => {
      const res = await api('admin', 'post', '/admin/commission-tiers', {
        minTransactionAmount: '0.000',
        maxTransactionAmount: '50000.000',
        commissionPercentage: 2.5,
        fixedCommissionAmount: '10.000',
        feePayer: 'SUPPLIER',
      });
      expect(res.status).toBe(201);
      expect(res.body.minTransactionAmount).toBe('0.000');
      expect(res.body.isActive).toBe(true);
      await db.query('DELETE FROM commission_tiers WHERE id = $1', [res.body.id]);
    }, 60_000);

    it('refuses tier creation to a non-super-admin', async () => {
      const res = await api('support', 'post', '/admin/commission-tiers', {
        minTransactionAmount: '0.000',
        commissionPercentage: 1,
        feePayer: 'SUPPLIER',
      });
      expect(res.status).toBe(403);
    }, 60_000);

    it('rejects a tier whose max is below its min', async () => {
      const res = await api('admin', 'post', '/admin/commission-tiers', {
        minTransactionAmount: '100.000',
        maxTransactionAmount: '50.000',
        commissionPercentage: 1,
        feePayer: 'SUPPLIER',
      });
      expect(res.status).toBe(422);
    }, 60_000);
  });

  describe('audit logs', () => {
    it('returns a paginated trail to platform staff', async () => {
      const res = await api('admin', 'get', '/admin/audit-logs?page=1&pageSize=5');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.items)).toBe(true);
      expect(res.body.items.length).toBeLessThanOrEqual(5);
      expect(res.body.pagination).toHaveProperty('total');
      for (const item of res.body.items) {
        expect(item).toHaveProperty('actionType');
        expect(item).toHaveProperty('occurredAt');
      }
    }, 60_000);

    it('refuses the audit trail to a supplier', async () => {
      const res = await api('supplier', 'get', '/admin/audit-logs');
      expect([403, 404]).toContain(res.status);
    }, 60_000);
  });

  describe('supplier cancellation (§16.8)', () => {
    it('cancels a DRAFT and records CANCELLED, not a delete', async () => {
      const created = await api('supplier', 'post', '/transactions');
      expect(created.status).toBe(201);
      const id = created.body.id as string;
      createdTransactions.push(id);

      const res = await api('supplier', 'post', `/transactions/${id}/cancel`, {
        reason: 'Changed my mind.',
      });
      expect(res.status).toBe(200);
      expect(await stateOf(id)).toBe('CANCELLED');
      // Still there — a record, not a deletion.
      const still = await db.query('SELECT 1 FROM receivable_transactions WHERE id = $1', [id]);
      expect(still.rows.length).toBe(1);
    }, 60_000);

    it('is idempotent — cancelling a cancelled transaction returns it unchanged', async () => {
      const created = await api('supplier', 'post', '/transactions');
      const id = created.body.id as string;
      createdTransactions.push(id);
      await api('supplier', 'post', `/transactions/${id}/cancel`);
      const res = await api('supplier', 'post', `/transactions/${id}/cancel`);
      expect(res.status).toBe(200);
      expect(await stateOf(id)).toBe('CANCELLED');
    }, 60_000);

    it('refuses to unilaterally cancel once an offer is accepted (409)', async () => {
      const id = await buildTx('OFFER_ACCEPTED');
      const res = await api('supplier', 'post', `/transactions/${id}/cancel`);
      expect(res.status).toBe(409);
      expect(await stateOf(id)).toBe('OFFER_ACCEPTED');
    }, 60_000);
  });

  describe('relisting request and approval', () => {
    let relistingId: string;

    it('raises a REQUESTED relisting request, never an approval', async () => {
      const id = await buildTx('OFFER_ACCEPTED');
      const res = await api('supplier', 'post', `/transactions/${id}/relist-request`, {
        notes: 'The bank withdrew; I would like to relist.',
      });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('REQUESTED');
      relistingId = res.body.id as string;
    }, 60_000);

    it('refuses a second open request on the same transaction (409)', async () => {
      const { rows } = await db.query<{ transaction_id: string }>(
        `SELECT transaction_id FROM relisting_requests WHERE id = $1`,
        [relistingId],
      );
      const res = await api('supplier', 'post', `/transactions/${rows[0].transaction_id}/relist-request`);
      expect(res.status).toBe(409);
    }, 60_000);

    it('approves the request for a platform admin, and is idempotent', async () => {
      const res = await api('admin', 'post', `/admin/relisting-requests/${relistingId}/approve`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('APPROVED');

      const again = await api('admin', 'post', `/admin/relisting-requests/${relistingId}/approve`);
      expect(again.status).toBe(200);
      expect(again.body.status).toBe('APPROVED');
    }, 60_000);

    it('refuses approval to a supplier', async () => {
      const res = await api('supplier', 'post', `/admin/relisting-requests/${relistingId}/approve`);
      expect([403, 404]).toContain(res.status);
    }, 60_000);
  });
});
