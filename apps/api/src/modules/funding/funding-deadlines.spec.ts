import { FundingDeadlinesService } from './funding-deadlines.service';
import { FixedTimeProvider } from '../../common/time/time.provider';

/**
 * AS-04 — a stalled funding confirmation escalates to Operations Admin.
 *
 * Two things are worth pinning here and neither is the happy path. The first
 * is *who* receives the escalation: AS-04 exists because escalating to the
 * highest-privilege account is the easy, wrong default. The second is that the
 * sweep is idempotent — it runs on an interval, so anything it does once it
 * must decline to do again, forever.
 */

const TX = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SETTLEMENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SUPPLIER_ORG = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const MARKED_SENT = new Date('2026-07-23T00:00:00.000Z');

interface Sent {
  templateKey: string;
  userId: string;
  transactionId: string;
  body: string;
}

/** Enough of the database for the sweep's decisions. */
class FakeDb {
  escalationHours: unknown = 24;
  pending = [
    {
      transaction_id: TX,
      settlement_id: SETTLEMENT,
      supplier_org_id: SUPPLIER_ORG,
      bank_marked_sent_at: MARKED_SENT,
      net_supplier_payout: '8390.000',
      invoice_number: 'INV-2026-0042',
    },
  ];
  /** user id → roles. The sweep resolves recipients by role, so this is the fixture that matters. */
  members: { userId: string; orgId: string; role: string }[] = [
    { userId: 'supplier-owner', orgId: SUPPLIER_ORG, role: 'SUPPLIER_OWNER' },
    { userId: 'ops-admin', orgId: 'platform', role: 'PLATFORM_OPS_ADMIN' },
    { userId: 'super-admin', orgId: 'platform', role: 'PLATFORM_SUPER_ADMIN' },
  ];
  sent: Sent[] = [];
  audits: { actionType: string; newValue: Record<string, unknown> }[] = [];

  query = jest.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM receivable_transactions t')) {
      return { rows: this.pending, rowCount: this.pending.length };
    }
    if (sql.includes('PLATFORM_OPS_ADMIN')) {
      return this.membersWithRole('PLATFORM_OPS_ADMIN');
    }
    if (sql.includes('SUPPLIER_OWNER')) {
      return this.membersWithRole('SUPPLIER_OWNER', params[0] as string);
    }
    if (sql.includes('INSERT INTO notifications')) {
      this.sent.push({
        templateKey: params[0] as string,
        userId: params[1] as string,
        body: params[3] as string,
        transactionId: params[4] as string,
      });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  queryOne = jest.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('funding_confirmation_escalation_hours')) {
      return { value: this.escalationHours };
    }
    if (sql.includes('FROM notifications')) {
      const already = this.sent.some(
        (n) => n.templateKey === params[0] && n.transactionId === params[1],
      );
      return already ? { '?column?': 1 } : null;
    }
    return null;
  });

  transaction = jest.fn(async (fn: (c: unknown) => Promise<unknown>) => fn(this));

  private membersWithRole(role: string, orgId?: string) {
    const rows = this.members
      .filter((m) => m.role === role && (orgId === undefined || m.orgId === orgId))
      .map((m) => ({ user_id: m.userId }));
    return { rows, rowCount: rows.length };
  }
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
  const service = new FundingDeadlinesService(
    db as never,
    audit as never,
    new FixedTimeProvider(new Date(at)),
  );
  return { db, service };
}

describe('ZM-FND-011 — the supplier is reminded before anyone is escalated to', () => {
  it('does nothing at all in the first half of the window', async () => {
    const { db, service } = build('2026-07-23T11:00:00.000Z'); // 11h of 24
    expect(await service.sweep()).toEqual({ reminded: 0, escalated: 0 });
    expect(db.sent).toHaveLength(0);
  });

  it('reminds the supplier at the halfway point, and nobody else', async () => {
    const { db, service } = build('2026-07-23T12:30:00.000Z'); // 12.5h of 24
    expect(await service.sweep()).toEqual({ reminded: 1, escalated: 0 });

    expect(db.sent).toHaveLength(1);
    expect(db.sent[0].userId).toBe('supplier-owner');
    expect(db.sent[0].templateKey).toBe('FUNDING_CONFIRMATION_REMINDER');
    // No operations admin is troubled by a transaction that is merely late.
    expect(db.sent.some((n) => n.userId === 'ops-admin')).toBe(false);
  });

  it('reminds once, not once per sweep', async () => {
    const { db, service } = build('2026-07-23T12:30:00.000Z');
    await service.sweep();
    expect(await service.sweep()).toEqual({ reminded: 0, escalated: 0 });
    expect(await service.sweep()).toEqual({ reminded: 0, escalated: 0 });
    expect(db.sent).toHaveLength(1);
  });
});

describe('AS-04 — escalation goes to Operations Admin, not Super Admin', () => {
  it('escalates once the window is spent', async () => {
    const { db, service } = build('2026-07-24T00:30:00.000Z'); // 24.5h
    expect(await service.sweep()).toEqual({ reminded: 0, escalated: 1 });

    expect(db.sent).toHaveLength(1);
    expect(db.sent[0].userId).toBe('ops-admin');
    expect(db.sent[0].templateKey).toBe('FUNDING_CONFIRMATION_ESCALATED');
  });

  it('never notifies the super admin, who outranks the role that is notified', async () => {
    const { db, service } = build('2026-07-25T00:00:00.000Z'); // 48h — long past due
    await service.sweep();
    expect(db.sent.some((n) => n.userId === 'super-admin')).toBe(false);
  });

  it('does not also send the halfway reminder to a transaction that blew past both points', async () => {
    const { db, service } = build('2026-07-25T00:00:00.000Z');
    await service.sweep();
    expect(db.sent.map((n) => n.templateKey)).toEqual(['FUNDING_CONFIRMATION_ESCALATED']);
  });

  it('escalates once, not once per sweep', async () => {
    const { db, service } = build('2026-07-24T00:30:00.000Z');
    await service.sweep();
    expect(await service.sweep()).toEqual({ reminded: 0, escalated: 0 });
    expect(db.sent).toHaveLength(1);
    expect(db.audits).toHaveLength(1);
  });

  it('carries ZM-FND-012 full context in the audit entry', async () => {
    const { db, service } = build('2026-07-24T00:30:00.000Z');
    await service.sweep();

    const audit = db.audits[0];
    expect(audit.actionType).toBe('FUNDING_CONFIRMATION_ESCALATED');
    expect(audit.newValue).toMatchObject({
      transactionId: TX,
      settlementId: SETTLEMENT,
      invoiceNumber: 'INV-2026-0042',
      netSupplierPayout: '8390.000',
      bankMarkedSentAt: MARKED_SENT.toISOString(),
      hoursPending: 24,
    });
  });

  it('names the amount and the wait in the operator’s notification', async () => {
    const { db, service } = build('2026-07-24T00:30:00.000Z');
    await service.sweep();
    expect(db.sent[0].body).toContain('8390.000');
    expect(db.sent[0].body).toContain('24 hours');
  });

  it('says loudly that nothing was escalated when no operations admin exists', async () => {
    const { db, service } = build('2026-07-24T00:30:00.000Z');
    db.members = db.members.filter((m) => m.role !== 'PLATFORM_OPS_ADMIN');

    expect(await service.sweep()).toEqual({ reminded: 0, escalated: 0 });
    expect(db.sent).toHaveLength(0);
    // And crucially no audit entry: nothing was escalated, so the trail must
    // not claim it was.
    expect(db.audits).toHaveLength(0);
  });
});

describe('the escalation window is configurable (ZM-FND-011)', () => {
  it('honours a shortened window from platform_settings', async () => {
    const { db, service } = build('2026-07-23T02:00:00.000Z'); // 2h
    db.escalationHours = 1;
    expect(await service.sweep()).toEqual({ reminded: 0, escalated: 1 });
  });

  it('falls back to 24 hours when the setting is missing or nonsense', async () => {
    const { service } = build('2026-07-23T12:30:00.000Z');
    const { db, service: broken } = build('2026-07-23T12:30:00.000Z');
    db.escalationHours = 'not-a-number';
    // Same result either way: 12.5h is halfway through a 24h window.
    expect(await broken.sweep()).toEqual({ reminded: 1, escalated: 0 });
    expect(await service.sweep()).toEqual({ reminded: 1, escalated: 0 });
  });
});

describe('the sweep is driven by the transaction state, not the settlement', () => {
  it('does nothing when nothing is awaiting confirmation', async () => {
    const { db, service } = build('2026-07-25T00:00:00.000Z');
    db.pending = [];
    expect(await service.sweep()).toEqual({ reminded: 0, escalated: 0 });
    expect(db.sent).toHaveLength(0);
  });

  it('ages from bank_marked_sent_at, so reissuing the code cannot postpone escalation', async () => {
    // The clock is 30h past the transfer. If the sweep aged from anything the
    // bank can repeat — OTP generation, updated_at — this would not escalate.
    const { service } = build('2026-07-24T06:00:00.000Z');
    expect(await service.sweep()).toEqual({ reminded: 0, escalated: 1 });
  });
});
