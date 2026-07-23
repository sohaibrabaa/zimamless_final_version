/**
 * Bank policy filters (ZM-MKT-001) and the eligibility evaluation
 * (ZM-MKT-002/003) that decides which banks see which listings.
 *
 * ZM-MKT-003 requires every evaluation to be persisted with its outcome
 * *and* the specific rules applied — `evaluateEligibility` below returns
 * both, and the mock store persists the result rather than recomputing it
 * silently on every read, so "why did/didn't my bank see this" is answerable
 * from stored data, the way the requirement asks for.
 *
 * Two of the ten ZM-MKT-001 filter rows have no counterpart anywhere else in
 * this system and are evaluated as "not applicable" rather than guessed:
 * `sectorsInclude`/`sectorsExclude` (no sector/activity field exists on
 * `Buyer` or the supplier profile in the frozen contract or GOV_DUMMY_DATA)
 * and the transaction/recourse-type filters (those are chosen per OFFER —
 * ZM-OFR-010 — not known at listing time, so there is nothing on a listing
 * to compare them against yet). Both are configurable in the UI below
 * because the requirement lists them as bank-configurable; neither
 * contributes a PASS/FAIL rule until a real per-offer moment exists to
 * evaluate them against.
 */

import { compareMoney, type MoneyString } from "@/lib/money";

export interface PolicyFilterRecord {
  id: string;
  bankOrganizationId: string;
  name: string;
  isActive: boolean;
  minAmount?: MoneyString;
  maxAmount?: MoneyString;
  minTenorDays?: number;
  maxTenorDays?: number;
  acceptedTransactionTypes?: string[];
  acceptedRecourseTypes?: string[];
  minTrustScore?: number;
  maxRiskBand?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  sectorsInclude?: string[];
  sectorsExclude?: string[];
  buyersInclude?: string[];
  buyersExclude?: string[];
  suppliersInclude?: string[];
  suppliersExclude?: string[];
  governoratesInclude?: string[];
  governoratesExclude?: string[];
  requiredDocumentTypes?: string[];
  defaultTransactionType?: string;
}

export interface ListingFacts {
  outstandingAmount: MoneyString;
  tenorDays: number | null;
  compositeScore: number;
  band: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  buyerNationalEstablishmentNumber?: string;
  supplierNationalEstablishmentNumber?: string;
  buyerGovernorate?: string;
  documentTypes: string[];
}

const BAND_ORDER: Record<ListingFacts["band"], number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

export interface EligibilityResult {
  eligible: boolean;
  rulesApplied: string[];
}

/** ZM-MKT-002: both the bank being active/permitted AND matching filters. */
export function evaluateEligibility(
  filter: PolicyFilterRecord | undefined,
  facts: ListingFacts
): EligibilityResult {
  const rulesApplied: string[] = [];

  if (!filter || !filter.isActive) {
    // ZM-MKT-002's second condition has nothing to match against when the
    // bank has configured no active filter — treated as "not opted in"
    // rather than "everything", since an unconfigured filter defaulting to
    // permissive would be the more dangerous of the two guesses.
    rulesApplied.push("NO_ACTIVE_POLICY_FILTER");
    return { eligible: false, rulesApplied };
  }

  let eligible = true;

  if (filter.minAmount !== undefined) {
    rulesApplied.push(`minAmount:${filter.minAmount}`);
    if (compareMoney(facts.outstandingAmount, filter.minAmount) < 0) eligible = false;
  }
  if (filter.maxAmount !== undefined) {
    rulesApplied.push(`maxAmount:${filter.maxAmount}`);
    if (compareMoney(facts.outstandingAmount, filter.maxAmount) > 0) eligible = false;
  }
  if (filter.minTenorDays !== undefined && facts.tenorDays !== null) {
    rulesApplied.push(`minTenorDays:${filter.minTenorDays}`);
    if (facts.tenorDays < filter.minTenorDays) eligible = false;
  }
  if (filter.maxTenorDays !== undefined && facts.tenorDays !== null) {
    rulesApplied.push(`maxTenorDays:${filter.maxTenorDays}`);
    if (facts.tenorDays > filter.maxTenorDays) eligible = false;
  }
  if (filter.minTrustScore !== undefined) {
    rulesApplied.push(`minTrustScore:${filter.minTrustScore}`);
    if (facts.compositeScore < filter.minTrustScore) eligible = false;
  }
  if (filter.maxRiskBand !== undefined) {
    rulesApplied.push(`maxRiskBand:${filter.maxRiskBand}`);
    if (BAND_ORDER[facts.band] > BAND_ORDER[filter.maxRiskBand]) eligible = false;
  }
  if (filter.buyersExclude?.length && facts.buyerNationalEstablishmentNumber) {
    rulesApplied.push("buyersExclude");
    if (filter.buyersExclude.includes(facts.buyerNationalEstablishmentNumber)) eligible = false;
  }
  if (filter.buyersInclude?.length && facts.buyerNationalEstablishmentNumber) {
    rulesApplied.push("buyersInclude");
    if (!filter.buyersInclude.includes(facts.buyerNationalEstablishmentNumber)) eligible = false;
  }
  if (filter.suppliersExclude?.length && facts.supplierNationalEstablishmentNumber) {
    rulesApplied.push("suppliersExclude");
    if (filter.suppliersExclude.includes(facts.supplierNationalEstablishmentNumber)) eligible = false;
  }
  if (filter.suppliersInclude?.length && facts.supplierNationalEstablishmentNumber) {
    rulesApplied.push("suppliersInclude");
    if (!filter.suppliersInclude.includes(facts.supplierNationalEstablishmentNumber)) eligible = false;
  }
  if (filter.governoratesInclude?.length && facts.buyerGovernorate) {
    rulesApplied.push("governoratesInclude");
    if (!filter.governoratesInclude.includes(facts.buyerGovernorate)) eligible = false;
  }
  if (filter.governoratesExclude?.length && facts.buyerGovernorate) {
    rulesApplied.push("governoratesExclude");
    if (filter.governoratesExclude.includes(facts.buyerGovernorate)) eligible = false;
  }
  if (filter.requiredDocumentTypes?.length) {
    rulesApplied.push("requiredDocumentTypes");
    if (!filter.requiredDocumentTypes.every((d) => facts.documentTypes.includes(d))) eligible = false;
  }

  return { eligible, rulesApplied };
}

export const RISK_BAND_OPTIONS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
