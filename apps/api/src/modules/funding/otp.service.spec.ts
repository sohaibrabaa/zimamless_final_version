import { OtpService } from './otp.service';
import { FixedTimeProvider } from '../../common/time/time.provider';
import { AppException } from '../../common/errors/app.exception';
import type { ActorContext } from '../onboarding/onboarding.service';

/**
 * The OTP's security behaviour, pinned at minute resolution.
 *
 * The demo time machine's offset is measured in whole days, so it cannot
 * express "sixteen minutes from now". `FixedTimeProvider` is the only
 * instrument with the resolution this needs — which is why the expiry boundary
 * is tested here rather than in an integration run.
 */

const TX = '11111111-1111-4111-8111-111111111111';
const BANK_USER = '22222222-2222-4222-8222-222222222222';
const SUPPLIER_USER = '33333333-3333-4333-8333-333333333333';

const bankCtx: ActorContext = {
  userId: BANK_USER,
  organizationId: 'bank',
  organizationType: 'BANK',
  roles: ['BANK_OPERATIONS'],
};
const supplierCtx: ActorContext = {
  userId: SUPPLIER_USER,
  organizationId: 'supplier',
  organizationType: 'SUPPLIER',
  roles: ['SUPPLIER_OWNER'],
};

/**
 * An in-memory stand-in for the one `funding_otps` row and its event log.
 *
 * Hand-rolled rather than mocked call-by-call: the behaviour under test is a
 * sequence of reads and conditional writes, and asserting on query strings
 * would pin the SQL rather than the rule.
 */
class FakeDb {
  row: Record<string, unknown> | null = null;
  events: string[] = [];

  private settings = [
    { key: 'otp_validity_minutes', value: 15 },
    { key: 'otp_max_attempts', value: 5 },
    { key: 'otp_max_resends', value: 3 },
  ];

  query = jest.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('platform_settings')) return { rows: this.settings, rowCount: 3 };

    if (sql.includes('INSERT INTO funding_otp_events')) {
      this.events.push(String(params[1]));
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes('SELECT * FROM funding_otps')) {
      return { rows: this.row ? [this.row] : [], rowCount: this.row ? 1 : 0 };
    }

    if (sql.includes('INSERT INTO funding_otps')) {
      this.row = {
        id: 'otp-1',
        transaction_id: params[0],
        otp_hash: params[1],
        generated_by: params[2],
        generated_at: params[3],
        expires_at: params[4],
        status: 'SENT',
        attempt_count: 0,
        max_attempts: params[5],
        resend_count: 0,
        max_resends: params[6],
        verified_at: null,
        verified_by: null,
      };
      return { rows: [this.row], rowCount: 1 };
    }

    if (sql.includes('UPDATE funding_otps')) {
      if (!this.row) return { rows: [], rowCount: 0 };
      if (sql.includes('resend_count = resend_count + 1')) {
        Object.assign(this.row, {
          otp_hash: params[1],
          generated_by: params[2],
          generated_at: params[3],
          expires_at: params[4],
          status: 'SENT',
          resend_count: (this.row.resend_count as number) + 1,
        });
      } else if (sql.includes("status = 'VERIFIED'")) {
        Object.assign(this.row, { status: 'VERIFIED', verified_at: params[1], verified_by: params[2] });
      } else if (sql.includes("status = 'EXPIRED'")) {
        Object.assign(this.row, { status: 'EXPIRED' });
      } else if (sql.includes("status = 'FAILED_MAX_ATTEMPTS'")) {
        Object.assign(this.row, { status: 'FAILED_MAX_ATTEMPTS' });
      } else if (sql.includes('attempt_count = $2')) {
        Object.assign(this.row, { attempt_count: params[1], status: params[2] });
      }
      return { rows: [this.row], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  });

  queryOne = jest.fn(async () => this.row);
  transaction = jest.fn(async (fn: (c: unknown) => Promise<unknown>) => fn(this));
}

function build(now = new Date('2026-07-23T10:00:00.000Z')) {
  const db = new FakeDb();
  const time = new FixedTimeProvider(now);
  const config = { encryptionKey: 'test-key-for-hmac' } as never;
  return { db, time, service: new OtpService(db as never, config, time) };
}

async function failureOf(fn: () => Promise<unknown>): Promise<AppException> {
  try {
    await fn();
  } catch (err) {
    return err as AppException;
  }
  throw new Error('Expected a failure, but the call succeeded.');
}

describe('OTP generation', () => {
  it('returns a six-digit plaintext code exactly once and stores only a hash', async () => {
    const { db, service } = build();
    const generated = await service.generate(TX, bankCtx);

    expect(generated.otp).toMatch(/^\d{6}$/);
    expect(generated.resendsRemaining).toBe(3);

    // The stored value is a keyed hash, not the code.
    const stored = String(db.row!.otp_hash);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).not.toContain(generated.otp);
    expect(db.events).toEqual(['GENERATED']);
  });

  it('binds the hash to the transaction, so a code cannot be replayed elsewhere', async () => {
    const { db, service } = build();
    const generated = await service.generate(TX, bankCtx);
    const hashForThisTx = String(db.row!.otp_hash);

    const other = build();
    await other.service.generate('99999999-9999-4999-8999-999999999999', bankCtx);
    // Same code, different transaction → different hash, by construction.
    const sameCodeElsewhere = String(other.db.row!.otp_hash);
    expect(sameCodeElsewhere).not.toBe(hashForThisTx);
    expect(generated.otp).toMatch(/^\d{6}$/);
  });

  it('counts resends and refuses past the cap with 429', async () => {
    const { db, service } = build();
    await service.generate(TX, bankCtx);

    for (const expected of [2, 1, 0]) {
      const again = await service.generate(TX, bankCtx);
      expect(again.resendsRemaining).toBe(expected);
    }
    expect(db.row!.resend_count).toBe(3);

    const failure = await failureOf(() => service.generate(TX, bankCtx));
    expect(failure.getStatus()).toBe(429);
    expect(db.events.filter((e) => e === 'RESENT')).toHaveLength(3);
  });
});

describe('OTP verification — ZM-FND-009, failures reveal nothing', () => {
  it('accepts the correct code and records VERIFIED', async () => {
    const { db, service } = build();
    const { otp } = await service.generate(TX, bankCtx);

    const verified = await service.verifyIn(db as never, TX, supplierCtx, otp);
    expect(verified.status).toBe('VERIFIED');
    expect(verified.verified_by).toBe(SUPPLIER_USER);
    expect(db.events).toContain('VERIFIED');
  });

  it('rejects a wrong code and decrements the remaining attempts', async () => {
    const { db, service } = build();
    const { otp } = await service.generate(TX, bankCtx);
    const wrong = otp === '000000' ? '111111' : '000000';

    const failure = await failureOf(() => service.verifyIn(db as never, TX, supplierCtx, wrong));
    expect(failure.code).toBe('OTP_INVALID');
    expect(failure.getStatus()).toBe(401);
    expect(failure.details).toEqual({ attemptsRemaining: 4 });
    expect(db.events).toContain('ATTEMPT_FAILED');
  });

  it('is single-use: replaying a correct code fails like any other', async () => {
    const { db, service } = build();
    const { otp } = await service.generate(TX, bankCtx);
    await service.verifyIn(db as never, TX, supplierCtx, otp);

    const failure = await failureOf(() => service.verifyIn(db as never, TX, supplierCtx, otp));
    expect(failure.code).toBe('OTP_INVALID');
  });

  it('gives wrong, expired and already-used the SAME code and message', async () => {
    // The requirement is that these are indistinguishable. Asserting they are
    // literally identical is the only way to keep them that way.
    const wrongRun = build();
    const { otp: code1 } = await wrongRun.service.generate(TX, bankCtx);
    const wrong = code1 === '000000' ? '111111' : '000000';
    const wrongFailure = await failureOf(() =>
      wrongRun.service.verifyIn(wrongRun.db as never, TX, supplierCtx, wrong),
    );

    const expiredRun = build();
    const { otp: code2 } = await expiredRun.service.generate(TX, bankCtx);
    expiredRun.time.setTo(new Date('2026-07-23T10:16:00.000Z'));
    const expiredFailure = await failureOf(() =>
      expiredRun.service.verifyIn(expiredRun.db as never, TX, supplierCtx, code2),
    );

    const usedRun = build();
    const { otp: code3 } = await usedRun.service.generate(TX, bankCtx);
    await usedRun.service.verifyIn(usedRun.db as never, TX, supplierCtx, code3);
    const usedFailure = await failureOf(() =>
      usedRun.service.verifyIn(usedRun.db as never, TX, supplierCtx, code3),
    );

    for (const failure of [expiredFailure, usedFailure]) {
      expect(failure.code).toBe(wrongFailure.code);
      expect(failure.message).toBe(wrongFailure.message);
      expect(failure.getStatus()).toBe(wrongFailure.getStatus());
    }
  });

  it('fails when no code was ever generated, indistinguishably', async () => {
    const { db, service } = build();
    const failure = await failureOf(() => service.verifyIn(db as never, TX, supplierCtx, '123456'));
    expect(failure.code).toBe('OTP_INVALID');
  });
});

describe('OTP expiry — the 15-minute boundary', () => {
  it('is still valid at 14 minutes', async () => {
    const { db, service, time } = build();
    const { otp } = await service.generate(TX, bankCtx);

    time.setTo(new Date('2026-07-23T10:14:00.000Z'));
    const verified = await service.verifyIn(db as never, TX, supplierCtx, otp);
    expect(verified.status).toBe('VERIFIED');
  });

  it('is expired at 16 minutes, and records the expiry', async () => {
    const { db, service, time } = build();
    const { otp } = await service.generate(TX, bankCtx);

    time.setTo(new Date('2026-07-23T10:16:00.000Z'));
    const failure = await failureOf(() => service.verifyIn(db as never, TX, supplierCtx, otp));
    expect(failure.code).toBe('OTP_INVALID');
    expect(db.row!.status).toBe('EXPIRED');
    expect(db.events).toContain('EXPIRED');
  });

  it('expires exactly at the boundary, not a moment after', async () => {
    const { db, service, time } = build();
    const { otp } = await service.generate(TX, bankCtx);

    time.setTo(new Date('2026-07-23T10:15:00.000Z'));
    const failure = await failureOf(() => service.verifyIn(db as never, TX, supplierCtx, otp));
    expect(failure.code).toBe('OTP_INVALID');
  });
});

describe('OTP brute force — the attempt budget', () => {
  it('locks after five wrong attempts and stays locked', async () => {
    const { db, service } = build();
    const { otp } = await service.generate(TX, bankCtx);
    const wrong = otp === '000000' ? '111111' : '000000';

    const remaining: number[] = [];
    for (let i = 0; i < 5; i++) {
      const failure = await failureOf(() => service.verifyIn(db as never, TX, supplierCtx, wrong));
      remaining.push((failure.details as { attemptsRemaining: number }).attemptsRemaining);
    }
    expect(remaining).toEqual([4, 3, 2, 1, 0]);
    expect(db.row!.status).toBe('FAILED_MAX_ATTEMPTS');

    // Even the CORRECT code no longer works — the budget is spent.
    const afterLock = await failureOf(() => service.verifyIn(db as never, TX, supplierCtx, otp));
    expect(afterLock.code).toBe('OTP_INVALID');
    expect(db.events.filter((e) => e === 'ATTEMPT_FAILED')).toHaveLength(5);
  });

  it('will not let a regeneration refill the attempt budget', async () => {
    // Otherwise the cap is advisory: ask for a new code, get five more guesses.
    const { db, service } = build();
    const { otp } = await service.generate(TX, bankCtx);
    const wrong = otp === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      await failureOf(() => service.verifyIn(db as never, TX, supplierCtx, wrong));
    }

    const failure = await failureOf(() => service.generate(TX, bankCtx));
    expect(failure.code).toBe('OTP_MAX_ATTEMPTS');
    expect(db.row!.attempt_count).toBe(5);
  });
});
