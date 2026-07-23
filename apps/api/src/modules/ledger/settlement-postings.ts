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
 * the funds, so no journal here debits platform funds for them. Instead
 * `SETTLEMENT_CLEARING` acts as the pivot:
 *
 *   1. **Funding received** — the bank's funding obligation is discharged into
 *      clearing. DR clearing / CR bank-funding, for the *distributable*
 *      amount, not the headline gross. See `SettlementSplit.distributable`:
 *      the bank retains its own discount and fees, so they never move and
 *      never enter these books.
 *   2. **Distribution** — clearing is emptied into the three things that
 *      amount becomes: the platform's commission, the platform's listing fee,
 *      and the supplier's payable. Clearing is credited and the destinations
 *      debited.
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
  /**
   * What the bank actually remits into the settlement arrangement.
   *
   * **Not** the headline `grossFundingAmount`, and the distinction is the one
   * thing to get right here. Offer arithmetic is:
   *
   * ```
   * net = gross - bankDiscount - bankFees - commission - listingFee - other
   * ```
   *
   * The bank's discount and fees are its own pricing: it *retains* them and
   * never transfers them to anyone. With the Phase 6 fixture — gross 9000,
   * discount 300, fees 150, commission 135, listing fee 25, net 8390 — the
   * money that actually leaves the bank is 8550, not 9000.
   *
   * Posting the headline 9000 into clearing and distributing only 8550 would
   * strand 450 in a clearing account permanently, which is both an imbalance
   * in substance and a claim that the platform is holding the bank's margin.
   * That is also why the frozen `chk_settlement_split` is `>=` rather than `=`:
   * it compares against the headline gross and tolerates the bank's retained
   * remainder.
   *
   * So the ledger posts what moves. The bank's margin never enters the
   * platform's books at all, because it is not the platform's business and the
   * platform does not intermediate it.
   */
  distributable: Money;
  commission: Money;
  listingFee: Money;
  netPayout: Money;
  supplierOrgId: string;
  bankOrgId: string;
}

export class SettlementSplitMismatch extends Error {
  constructor(distributable: string, parts: string) {
    super(
      `Settlement split does not reconcile: distributable ${distributable} != commission + ` +
        `listing fee + net payout (${parts}). A mismatch here would post a journal describing ` +
        'money that does not exist, or strand a balance in a clearing account.',
    );
    this.name = 'SettlementSplitMismatch';
  }
}

/**
 * What the bank remits: everything the offer promised to someone other than
 * the bank itself.
 */
export function distributableFrom(
  commission: Money,
  listingFee: Money,
  netPayout: Money,
): Money {
  return commission.add(listingFee).add(netPayout);
}

/**
 * The distributable amount must be exactly the three legs it becomes.
 *
 * Strict equality, unlike the database CHECK — that one compares against the
 * headline gross and must tolerate the bank's retained margin. Here there is
 * nothing left to tolerate: every leg is named, so a remainder would be money
 * the books cannot say the whereabouts of. A future deduction type gets its own
 * leg rather than hiding in a gap.
 */
export function assertSplitReconciles(split: SettlementSplit): void {
  const parts = distributableFrom(split.commission, split.listingFee, split.netPayout);
  if (!parts.equals(split.distributable)) {
    throw new SettlementSplitMismatch(split.distributable.toString(), parts.toString());
  }
}

/** Journal 1 — the bank's funding lands in clearing. */
export function fundingReceivedJournal(split: SettlementSplit): LedgerLine[] {
  return [
    {
      entryType: 'DEBIT',
      accountKind: 'SETTLEMENT_CLEARING',
      amount: split.distributable,
      organizationId: null,
      description: 'Funding received into settlement clearing',
    },
    {
      entryType: 'CREDIT',
      accountKind: 'BANK_FUNDING',
      amount: split.distributable,
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
      amount: split.distributable,
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
