/**
 * The government adapter contract.
 *
 * Hard rule 7 / ZM-GOV-008 / ZM-RSK-008, and the fourth defining behaviour
 * of the product: **"the source said something adverse" and "the source did
 * not answer" are different facts and must stay different end to end.**
 *
 * The type system is doing real work here. A result is a discriminated
 * union of *answered* and *unanswered*, so `sourceAvailable` is derived from
 * which case a source returned rather than being a boolean an adapter
 * author might set wrongly. There is no way to construct "unavailable but
 * available", and no way to return field data alongside an unanswered
 * result — the shape that would let unavailability leak into scoring simply
 * does not exist.
 *
 * Why the care: an unavailable source must reduce `dataAvailabilityPct` and
 * nothing else. If it ever reduces a risk component, a supplier is penalised
 * for a government outage they had no part in, and INV-9 is the test that
 * says so.
 */

export type GovSource = 'CCD' | 'ISTD' | 'GAM' | 'EINVOICE';

/** Mirrors the `gov_request_status` enum in the frozen schema. */
export type GovRequestStatus =
  | 'PENDING'
  | 'SUCCESS'
  | 'PARTIAL'
  | 'NOT_FOUND'
  | 'UNAVAILABLE'
  | 'ERROR';

/**
 * The source answered. Its answer may be complete, partial, or "no such
 * entity" — all three are *answers*, and all three are safe to score on.
 */
export interface AnsweredResult {
  kind: 'ANSWERED';
  status: 'SUCCESS' | 'PARTIAL' | 'NOT_FOUND';
  /** Verbatim from the source; persisted unmodified for provenance. */
  raw: Record<string, unknown>;
  /** Mapped to platform field keys. Empty for NOT_FOUND. */
  normalized: Record<string, string>;
  /**
   * Fields this source is expected to supply for the subject. The
   * denominator of dataAvailabilityPct — without it, a PARTIAL answer is
   * indistinguishable from a complete one that happens to be short.
   */
  expectedFields: readonly string[];
}

/**
 * The source did not answer. There is no data and no adverse finding —
 * only an absence, which is a fact about the registry, not about the
 * supplier.
 */
export interface UnansweredResult {
  kind: 'UNANSWERED';
  status: 'UNAVAILABLE' | 'ERROR';
  /** Diagnostic only. Never rendered as a finding about the subject. */
  errorCode: string;
  errorMessage: string;
}

export type GovernmentLookupResult = AnsweredResult | UnansweredResult;

/**
 * `sourceAvailable` for the `government_verification_requests` row.
 *
 * Derived here, in one place, from the union tag. No adapter sets this
 * field itself — that is the whole point of the union.
 */
export function isSourceAvailable(result: GovernmentLookupResult): boolean {
  return result.kind === 'ANSWERED';
}

/**
 * Fraction of expected fields this result actually supplied, 0..1.
 *
 * For an unanswered source this is 0 — and that zero belongs in
 * `dataAvailabilityPct` alone. NOT_FOUND is a complete answer (the registry
 * looked and found nothing), so it scores 1: the platform has full
 * information, and the information is adverse. Conflating the two is
 * precisely the defect hard rule 7 exists to prevent.
 */
export function dataAvailabilityOf(result: GovernmentLookupResult): number {
  if (result.kind === 'UNANSWERED') return 0;
  if (result.status === 'NOT_FOUND') return 1;
  if (result.expectedFields.length === 0) return 1;
  const supplied = result.expectedFields.filter(
    (field) => result.normalized[field] !== undefined && result.normalized[field] !== '',
  ).length;
  return supplied / result.expectedFields.length;
}

/**
 * True when the result is an adverse *finding* about the subject — as
 * opposed to an absence of information. Only ever true for an answered
 * source.
 */
export function isAdverseFinding(result: GovernmentLookupResult): boolean {
  return result.kind === 'ANSWERED' && result.status === 'NOT_FOUND';
}

export interface GovernmentAdapter {
  readonly source: GovSource;
  /** Recorded on every request row so a result can be replayed later. */
  readonly version: string;
  lookup(lookupKey: string): Promise<GovernmentLookupResult>;
}

export const GOVERNMENT_ADAPTERS = Symbol('GOVERNMENT_ADAPTERS');
