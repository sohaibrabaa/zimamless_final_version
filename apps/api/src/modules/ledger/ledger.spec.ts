import { LedgerService, LedgerImbalance, LedgerLine } from './ledger.service';
import {
  SettlementSplit,
  SettlementSplitMismatch,
  assertSplitReconciles,
  distributionJournal,
  fundingReceivedJournal,
  payoutCompletedJournal,
} from './settlement-postings';
import { countsAsPlatformFunds, isClearing } from './ledger.accounts';
import { Money } from '../../common/money/money';

/**
 * INV-6 and the ledger ruling, tested without a database.
 *
 * The posting shapes are pure functions precisely so the platform's books can
 * be asserted here rather than only after an eight-minute integration run.
 * The database tests that follow in the settlement work prove the rows land;
 * these prove the rows are *right*.
 */

const SUPPLIER = '0e000000-0000-4000-8000-000000000002';
const BANK = '0e000000-0000-4000-8000-000000000004';

/** The Phase 6 fixture's real numbers: gross 9000, commission 135, fee 25. */
const SPLIT: SettlementSplit = {
  gross: Money.from('9000.000'),
  commission: Money.from('135.000'),
  listingFee: Money.from('25.000'),
  netPayout: Money.from('8840.000'),
  supplierOrgId: SUPPLIER,
  bankOrgId: BANK,
};

/** Net movement on one account across a set of lines, debits positive. */
function net(lines: LedgerLine[], accountKind: string): Money {
  let balance = Money.zero();
  for (const line of lines) {
    if (line.accountKind !== accountKind) continue;
    balance =
      line.entryType === 'DEBIT' ? balance.add(line.amount) : balance.subtract(line.amount);
  }
  return balance;
}

function totals(lines: LedgerLine[]): { debits: Money; credits: Money } {
  let debits = Money.zero();
  let credits = Money.zero();
  for (const line of lines) {
    if (line.entryType === 'DEBIT') debits = debits.add(line.amount);
    else credits = credits.add(line.amount);
  }
  return { debits, credits };
}

describe('INV-6 — every journal balances', () => {
  const ledger = new LedgerService(null as never);

  it.each([
    ['funding received', fundingReceivedJournal(SPLIT)],
    ['distribution', distributionJournal(SPLIT)],
    ['payout completed', payoutCompletedJournal(SPLIT)],
  ])('the %s journal balances', (_name, lines) => {
    const { debits, credits } = totals(lines);
    expect(debits.toString()).toBe(credits.toString());
    expect(() => ledger.assertBalanced(lines)).not.toThrow();
  });

  it('refuses to accept an unbalanced journal', () => {
    const lines: LedgerLine[] = [
      {
        entryType: 'DEBIT',
        accountKind: 'SETTLEMENT_CLEARING',
        amount: Money.from('9000.000'),
        description: 'in',
      },
      {
        entryType: 'CREDIT',
        accountKind: 'BANK_FUNDING',
        amount: Money.from('8999.999'),
        description: 'out',
      },
    ];
    expect(() => ledger.assertBalanced(lines)).toThrow(LedgerImbalance);
  });

  it('catches an imbalance of a single fils — decimal, not float', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE doubles. Money must not have that problem, and
    // an imbalance this small is exactly the kind a float comparison hides.
    const lines: LedgerLine[] = [
      {
        entryType: 'DEBIT',
        accountKind: 'SETTLEMENT_CLEARING',
        amount: Money.from('0.100'),
        description: 'a',
      },
      {
        entryType: 'DEBIT',
        accountKind: 'SETTLEMENT_CLEARING',
        amount: Money.from('0.200'),
        description: 'b',
      },
      {
        entryType: 'CREDIT',
        accountKind: 'BANK_FUNDING',
        amount: Money.from('0.301'),
        description: 'c',
      },
    ];
    expect(() => ledger.assertBalanced(lines)).toThrow(LedgerImbalance);

    // …and the honest 0.300 balances exactly.
    lines[2] = { ...lines[2], amount: Money.from('0.300') };
    expect(() => ledger.assertBalanced(lines)).not.toThrow();
  });
});

describe('the settlement split must account for the whole gross', () => {
  it('accepts a split that reconciles', () => {
    expect(() => assertSplitReconciles(SPLIT)).not.toThrow();
  });

  it('refuses a split that leaves an unexplained remainder', () => {
    // The DB CHECK allows gross >= parts. A remainder is money the books
    // cannot say the whereabouts of, so this refuses it.
    const leaky: SettlementSplit = { ...SPLIT, netPayout: Money.from('8000.000') };
    expect(() => assertSplitReconciles(leaky)).toThrow(SettlementSplitMismatch);
  });

  it('refuses a split that over-distributes the gross', () => {
    const over: SettlementSplit = { ...SPLIT, netPayout: Money.from('9000.000') };
    expect(() => assertSplitReconciles(over)).toThrow(SettlementSplitMismatch);
  });
});

describe('the ledger ruling — clearing passes through, revenue stays', () => {
  const wholeSettlement = [
    ...fundingReceivedJournal(SPLIT),
    ...distributionJournal(SPLIT),
    ...payoutCompletedJournal(SPLIT),
  ];

  it('leaves SETTLEMENT_CLEARING at exactly zero once settled', () => {
    // The invariant the whole design exists for: money passed through, it did
    // not stop here. A residual balance would be the platform appearing to
    // hold funds it never held (ZM-FEE-018).
    expect(net(wholeSettlement, 'SETTLEMENT_CLEARING').toString()).toBe('0.000');
  });

  it('never posts the gross funding to a platform-funds account', () => {
    // There is no cash account in the enum, and this asserts nothing invented
    // one: the only accounts that count as platform funds are the two revenue
    // accounts, and neither ever carries the gross.
    for (const line of wholeSettlement) {
      if (countsAsPlatformFunds(line.accountKind)) {
        expect(line.amount.toString()).not.toBe(SPLIT.gross.toString());
      }
    }
  });

  it('recognizes exactly the commission and the listing fee as platform revenue', () => {
    const revenue = wholeSettlement.filter((l) => countsAsPlatformFunds(l.accountKind));
    expect(revenue).toHaveLength(2);
    expect(net(wholeSettlement, 'PLATFORM_COMMISSION_REVENUE').toString()).toBe('135.000');
    expect(net(wholeSettlement, 'PLATFORM_LISTING_FEE_REVENUE').toString()).toBe('25.000');
  });

  it('discharges the supplier payable in full', () => {
    // Credited 8840 by distribution, debited 8840 on payout: net zero, i.e.
    // the obligation was created and then genuinely settled.
    expect(net(wholeSettlement, 'SUPPLIER_PAYABLE').toString()).toBe('0.000');
  });

  it('classifies clearing accounts as pass-through, never as platform funds', () => {
    expect(isClearing('SETTLEMENT_CLEARING')).toBe(true);
    expect(isClearing('RECOURSE_CLEARING')).toBe(true);
    expect(countsAsPlatformFunds('SETTLEMENT_CLEARING')).toBe(false);
    expect(countsAsPlatformFunds('RECOURSE_CLEARING')).toBe(false);
    expect(countsAsPlatformFunds('BANK_FUNDING')).toBe(false);
    expect(countsAsPlatformFunds('SUPPLIER_PAYABLE')).toBe(false);
  });
});

describe('zero-amount legs', () => {
  it('omits a listing fee of nothing rather than posting a zero row', () => {
    // `CHECK (amount > 0)` forbids a zero row, and a fee of nothing is not an
    // event that happened.
    const noFee: SettlementSplit = {
      ...SPLIT,
      listingFee: Money.zero(),
      netPayout: Money.from('8865.000'),
    };
    const lines = distributionJournal(noFee);
    expect(lines.some((l) => l.accountKind === 'PLATFORM_LISTING_FEE_REVENUE')).toBe(false);

    const { debits, credits } = totals(lines);
    expect(debits.toString()).toBe(credits.toString());
  });
});

describe('LedgerService.post guards', () => {
  const ledger = new LedgerService(null as never);
  const client = { query: jest.fn() } as never;

  it('refuses a single-sided journal', async () => {
    await expect(
      ledger.post(client, {
        lines: [
          {
            entryType: 'DEBIT',
            accountKind: 'SETTLEMENT_CLEARING',
            amount: Money.from('1.000'),
            description: 'lonely',
          },
        ],
      }),
    ).rejects.toThrow(/at least two lines/);
  });

  it('refuses a journal that does not balance, before writing anything', async () => {
    const query = jest.fn();
    await expect(
      ledger.post({ query } as never, {
        lines: [
          {
            entryType: 'DEBIT',
            accountKind: 'SETTLEMENT_CLEARING',
            amount: Money.from('5.000'),
            description: 'a',
          },
          {
            entryType: 'CREDIT',
            accountKind: 'BANK_FUNDING',
            amount: Money.from('4.000'),
            description: 'b',
          },
        ],
      }),
    ).rejects.toThrow(LedgerImbalance);
    // Nothing was written. The imbalance cannot exist to be found later.
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses a non-positive amount — direction is DEBIT/CREDIT, not a sign', async () => {
    const query = jest.fn();
    await expect(
      ledger.post({ query } as never, {
        lines: [
          {
            entryType: 'DEBIT',
            accountKind: 'SETTLEMENT_CLEARING',
            amount: Money.from('0.000'),
            description: 'a',
          },
          {
            entryType: 'CREDIT',
            accountKind: 'BANK_FUNDING',
            amount: Money.from('0.000'),
            description: 'b',
          },
        ],
      }),
    ).rejects.toThrow(/must be positive/);
  });

  it('writes one row per line under a single journal id', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const journalId = await ledger.post({ query } as never, {
      lines: fundingReceivedJournal(SPLIT),
      transactionId: 'tx-1',
    });

    expect(query).toHaveBeenCalledTimes(2);
    expect(journalId).toMatch(/^[0-9a-f-]{36}$/);
    for (const call of query.mock.calls) {
      expect(call[1][0]).toBe(journalId);
    }
  });
});
