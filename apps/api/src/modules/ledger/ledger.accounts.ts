/**
 * The chart of accounts, and what the platform may and may not claim to hold.
 *
 * ## The decision this file encodes
 *
 * ZM-CON-013 has funding move **bank → supplier directly**. The platform is an
 * intermediary, not a principal: it never takes custody of the gross funding.
 * A ledger that debited a "platform cash" account for the gross would therefore
 * assert a cash position that never existed — a clean, balanced, and entirely
 * fictional set of books.
 *
 * ZM-FEE-018 states the requirement outright: records of money the platform did
 * not hold "MUST NOT imply that Zimmamless ever held those funds. The ledger
 * must make this distinction structurally obvious."
 *
 * The frozen `ledger_account_kind` enum already anticipates this. Read the list:
 * there is **no cash account**. What it gives instead is `SETTLEMENT_CLEARING`
 * (and `RECOURSE_CLEARING`) — pass-through clearing accounts — plus two genuine
 * platform revenue accounts. That is the structural distinction the requirement
 * asks for, and this module makes it explicit rather than leaving it to whoever
 * writes the next posting.
 *
 * ## The rule
 *
 *   - Money the platform **earns** (commission, listing fee) posts to a
 *     PLATFORM_*_REVENUE account. These are real platform books.
 *   - Money that merely **passes between other parties** (the gross funding,
 *     the supplier's payout) pivots through a CLEARING account, which nets to
 *     zero once a settlement completes. A non-zero clearing balance on a
 *     completed settlement means money was described as moving somewhere it did
 *     not go, and is a reconciliation defect.
 *   - Nothing anywhere may treat a clearing balance as platform funds.
 */

/** Mirrors the frozen `ledger_account_kind` enum exactly. */
export type LedgerAccountKind =
  | 'BANK_FUNDING'
  | 'SUPPLIER_PAYABLE'
  | 'PLATFORM_COMMISSION_REVENUE'
  | 'PLATFORM_LISTING_FEE_REVENUE'
  | 'SUPPLIER_RECEIVABLE'
  | 'SETTLEMENT_CLEARING'
  | 'RECOURSE_CLEARING';

export const LEDGER_ACCOUNT_KINDS: readonly LedgerAccountKind[] = [
  'BANK_FUNDING',
  'SUPPLIER_PAYABLE',
  'PLATFORM_COMMISSION_REVENUE',
  'PLATFORM_LISTING_FEE_REVENUE',
  'SUPPLIER_RECEIVABLE',
  'SETTLEMENT_CLEARING',
  'RECOURSE_CLEARING',
];

/**
 * Accounts that represent value the platform genuinely owns.
 *
 * Deliberately short. Everything absent from this set is either another
 * party's position or a pass-through, and must never be reported as platform
 * funds (ZM-FEE-018).
 */
export const PLATFORM_REVENUE_ACCOUNTS: readonly LedgerAccountKind[] = [
  'PLATFORM_COMMISSION_REVENUE',
  'PLATFORM_LISTING_FEE_REVENUE',
];

/** Pass-through accounts. A completed settlement must leave these at zero. */
export const CLEARING_ACCOUNTS: readonly LedgerAccountKind[] = [
  'SETTLEMENT_CLEARING',
  'RECOURSE_CLEARING',
];

export function isPlatformRevenue(kind: LedgerAccountKind): boolean {
  return PLATFORM_REVENUE_ACCOUNTS.includes(kind);
}

export function isClearing(kind: LedgerAccountKind): boolean {
  return CLEARING_ACCOUNTS.includes(kind);
}

/**
 * Whether an account may be presented as "money Zimmamless holds".
 *
 * Always false for everything except platform revenue — which is the whole
 * point of ZM-FEE-018 and the reason this is a function rather than a comment.
 */
export function countsAsPlatformFunds(kind: LedgerAccountKind): boolean {
  return isPlatformRevenue(kind);
}
