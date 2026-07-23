import { Money } from '../../common/money/money';
import {
  passesPreContractChecks,
  preContractFindings,
  type PreContractFacts,
} from './pre-contract-checks';

const clean = (overrides: Partial<PreContractFacts> = {}): PreContractFacts => ({
  invoiceOutstanding: Money.from('11600.000'),
  invoiceDueDate: '2026-12-31',
  invoiceAltered: false,
  invoiceCancelled: false,
  invoiceExpired: false,
  snapshotGross: Money.from('9000.000'),
  conditions: [],
  declarationsAffirmed: true,
  bankAccountVerified: true,
  ...overrides,
});

const codes = (facts: PreContractFacts): string[] =>
  preContractFindings(facts).map((f) => f.code);

describe('ZM-CON-006 — the four pre-contract conditions', () => {
  it('passes a clean deal', () => {
    expect(preContractFindings(clean())).toEqual([]);
    expect(passesPreContractChecks(clean())).toBe(true);
  });

  it('refuses a cancelled invoice', () => {
    expect(codes(clean({ invoiceCancelled: true }))).toContain('INVOICE_CANCELLED');
  });

  it('refuses an altered invoice', () => {
    expect(codes(clean({ invoiceAltered: true }))).toContain('INVOICE_ALTERED');
  });

  it('refuses an invoice that has fallen due', () => {
    expect(codes(clean({ invoiceExpired: true }))).toContain('INVOICE_PAST_DUE');
  });

  it('refuses unaffirmed declarations', () => {
    expect(codes(clean({ declarationsAffirmed: false }))).toContain('DECLARATIONS_NOT_REAFFIRMED');
  });

  it('refuses an unverified supplier bank account', () => {
    expect(codes(clean({ bankAccountVerified: false }))).toContain('BANK_ACCOUNT_NOT_VERIFIED');
  });
});

describe('INV-3 re-checked at contract time', () => {
  it('refuses when a buyer part-payment has dropped outstanding below the accepted gross', () => {
    // The offer was valid when made. A part-payment between acceptance and
    // contracting legitimately reduces the receivable, and advancing more
    // than it can repay is exactly what INV-3 exists to stop.
    const findings = codes(
      clean({ invoiceOutstanding: Money.from('8000.000'), snapshotGross: Money.from('9000.000') }),
    );
    expect(findings).toContain('GROSS_EXCEEDS_OUTSTANDING');
  });

  it('accepts gross exactly equal to outstanding', () => {
    expect(
      codes(
        clean({
          invoiceOutstanding: Money.from('9000.000'),
          snapshotGross: Money.from('9000.000'),
        }),
      ),
    ).toEqual([]);
  });
});

describe('mandatory conditions', () => {
  const condition = (overrides: Record<string, unknown> = {}) => ({
    id: 'c1',
    title: 'Signed assignment notice',
    isMandatory: true,
    fulfilment: 'PENDING' as const,
    waiverReason: null,
    ...overrides,
  });

  it('blocks on an outstanding mandatory condition', () => {
    expect(codes(clean({ conditions: [condition()] }))).toContain('CONDITION_OUTSTANDING');
  });

  it('is satisfied by a fulfilled one', () => {
    expect(codes(clean({ conditions: [condition({ fulfilment: 'FULFILLED' })] }))).toEqual([]);
  });

  it('is satisfied by a waiver WITH a reason', () => {
    expect(
      codes(
        clean({
          conditions: [
            condition({ fulfilment: 'WAIVED', waiverReason: 'Bank accepted the buyer confirmation instead.' }),
          ],
        }),
      ),
    ).toEqual([]);
  });

  it('is NOT satisfied by a waiver with no reason recorded', () => {
    // "Explicitly waived with a record" — a WAIVED row with no reason is the
    // exact shape of someone clicking through a blocker.
    expect(
      codes(clean({ conditions: [condition({ fulfilment: 'WAIVED', waiverReason: null })] })),
    ).toContain('CONDITION_WAIVED_WITHOUT_RECORD');
  });

  it('is NOT satisfied by a waiver whose reason is whitespace', () => {
    expect(
      codes(clean({ conditions: [condition({ fulfilment: 'WAIVED', waiverReason: '   ' })] })),
    ).toContain('CONDITION_WAIVED_WITHOUT_RECORD');
  });

  it('blocks on a FAILED mandatory condition', () => {
    expect(codes(clean({ conditions: [condition({ fulfilment: 'FAILED' })] }))).toContain(
      'CONDITION_OUTSTANDING',
    );
  });

  it('ignores an outstanding NON-mandatory condition', () => {
    expect(codes(clean({ conditions: [condition({ isMandatory: false })] }))).toEqual([]);
  });
});

describe('the findings are a list, not the first failure', () => {
  it('reports every outstanding item at once', () => {
    const found = codes(
      clean({
        invoiceCancelled: true,
        declarationsAffirmed: false,
        bankAccountVerified: false,
        conditions: [
          {
            id: 'c1',
            title: 'Guarantee',
            isMandatory: true,
            fulfilment: 'PENDING',
            waiverReason: null,
          },
        ],
      }),
    );
    // A supplier who fixes one thing and is then told about the next is being
    // drip-fed. One response naming everything is the difference between a
    // checklist and a guessing game.
    expect(found).toEqual(
      expect.arrayContaining([
        'INVOICE_CANCELLED',
        'CONDITION_OUTSTANDING',
        'DECLARATIONS_NOT_REAFFIRMED',
        'BANK_ACCOUNT_NOT_VERIFIED',
      ]),
    );
    expect(found).toHaveLength(4);
  });

  it('names the condition in the message so it is actionable', () => {
    const findings = preContractFindings(
      clean({
        conditions: [
          {
            id: 'c1',
            title: 'Personal guarantee from the signatory',
            isMandatory: true,
            fulfilment: 'PENDING',
            waiverReason: null,
          },
        ],
      }),
    );
    expect(findings[0].message).toContain('Personal guarantee from the signatory');
  });
});
