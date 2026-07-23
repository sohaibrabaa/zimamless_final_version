import { MaturityService } from './maturity.service';
import { FixedTimeProvider } from '../../common/time/time.provider';
import type { TransactionState } from '../transactions/transaction-state';

/**
 * The sweep, at service level.
 *
 * `maturity.spec.ts` proves the rule in the pure function. This proves the
 * service actually applies it — that what reaches the database is
 * `OVERDUE_UNCONFIRMED`, that a disputed transaction is left alone, and that
 * a payment landing mid-sweep wins over the job's stale snapshot.
 */

const TX = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SUPPLIER_ORG = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DUE = new Date('2026-08-30T00:00:00.000Z');

interface Notification {
  templateKey: string;
  body: string;
  subject: string;
}

class FakeDb {
  thresholds: unknown = [30, 14, 7];
  rows: {
    transaction_id: string;
    state: TransactionState;
    supplier_org_id: string;
    due_date: Date;
    invoice_number: string;
  }[] = [
    {
      transaction_id: TX,
      state: 'FUNDED',
      supplier_org_id: SUPPLIER_ORG,
      due_date: DUE,
      invoice_number: 'INV-2026-0042',
    },
  ];

  /** What the row-lock re-read returns; the sweep must trust this over its snapshot. */
  lockedState: TransactionState | null = null;

  sent: Notification[] = [];
  updates: { state: string }[] = [];
  history: { from: string; to: string; reason: string }[] = [];
  audits: { actionType: string; newValue: Record<string, unknown> }[] = [];

  query = jest.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM receivable_transactions t')) {
      return { rows: this.rows, rowCount: this.rows.length };
    }
    if (sql.includes('FOR UPDATE')) {
      const state = this.lockedState ?? this.rows[0]?.state;
      return { rows: state ? [{ state }] : [], rowCount: state ? 1 : 0 };
    }
    if (sql.includes('UPDATE receivable_transactions')) {
      const state = /state = '([A-Z_]+)'/.exec(sql)?.[1] ?? '';
      this.updates.push({ state });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO status_history')) {
      this.history.push({
        from: params[1] as string,
        to: 'OVERDUE_UNCONFIRMED',
        reason: params[2] as string,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('FROM organization_memberships')) {
      return { rows: [{ user_id: 'supplier-user' }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO notifications')) {
      this.sent.push({
        templateKey: params[0] as string,
        subject: params[2] as string,
        body: params[3] as string,
      });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  queryOne = jest.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('maturity_reminder_days')) return { value: this.thresholds };
    if (sql.includes('FROM notifications')) {
      return this.sent.some((n) => n.templateKey === params[0]) ? { one: 1 } : null;
    }
    return null;
  });

  transaction = jest.fn(async (fn: (c: unknown) => Promise<unknown>) => fn(this));
}

function build(at: string) {
  const db = new FakeDb();
  const audit = {
    recordIn: jest.fn(async (_c: unknown, entry: { actionType: string; newValue: unknown }) => {
      db.audits.push({
        actionType: entry.actionType,
        newValue: entry.newValue as Record<string, unknown>,
      });
    }),
  };
  const service = new MaturityService(db as never, audit as never, new FixedTimeProvider(new Date(at)));
  return { db, service };
}

describe('ZM-PMT-008..011 — the sweep never writes OVERDUE', () => {
  it('writes OVERDUE_UNCONFIRMED when the due date has passed', async () => {
    const { db, service } = build('2026-09-05T10:00:00.000Z');
    const result = await service.sweep();

    expect(result.markedUnconfirmed).toBe(1);
    expect(db.updates).toEqual([{ state: 'OVERDUE_UNCONFIRMED' }]);
    // The assertion that matters: nothing anywhere wrote OVERDUE.
    expect(db.updates.some((u) => u.state === 'OVERDUE')).toBe(false);
  });

  it('says in the status history that it is awaiting confirmation, not that payment failed', async () => {
    const { db, service } = build('2026-09-05T10:00:00.000Z');
    await service.sweep();

    const reason = db.history[0].reason.toLowerCase();
    expect(reason).toContain('awaiting bank confirmation');
    // A status-history line is read by humans and quoted in disputes. It must
    // not contain a word that asserts the buyer did not pay.
    expect(reason).not.toContain('default');
    expect(reason).not.toContain('failed to pay');
  });

  it('tells the supplier plainly that this is not a record of non-payment', async () => {
    const { db, service } = build('2026-09-05T10:00:00.000Z');
    await service.sweep();

    const notice = db.sent.find((n) => n.templateKey === 'PAYMENT_OVERDUE_UNCONFIRMED');
    expect(notice).toBeDefined();
    expect(notice!.body).toContain('not a record of non-payment');
    expect(notice!.body.toLowerCase()).not.toContain('default');
  });

  it('records in the audit trail that no bank had confirmed anything', async () => {
    const { db, service } = build('2026-09-05T10:00:00.000Z');
    await service.sweep();

    const audit = db.audits.find((a) => a.actionType === 'TRANSACTION_OVERDUE_UNCONFIRMED');
    expect(audit).toBeDefined();
    expect(audit!.newValue).toMatchObject({ state: 'OVERDUE_UNCONFIRMED', bankConfirmed: false });
  });

  it('does nothing on the due date itself', async () => {
    const { db, service } = build('2026-08-30T23:00:00.000Z');
    const result = await service.sweep();
    expect(result.markedUnconfirmed).toBe(0);
    expect(db.updates).toHaveLength(0);
  });

  it('marks once, not once per sweep', async () => {
    const { db, service } = build('2026-09-05T10:00:00.000Z');
    await service.sweep();
    db.rows[0].state = 'OVERDUE_UNCONFIRMED';

    const again = await service.sweep();
    expect(again.markedUnconfirmed).toBe(0);
    expect(db.updates).toHaveLength(1);
  });
});

describe('a payment landing mid-sweep wins over the sweep', () => {
  it('abandons the update when the locked row shows the invoice was paid', async () => {
    const { db, service } = build('2026-09-05T10:00:00.000Z');
    // The sweep's snapshot says FUNDED; by the time the lock is taken the bank
    // has reported payment. The confirmation must not be overwritten by a job
    // that decided the invoice was late before the payment arrived.
    db.lockedState = 'PAID';

    const result = await service.sweep();
    expect(result.markedUnconfirmed).toBe(0);
    expect(db.updates).toHaveLength(0);
  });

  it('abandons the update when the row was disputed in the meantime', async () => {
    const { db, service } = build('2026-09-05T10:00:00.000Z');
    db.lockedState = 'DISPUTED';

    expect((await service.sweep()).markedUnconfirmed).toBe(0);
    expect(db.updates).toHaveLength(0);
  });
});

describe('ZM-REC-013 — a dispute pauses the job', () => {
  it('skips a disputed transaction entirely and says how many it skipped', async () => {
    const { db, service } = build('2027-01-01T00:00:00.000Z');
    db.rows[0].state = 'DISPUTED';

    const result = await service.sweep();
    expect(result).toEqual({ reminded: 0, markedUnconfirmed: 0, skippedPaused: 1 });
    expect(db.updates).toHaveLength(0);
    // Not even a reminder: while the facts are contested the platform says
    // nothing automatic about this invoice at all.
    expect(db.sent).toHaveLength(0);
  });

  it('skips a fraud review too', async () => {
    const { db, service } = build('2027-01-01T00:00:00.000Z');
    db.rows[0].state = 'FRAUD_REVIEW';
    expect((await service.sweep()).skippedPaused).toBe(1);
    expect(db.updates).toHaveLength(0);
  });
});

describe('pre-maturity reminders (AS-05)', () => {
  it('sends nothing while the invoice is far from due', async () => {
    const { db, service } = build('2026-07-01T00:00:00.000Z');
    expect((await service.sweep()).reminded).toBe(0);
    expect(db.sent).toHaveLength(0);
  });

  it('sends the 30-day reminder once and then stops', async () => {
    const { db, service } = build('2026-07-31T00:00:00.000Z');
    expect((await service.sweep()).reminded).toBe(1);
    expect(db.sent[0].templateKey).toBe('MATURITY_REMINDER_30');

    expect((await service.sweep()).reminded).toBe(0);
    expect(db.sent).toHaveLength(1);
  });

  it('catches up on every missed threshold when the sweep has not run', async () => {
    const { db, service } = build('2026-08-25T00:00:00.000Z');
    await service.sweep();
    expect(db.sent.map((n) => n.templateKey)).toEqual([
      'MATURITY_REMINDER_30',
      'MATURITY_REMINDER_14',
      'MATURITY_REMINDER_7',
    ]);
  });

  it('includes the due-date reminder, which the setting does not carry', async () => {
    const { db, service } = build('2026-08-30T09:00:00.000Z');
    await service.sweep();
    expect(db.sent.map((n) => n.templateKey)).toContain('MATURITY_REMINDER_0');
  });

  it('falls back to 30/14/7 when the setting is nonsense', async () => {
    const { db, service } = build('2026-08-25T00:00:00.000Z');
    db.thresholds = 'not-an-array';
    await service.sweep();
    expect(db.sent.map((n) => n.templateKey)).toContain('MATURITY_REMINDER_14');
  });
});
