import { Money } from '../../common/money/money';
import { LedgerLine } from './ledger.service';

/**
 * The journals a settlement produces, as pure functions.
 *
 * Pure on purpose: these are the shape of the platform's books, and they
 * should be assertable in a unit test without a database, a transaction, or a
 * settlement provider. `LedgerService.post` does the writing; this decides
 * what gets written.
 *
 * ## The model
 *
 * Money moves bank → supplier directly (ZM-CON-013). The platform never holds
 * the gross, so no journal here debits platform funds for it. Instead
 * `SETTLEMENT_CLEARING` acts as the pivot:
 *
 *   1. **Funding received** — the bank's funding obligation is discharged into
 *      clearing. DR clearing / CR bank-funding, for the gross.
 *   2. **Distribution** — clearing is emptied into the three things the gross
 *      actually becomes: the platform's commission, the platform's listing
 *      fee, and the supplier's payable. DR clearing is reversed here: clearing
 *      is credited and the destinations debited.
 *   3. **Payout completed** — the supplier's payable is discharged.
 *
 * After (3) the clearing balance for the transaction is zero. That is the
 * invariant worth testing: a non-zero clearing balance on a completed
 * settlement means the books claim money stopped somewhere it did not.
 *
 * Commission and listing fee are the only legs that reach a platform revenue
 * account, because they are the only money the platform actually earns
 * (ZM-FEE-018).
 */

export interface SettlementSplit {
  gross: Money;
  commission: Money;
  listingFee: Money;
  netPayout: Money;
  supplierOrgId: string;
  bankOrgId: string;
}

export class SettlementSplitMismatch extends Error {
  constructor(gross: string, parts: string) {
    super(
      `Settlement split does not reconcile: gross ${gross} != commission + listing fee + ` +
        `net payout (${parts}). The database CHECK (chk_settlement_split) enforces the same ` +
        'relation; a mismatch here would post a journal describing money that does not exist.',
    );
    this.name = 'SettlementSplitMismatch';
  }
}

/**
 * The split must account for the whole gross, exactly.
 *
 * `chk_settlement_split` in the frozen schema allows `gross >= parts`, which
 * tolerates a remainder. This refuses one: an unexplained remainder is money
 * the books cannot say the whereabouts of, and every leg the product defines
 * (commission, listing fee, payout) is already represented. If a future
 * deduction type appears it gets its own leg rather than hiding in a gap.
 */
export function assertSplitReconciles(split: SettlementSplit): void {
  const parts = split.commission.add(split.listingFee).add(split.netPayout);
  if (!parts.equals(split.gross)) {
    throw new SettlementSplitMismatch(split.gross.toString(), parts.toString());
  }
}

/** Journal 1 — the bank's funding lands in clearing. */
export function fundingReceivedJournal(split: SettlementSplit): LedgerLine[] {
  return [
    {
      entryType: 'DEBIT',
      accountKind: 'SETTLEMENT_CLEARING',
      amount: split.gross,
      organizationId: null,
      description: 'Gross funding received into settlement clearing',
    },
    {
      entryType: 'CREDIT',
      accountKind: 'BANK_FUNDING',
      amount: split.gross,
      organizationId: split.bankOrgId,
      description: 'Bank funding obligation discharged',
    },
  ];
}

/**
 * Journal 2 — clearing is distributed into what the gross actually becomes.
 *
 * Zero-amount legs are omitted rather than posted as zero rows: the schema's
 * `CHECK (amount > 0)` forbids them, and a listing fee of nothing is not an
 * event that happened.
 */
export function distributionJournal(split: SettlementSplit): LedgerLine[] {
  const lines: LedgerLine[] = [
    {
      entryType: 'CREDIT',
      accountKind: 'SETTLEMENT_CLEARING',
      amount: split.gross,
      organizationId: null,
      description: 'Settlement clearing distributed',
    },
  ];

  if (split.commission.isPositive()) {
    lines.push({
      entryType: 'DEBIT',
      accountKind: 'PLATFORM_COMMISSION_REVENUE',
      amount: split.commission,
      organizationId: null,
      description: 'Platform commission earned',
    });
  }
  if (split.listingFee.isPositive()) {
    lines.push({
      entryType: 'DEBIT',
      accountKind: 'PLATFORM_LISTING_FEE_REVENUE',
      amount: split.listingFee,
      organizationId: null,
      description: 'Listing fee recovered from settlement',
    });
  }
  if (split.netPayout.isPositive()) {
    lines.push({
      entryType: 'DEBIT',
      accountKind: 'SUPPLIER_PAYABLE',
      amount: split.netPayout,
      organizationId: split.supplierOrgId,
      description: 'Net payout owed to supplier',
    });
  }

  return lines;
}

/**
 * Journal 3 — the supplier has been paid, so the payable is discharged.
 *
 * The counter-leg is the supplier's receivable position, not platform cash:
 * the bank paid the supplier, and the platform's books record that the
 * obligation it was tracking is now settled between those two parties.
 */
export function payoutCompletedJournal(split: SettlementSplit): LedgerLine[] {
  return [
    {
      entryType: 'CREDIT',
      accountKind: 'SUPPLIER_PAYABLE',
      amount: split.netPayout,
      organizationId: split.supplierOrgId,
      description: 'Supplier payable discharged on completed payout',
    },
    {
      entryType: 'DEBIT',
      accountKind: 'SUPPLIER_RECEIVABLE',
      amount: split.netPayout,
      organizationId: split.supplierOrgId,
      description: 'Supplier received net payout from bank',
    },
  ];
}
