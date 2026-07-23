/**
 * Buyer registry-status policy and search-ambiguity rules (§7.4).
 *
 * Pure functions, deliberately: these are the decisions the phase's
 * "never auto-select" test and the blocked-buyer tests assert on, and they
 * are far easier to prove correct when they do not need a database.
 */

export type RegistryStatusValue =
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'STRUCK_OFF'
  | 'UNDER_LIQUIDATION'
  | 'UNKNOWN';

export type MatchSource = 'OWN_RELATIONSHIP' | 'PLATFORM' | 'REGISTRY';

export interface BuyerCandidate {
  nationalEstablishmentNumber: string | null;
  legalCompanyName: string;
  companyType: string | null;
  registryStatus: RegistryStatusValue;
  governorate: string | null;
  matchSource: MatchSource;
  /** Null when the candidate came from the registry and has no local row yet. */
  buyerId: string | null;
}

/**
 * Statuses that block financing outright (§7.4).
 *
 * `UNDER_LIQUIDATION` is deliberately absent: LT-02 routes it to manual
 * review instead. A company in liquidation can still owe money, and whether
 * that receivable is financeable is a judgement rather than a rule.
 */
const BLOCKING: ReadonlySet<RegistryStatusValue> = new Set(['SUSPENDED', 'STRUCK_OFF']);

export function isBlockingStatus(status: RegistryStatusValue): boolean {
  return BLOCKING.has(status);
}

export function requiresManualReviewStatus(status: RegistryStatusValue): boolean {
  return status === 'UNDER_LIQUIDATION' || status === 'UNKNOWN';
}

/**
 * Whether a search result is ambiguous enough to need a human (ZM-BUY-010).
 *
 * Note what this function cannot do: it returns a boolean, never a chosen
 * candidate. ZM-BUY-009 forbids auto-selection "under any circumstances",
 * and the cheapest way to keep that true as the code grows is for the
 * ambiguity check to have no way to express a selection in the first place.
 *
 * A single exact match is still not a selection — it is one candidate, and
 * the supplier must still confirm it. That is the case most likely to be
 * "optimised" later by someone reasoning that one perfect match is
 * unambiguous; it is, and the supplier confirms it anyway, because the
 * platform must never be the party that decided who the debtor was.
 */
export function needsManualReview(candidates: readonly BuyerCandidate[]): boolean {
  if (candidates.length === 0) return true;
  if (candidates.some((c) => requiresManualReviewStatus(c.registryStatus))) return true;
  // Several candidates that are not obviously the same company.
  if (candidates.length > 1) {
    const distinctNumbers = new Set(
      candidates.map((c) => c.nationalEstablishmentNumber).filter(Boolean),
    );
    if (distinctNumbers.size > 1) return true;
  }
  return false;
}

/**
 * The `buyer_resolution_status` recorded for a *search* attempt.
 *
 * `MATCHED` is deliberately never returned here. It means "this supplier is
 * now linked to this buyer", which only `/buyers/resolve` can bring about —
 * a search that found one perfect candidate has still matched nothing,
 * because nobody has confirmed anything yet. Recording MATCHED on a search
 * would put a row in the audit trail asserting a link that does not exist.
 */
export function resolutionStatusFor(
  candidates: readonly BuyerCandidate[],
  requiresManualReview: boolean,
): string {
  if (candidates.length === 0) return 'NOT_FOUND';
  if (candidates.every((c) => isBlockingStatus(c.registryStatus))) return 'BLOCKED';
  if (requiresManualReview) return 'MANUAL_REVIEW';
  return 'PARTIAL_MATCH';
}
