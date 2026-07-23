/**
 * The inputs to scoring, and the type that makes INV-9 structural.
 *
 * Every fact the platform did not obtain is represented as `Unavailable`,
 * never as a zero, an empty string, or a `null` that scoring might quietly
 * treat as bad news. This is the same technique `government-adapter.ts` uses
 * for lookup results, extended to the individual field: there is no way to
 * write a scoring rule that reads the value of an unavailable fact, because
 * an unavailable fact has no `value` property to read.
 *
 * That matters because INV-9 is not really a rule about arithmetic — it is a
 * rule about the difference between *"the buyer's registry status is bad"*
 * and *"we could not reach the registry"*. A `number | null` collapses those
 * two into one shape and leaves the distinction to whoever writes the next
 * `?? 0`. This does not.
 */

/** Why a fact is missing. Both are absences; neither is a finding. */
export type UnavailableReason =
  /** The source did not answer at all — downtime, timeout, transport error. */
  | 'SOURCE_UNAVAILABLE'
  /** The source answered, but does not publish this field for this subject. */
  | 'NOT_PUBLISHED';

export interface Known<T> {
  readonly available: true;
  readonly value: T;
}

export interface Unavailable {
  readonly available: false;
  readonly reason: UnavailableReason;
}

/**
 * A fact that may or may not have been obtainable.
 *
 * Note there is deliberately no `Maybe<T>.valueOr(default)` helper. A default
 * is exactly the thing that turns an absence into a score, and providing the
 * convenience would be providing the defect.
 */
export type Maybe<T> = Known<T> | Unavailable;

export function known<T>(value: T): Known<T> {
  return { available: true, value };
}

export function unavailable(reason: UnavailableReason = 'SOURCE_UNAVAILABLE'): Unavailable {
  return { available: false, reason };
}

/** Government provenance for a single field (ZM-GOV-002, Q-05's resolved shape). */
export type SourceKind = 'GOVERNMENT' | 'SELF_DECLARED' | 'DERIVED';

export interface ProvenancedField {
  readonly sourceKind: SourceKind;
  /** Days since the snapshot was retrieved. */
  readonly ageDays: number;
}

export interface SupplierFacts {
  readonly organizationId: string;
  /** From our own tables, so always known. */
  readonly status: string;
  readonly registryStatus: Maybe<string>;
  readonly bankAccountVerified: Maybe<boolean>;
  readonly signatoryMatches: Maybe<boolean>;
  readonly taxStatusValid: Maybe<boolean>;
  /** One entry per government-sourced field the platform holds. */
  readonly provenance: readonly ProvenancedField[];
  /**
   * Fields a source was expected to supply and did not, because the source
   * did not answer. Counted in availability, never in any component.
   */
  readonly unobtainedFieldCount: number;
  readonly expectedFieldCount: number;
}

export interface BuyerFacts {
  readonly registryStatus: Maybe<string>;
  readonly companyAgeYears: Maybe<number>;
  /** Prior completed transactions between THIS supplier and THIS buyer. */
  readonly priorTransactionsWithSupplier: Maybe<number>;
  /** Buyer payments settled on time, platform-wide. */
  readonly onTimePaymentRatio: Maybe<number>;
}

export interface InvoiceFacts {
  readonly present: boolean;
  readonly tenorDays: Maybe<number>;
  readonly minTenorDays: number;
  readonly pastDue: boolean;
  readonly completenessRatio: Maybe<number>;
  readonly electronicInvoiceAttached: boolean;
  readonly fileIntegrityOk: Maybe<boolean>;
  readonly ocrConsistent: Maybe<boolean>;
  readonly qrStatus: Maybe<'VALID' | 'INVALID' | 'UNPARSED' | 'UNAVAILABLE'>;
  readonly duplicateCollision: boolean;
  readonly partiallyPaid: boolean;
  readonly declarationsRecorded: boolean;
}

export interface PlatformBehaviorFacts {
  /** All from our own tables — the platform always knows its own history. */
  readonly priorSubmittedCount: number;
  readonly disputeCount: number;
  readonly duplicateReferralCount: number;
  readonly recourseCount: number;
}

export interface RiskFacts {
  readonly transactionId: string;
  readonly supplier: SupplierFacts;
  readonly buyer: BuyerFacts;
  readonly invoice: InvoiceFacts;
  readonly platform: PlatformBehaviorFacts;
}
