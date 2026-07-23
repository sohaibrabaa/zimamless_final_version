/**
 * Offer and listing lifecycles, as whitelists.
 *
 * Same approach as `transactions/transaction-state.ts`: transitions are a
 * table of what IS allowed, so an unlisted move is refused by default. The
 * alternative — a set of guards against known-bad transitions — fails silently
 * the day someone adds a state.
 */

export type OfferStatus =
  | 'DRAFT'
  | 'PENDING_INTERNAL_APPROVAL'
  | 'ACTIVE'
  | 'REVISED'
  | 'SELECTED'
  | 'NOT_SELECTED'
  | 'WITHDRAWN'
  | 'EXPIRED'
  | 'REJECTED_INTERNAL';

export type ListingStatus =
  | 'OPEN_FOR_OFFERS'
  | 'OFFER_PERIOD_CLOSED'
  | 'AWAITING_SELECTION'
  | 'OFFER_SELECTED'
  | 'EXPIRED'
  | 'CANCELLED';

export const OFFER_TRANSITIONS: Readonly<Record<OfferStatus, readonly OfferStatus[]>> = {
  DRAFT: ['PENDING_INTERNAL_APPROVAL', 'WITHDRAWN'],
  PENDING_INTERNAL_APPROVAL: ['ACTIVE', 'REJECTED_INTERNAL', 'WITHDRAWN'],
  // REVISED is where a superseded version lands when the bank revises.
  ACTIVE: ['SELECTED', 'NOT_SELECTED', 'WITHDRAWN', 'EXPIRED', 'REVISED'],
  // Terminal states. SELECTED in particular is terminal here because
  // unwinding an accepted offer is a withdrawal *case* (Phase 8), not a
  // status change — INV-1 depends on acceptance being irreversible.
  REVISED: [],
  SELECTED: [],
  NOT_SELECTED: [],
  WITHDRAWN: [],
  EXPIRED: [],
  REJECTED_INTERNAL: [],
};

export const LISTING_TRANSITIONS: Readonly<Record<ListingStatus, readonly ListingStatus[]>> = {
  OPEN_FOR_OFFERS: ['OFFER_PERIOD_CLOSED', 'OFFER_SELECTED', 'CANCELLED', 'EXPIRED'],
  // A supplier may accept at any time while the listing is open — waiting
  // for the offer deadline is explicitly NOT required (contract, /accept).
  OFFER_PERIOD_CLOSED: ['AWAITING_SELECTION', 'OFFER_SELECTED', 'EXPIRED', 'CANCELLED'],
  AWAITING_SELECTION: ['OFFER_SELECTED', 'EXPIRED', 'CANCELLED'],
  OFFER_SELECTED: [],
  EXPIRED: [],
  CANCELLED: [],
};

export function canTransitionOffer(from: OfferStatus, to: OfferStatus): boolean {
  return OFFER_TRANSITIONS[from].includes(to);
}

export function canTransitionListing(from: ListingStatus, to: ListingStatus): boolean {
  return LISTING_TRANSITIONS[from].includes(to);
}

/**
 * Statuses that occupy the "one current offer per bank per listing" slot.
 *
 * Mirrors `uq_one_current_offer_per_bank`, the partial unique index. Kept in
 * sync by hand and asserted by a test, because the two drifting apart would
 * show up as a 500 from a constraint the service did not expect.
 */
const CURRENT_OFFER_STATUSES: readonly OfferStatus[] = [
  'DRAFT',
  'PENDING_INTERNAL_APPROVAL',
  'ACTIVE',
];

export function occupiesCurrentSlot(status: OfferStatus): boolean {
  return CURRENT_OFFER_STATUSES.includes(status);
}

/** Editable by the bank that created it. */
export function isEditable(status: OfferStatus): boolean {
  return status === 'DRAFT' || status === 'PENDING_INTERNAL_APPROVAL' || status === 'ACTIVE';
}

/** Withdrawable without penalty — pre-acceptance only (ZM-OFR-015). */
export function isWithdrawable(status: OfferStatus): boolean {
  return status === 'DRAFT' || status === 'PENDING_INTERNAL_APPROVAL' || status === 'ACTIVE';
}

/** Visible to the supplier on the comparison screen. */
export function isVisibleToSupplier(status: OfferStatus): boolean {
  return status === 'ACTIVE' || status === 'SELECTED';
}

/**
 * Whether the listing still accepts offer creation, revision or withdrawal.
 *
 * ZM-MKT-009: nothing moves after the submission deadline. Enforced on the
 * *status*, which the deadline job maintains, rather than by comparing to the
 * clock at every call site — one place decides the window has closed, and it
 * writes that decision down.
 */
export function acceptsOfferActivity(status: ListingStatus): boolean {
  return status === 'OPEN_FOR_OFFERS';
}
