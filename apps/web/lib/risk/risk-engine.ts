import type { RiskAssessment, RiskBand } from "./risk-presentation";
import { BAND_THRESHOLDS } from "./risk-presentation";

/**
 * A deterministic, client-side stand-in for Agent A's scoring engine
 * (requirements §9, phase file A tasks). This is a mock, not a model — the
 * real composite score, weighting and ML inference are A's Phase 4 work.
 * What this module exists to get right, because it is what B's screens are
 * graded against, is the **shape** of the score and the one invariant the
 * phase's checkpoint drills for: `dataAvailabilityPct` is computed from a
 * wholly separate input than the five components, so no combination of
 * government-source outages can move a component (ZM-RSK-005/006/008).
 */

export interface SourceAvailability {
  ccdAvailable: boolean;
  istdAvailable: boolean;
  gamAvailable: boolean;
}

export const FULLY_AVAILABLE: SourceAvailability = {
  ccdAvailable: true,
  istdAvailable: true,
  gamAvailable: true,
};

export interface RiskInputs {
  /** ACTIVE / SUSPENDED / STRUCK_OFF / UNDER_LIQUIDATION / UNKNOWN, or undefined if no buyer yet. */
  buyerRegistryStatus: string | undefined;
  /** The transaction's own verification outcome — feeds Invoice Score only. */
  verificationOverallResult: "PASS" | "FAIL" | "REVIEW" | undefined;
  tenorDays: number | null;
  /** Prior fingerprint collisions or similar conduct signals for this supplier. */
  priorDuplicateFlags: number;
  /**
   * Whether each government source answered for the *supplier's own*
   * onboarding verification. This is the only input that may touch
   * `dataAvailabilityPct` — it must never reach a component formula.
   */
  sourceAvailability: SourceAvailability;
  mlUsed: boolean;
  mlFallbackReason?: string;
}

export const MODEL_VERSION = "risk-model-2026.07-demo";

function bandForScore(score: number): RiskBand {
  if (score >= BAND_THRESHOLDS.LOW.min) return "LOW";
  if (score >= BAND_THRESHOLDS.MEDIUM.min) return "MEDIUM";
  if (score >= BAND_THRESHOLDS.HIGH.min) return "HIGH";
  return "CRITICAL";
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * Buyer Profile component. Reads the buyer's *registry status* only — a
 * confirmed adverse status is exactly the kind of input ZM-RSK-007 says
 * legitimately affects the score, unlike a source that merely didn't answer.
 */
function buyerProfileScore(status: string | undefined): number {
  switch (status) {
    case "ACTIVE":
      return 82;
    case "UNDER_LIQUIDATION":
      return 38;
    case "UNKNOWN":
      return 55;
    default:
      // No buyer linked yet, or a status this demo model doesn't recognise —
      // treated as unknown rather than penalised for a shape it can't read.
      return 55;
  }
}

/** Invoice Score component. Reads the transaction's own verification result and tenor. */
function invoiceScore(result: RiskInputs["verificationOverallResult"], tenorDays: number | null): number {
  const base = result === "PASS" ? 85 : result === "REVIEW" ? 55 : result === "FAIL" ? 15 : 50;
  const tenorPenalty = tenorDays !== null && tenorDays < 7 ? 20 : 0;
  return clamp(base - tenorPenalty);
}

/** Platform Behavior component. Duplicate-fingerprint flags are conduct, not data availability. */
function platformBehaviorScore(priorDuplicateFlags: number): number {
  return clamp(88 - priorDuplicateFlags * 25);
}

/**
 * The demo model's fixed baselines for Supplier Verification and Data
 * Confidence. Both are held constant in this mock precisely because neither
 * may be driven by `sourceAvailability` — varying them with the very input
 * that must not touch them would be the bug INV-9 exists to catch, reproduced
 * in the thing meant to demonstrate the fix.
 */
const SUPPLIER_VERIFICATION_BASELINE = 74;
const DATA_CONFIDENCE_BASELINE = 70;

/**
 * `dataAvailabilityPct` — the *only* function in this module that reads
 * `sourceAvailability`. Three government sources for the supplier's own
 * onboarding verification (CCD/ISTD/GAM, per GOV_DUMMY_DATA.md §6a); the
 * percentage answered.
 */
function computeDataAvailabilityPct(availability: SourceAvailability): number {
  const sources = [availability.ccdAvailable, availability.istdAvailable, availability.gamAvailable];
  const answered = sources.filter(Boolean).length;
  return Math.round((answered / sources.length) * 100);
}

function positiveFactorsFor(inputs: RiskInputs, components: RiskAssessment["components"]): string[] {
  const factors: string[] = [];
  if (inputs.buyerRegistryStatus === "ACTIVE") factors.push("risk.factor.positive.buyerActive");
  if (inputs.verificationOverallResult === "PASS") factors.push("risk.factor.positive.verificationPassed");
  if ((components?.platformBehavior ?? 0) >= 80) factors.push("risk.factor.positive.cleanHistory");
  return factors;
}

function riskFactorsFor(inputs: RiskInputs): string[] {
  const factors: string[] = [];
  if (inputs.buyerRegistryStatus === "UNDER_LIQUIDATION") factors.push("risk.factor.risk.buyerLiquidation");
  if (inputs.verificationOverallResult === "REVIEW") factors.push("risk.factor.risk.verificationReview");
  if (inputs.tenorDays !== null && inputs.tenorDays < 7) factors.push("risk.factor.risk.shortTenor");
  if (inputs.priorDuplicateFlags > 0) factors.push("risk.factor.risk.priorDuplicate");
  return factors;
}

function reasonCodesFor(inputs: RiskInputs, dataAvailabilityPct: number): string[] {
  const codes: string[] = [];
  if (dataAvailabilityPct < 100) codes.push("PARTIAL_GOVERNMENT_DATA");
  if (inputs.buyerRegistryStatus === "UNDER_LIQUIDATION") codes.push("BUYER_UNDER_LIQUIDATION");
  if (inputs.verificationOverallResult === "REVIEW") codes.push("VERIFICATION_NEEDS_REVIEW");
  if (codes.length === 0) codes.push("STANDARD_PROFILE");
  return codes;
}

/**
 * The pure computation. Two calls that agree on everything except
 * `sourceAvailability` must return byte-identical `components` and differ
 * only in `dataAvailabilityPct` — that equality is INV-9, and it is asserted
 * directly against this function rather than through the store or a screen.
 */
export function computeRiskAssessment(
  inputs: RiskInputs,
  calculatedAt: string
): RiskAssessment {
  const components: NonNullable<RiskAssessment["components"]> = {
    supplierVerification: SUPPLIER_VERIFICATION_BASELINE,
    dataConfidence: DATA_CONFIDENCE_BASELINE,
    buyerProfile: buyerProfileScore(inputs.buyerRegistryStatus),
    invoiceScore: invoiceScore(inputs.verificationOverallResult, inputs.tenorDays),
    platformBehavior: platformBehaviorScore(inputs.priorDuplicateFlags),
  };

  const compositeScore = clamp(
    (components.supplierVerification! +
      components.dataConfidence! +
      components.buyerProfile! +
      components.invoiceScore! +
      components.platformBehavior!) /
      5
  );

  const dataAvailabilityPct = computeDataAvailabilityPct(inputs.sourceAvailability);

  return {
    compositeScore,
    band: bandForScore(compositeScore),
    components,
    dataAvailabilityPct,
    positiveFactors: positiveFactorsFor(inputs, components),
    riskFactors: riskFactorsFor(inputs),
    reasonCodes: reasonCodesFor(inputs, dataAvailabilityPct),
    modelVersion: MODEL_VERSION,
    mlUsed: inputs.mlUsed,
    mlFallbackReason: inputs.mlUsed ? undefined : inputs.mlFallbackReason,
    calculatedAt,
    disclaimer: "Decision support only. Not a guarantee or credit rating.",
  };
}
