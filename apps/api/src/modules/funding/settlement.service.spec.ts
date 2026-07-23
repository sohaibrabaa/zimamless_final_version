import { SettlementService } from './settlement.service';
import { DummySettlementProvider, PayoutRequest } from './settlement.provider';
import { FixedTimeProvider } from '../../common/time/time.provider';
import { Money } from '../../common/money/money';
import type { SettlementRow } from './funding.service';

/**
 * INV-13 — a retried settlement never pays twice.
 *
 * The concurrent drill against a real database lives in the integration suite;
 * these pin the decision logic that drill depends on, plus the provider's own
 * idempotency contract.
 */

const SETTLEMENT_ID = '44444444-4444-4444-8444-444444444444';
const TX = '55555555-5555-4555-8555-555555555555';
const SNAPSHOT = '66666666-6666-4666-8666-666666666666';

function settlementRow(overrides: Partial<SettlementRow> = {}): SettlementRow {
  return {
    id: SETTLEMENT_ID,
    transaction_id: TX,
    snapshot_id: SNAPSHOT,
    status: 'FUNDING_RECEIVED',
    gross_funding_amount: '9000.000',
    platform_commission_amount: '135.000',
    listing_fee_deducted: '25.000',
    net_supplier_payout: '8390.000',
    provider_name: 'DUMMY',
    provider_reference: null,
    idempotency_key: SETTLEMENT_ID,
    bank_marked_sent_at: new Date('2026-07-23T09:00:00.000Z'),
    bank_marked_sent_by: 'bank-user',
    funding_received_at: new Date('2026-07-23T09:00:00.000Z'),
    payout_initiated_at: null,
    payout_completed_at: null,
    retry_count: 0,
    max_retries: 3,
    failure_reason: null,
    ...overrides,
  };
}

/** Enough of the database for the payout decision path. */
class FakeDb {
  row: SettlementRow = settlementRow();
  attempts: { attemptNo: number; succeeded: boolean }[] = [];
  journals: string[] = [];

  query = jest.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM settlements WHERE id')) return { rows: [this.row], rowCount: 1 };
    if (sql.includes('UPDATE settlements')) {
      if (sql.includes("status = 'PAYOUT_INITIATED'")) {
        this.row = { ...this.row, status: 'PAYOUT_INITIATED', payout_initiated_at: params[1] as Date };
      } else if (sql.includes("status = 'PAYOUT_COMPLETED'")) {
        this.row = {
          ...this.row,
          status: 'PAYOUT_COMPLETED',
          payout_completed_at: params[1] as Date,
          provider_reference: (params[2] as string) ?? this.row.provider_reference,
        };
      } else {
        this.row = {
          ...this.row,
          status: params[1] as string,
          retry_count: params[2] as number,
          failure_reason: params[3] as string,
        };
      }
      return { rows: [this.row], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO settlement_attempts')) {
      this.attempts.push({ attemptNo: params[1] as number, succeeded: params[4] as boolean });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO ledger_entries')) {
      this.journals.push(String(params[2]));
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  queryOne = jest.fn(async (sql: string) => {
    if (sql.includes('accepted_offer_snapshots')) {
      return { supplier_org_id: 'supplier-org', bank_org_id: 'bank-org' };
    }
    if (sql.includes('FROM settlements')) return this.row;
    return null;
  });

  transaction = jest.fn(async (fn: (c: unknown) => Promise<unknown>) => fn(this));
}

function build() {
  const db = new FakeDb();
  const time = new FixedTimeProvider(new Date('2026-07-23T10:00:00.000Z'));
  const ledger = {
    post: jest.fn(async (_c: unknown, journal: { lines: { accountKind: string }[] }) => {
      db.journals.push(journal.lines.map((l) => l.accountKind).join('+'));
      return 'journal-id';
    }),
  };
  const audit = { recordIn: jest.fn(async () => undefined) };
  const provider = {
    name: 'DUMMY',
    execute: jest.fn(async (req: PayoutRequest) => ({
      succeeded: true,
      providerReference: `REF-${req.attemptNo}`,
      failureReason: null,
      raw: {},
    })),
  };
  const service = new SettlementService(
    db as never,
    ledger as never,
    audit as never,
    provider as never,
    time,
  );
  return { db, service, provider, ledger };
}

describe('INV-13 — a settlement never pays twice', () => {
  it('pays once on the happy path and posts both remaining journals', async () => {
    const { db, service, provider } = build();
    const result = await service.executePayout(SETTLEMENT_ID);

    expect(provider.execute).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('PAYOUT_COMPLETED');
    expect(db.attempts).toEqual([{ attemptNo: 1, succeeded: true }]);
    // Distribution, then payout-completed.
    expect(db.journals).toHaveLength(2);
  });

  it('does NOT call the rail again for an already-completed settlement', async () => {
    const { db, service, provider } = build();
    await service.executePayout(SETTLEMENT_ID);
    expect(provider.execute).toHaveBeenCalledTimes(1);

    // Retrying a completed settlement is a no-op, not an error.
    const again = await service.executePayout(SETTLEMENT_ID);
    expect(provider.execute).toHaveBeenCalledTimes(1);
    expect(again.status).toBe('PAYOUT_COMPLETED');
    // And crucially, no second payout journal.
    expect(db.journals).toHaveLength(2);
  });

  it('declines to start a second attempt while one is in flight', async () => {
    const { service, provider } = build();
    // Simulate the window: the row is claimed but the rail has not answered.
    const db = (service as unknown as { db: FakeDb }).db;
    db.row = settlementRow({ status: 'PAYOUT_INITIATED' });

    const result = await service.executePayout(SETTLEMENT_ID);
    expect(provider.execute).not.toHaveBeenCalled();
    expect(result.status).toBe('PAYOUT_INITIATED');
  });

  it('presents the settlement id as the idempotency key on every attempt', async () => {
    const { service, provider } = build();
    await service.executePayout(SETTLEMENT_ID);
    const request = provider.execute.mock.calls[0][0] as PayoutRequest;
    expect(request.idempotencyKey).toBe(SETTLEMENT_ID);
  });

  it('refuses to pay out when the bank never marked the transfer sent', async () => {
    const { db, service, provider } = build();
    db.row = settlementRow({ bank_marked_sent_at: null, status: 'PENDING' });

    await expect(service.executePayout(SETTLEMENT_ID)).rejects.toThrow(/nothing to pay out/);
    expect(provider.execute).not.toHaveBeenCalled();
  });
});

describe('payout failure and escalation (AS-03)', () => {
  function failingBuild(failureReason = 'RAIL_DOWN') {
    const base = build();
    base.provider.execute = jest.fn(async () => ({
      succeeded: false,
      providerReference: null,
      failureReason,
      raw: {},
    })) as never;
    return base;
  }

  it('records PAYOUT_FAILED and counts the attempt', async () => {
    const { db, service } = failingBuild();
    const result = await service.executePayout(SETTLEMENT_ID);

    expect(result.status).toBe('PAYOUT_FAILED');
    expect(result.retry_count).toBe(1);
    expect(db.attempts).toEqual([{ attemptNo: 1, succeeded: false }]);
    // No journals: nothing moved, so nothing is posted.
    expect(db.journals).toHaveLength(0);
  });

  it('escalates to MANUAL_REVIEW once the retry allowance is spent', async () => {
    const { db, service } = failingBuild();
    db.row = settlementRow({ retry_count: 2, max_retries: 3, status: 'PAYOUT_FAILED' });

    const result = await service.executePayout(SETTLEMENT_ID);
    expect(result.status).toBe('MANUAL_REVIEW');
    expect(result.retry_count).toBe(3);
  });

  it('treats a thrown rail as a failed attempt, not an unhandled error', async () => {
    const { db, service } = build();
    (service as unknown as { provider: { execute: jest.Mock } }).provider.execute = jest.fn(
      async () => {
        throw new Error('socket hang up');
      },
    );

    const result = await service.executePayout(SETTLEMENT_ID);
    expect(result.status).toBe('PAYOUT_FAILED');
    expect(result.failure_reason).toContain('socket hang up');
    expect(db.attempts).toHaveLength(1);
  });
});

describe('the dummy rail honours idempotency like a real one', () => {
  const request: PayoutRequest = {
    idempotencyKey: SETTLEMENT_ID,
    netPayout: Money.from('8390.000'),
    commission: Money.from('135.000'),
    listingFee: Money.from('25.000'),
    supplierOrgId: 'supplier',
    bankOrgId: 'bank',
    attemptNo: 1,
  };

  function provider() {
    const db = { query: jest.fn(async () => ({ rows: [], rowCount: 0 })) };
    return new DummySettlementProvider(db as never);
  }

  it('returns the SAME reference for a repeated key, and marks it replayed', async () => {
    const rail = provider();
    const first = await rail.execute(request);
    const second = await rail.execute({ ...request, attemptNo: 2 });

    expect(second.succeeded).toBe(true);
    expect(second.providerReference).toBe(first.providerReference);
    expect(second.raw.replayed).toBe(true);
  });

  it('issues different references for different settlements', async () => {
    const rail = provider();
    const a = await rail.execute(request);
    const b = await rail.execute({ ...request, idempotencyKey: TX });
    expect(a.providerReference).not.toBe(b.providerReference);
  });
});
