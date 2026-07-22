/**
 * Provisional decision reason-code catalogue.
 *
 * `POST /onboarding/applications/{id}/decide` takes `reasonCode` as a bare
 * string with no enum, and no catalogue exists in the frozen pack — escalated
 * as **Q-02** in docs/coordination/OPEN_QUESTIONS.md. These codes are a
 * verbatim transcription of the hard-rejection conditions in ZM-SON-012 plus
 * the ZM-SON-013 ineligibility case; Agent A's accepted values must match this
 * list or `decide` will fail validation at integration.
 *
 * Copy rule (ZM-SON-013, brief §5): supplier-facing text is factual and
 * non-pejorative. It states what the registry shows or what is missing — it
 * never characterises the business.
 */

import type { StatusTone } from "./status";

export type DecisionOutcome =
  | "APPROVED"
  | "APPROVED_CONDITIONAL"
  | "INFORMATION_REQUIRED"
  | "REJECTED";

export interface ReasonCode {
  code: string;
  /** Which decisions this code may accompany. */
  outcomes: DecisionOutcome[];
  /** i18n key for the reviewer-facing label. */
  labelKey: string;
  /** i18n key for the supplier-facing explanation shown on the decision screen. */
  supplierMessageKey: string;
}

function reason(code: string, outcomes: DecisionOutcome[]): ReasonCode {
  return {
    code,
    outcomes,
    labelKey: `onboarding.reasonCode.${code}.label`,
    supplierMessageKey: `onboarding.reasonCode.${code}.supplier`,
  };
}

export const REASON_CODES: ReasonCode[] = [
  // ZM-SON-012 hard rejections.
  reason("COMPANY_NOT_ACTIVE", ["REJECTED"]),
  reason("COMPANY_NOT_FOUND", ["REJECTED"]),
  reason("COMPANY_IN_LIQUIDATION", ["REJECTED"]),
  reason("LICENCE_NOT_VALID", ["REJECTED"]),
  reason("SIGNATORY_AUTHENTICITY_FAILED", ["REJECTED"]),
  reason("ESSENTIAL_CONSENT_REFUSED", ["REJECTED"]),
  reason("BANK_ACCOUNT_OWNERSHIP_UNPROVEN", ["REJECTED", "INFORMATION_REQUIRED"]),
  reason("LEGAL_PROHIBITION_OR_SANCTIONS_MATCH", ["REJECTED"]),
  // ZM-SON-013 ineligibility.
  reason("ENTITY_TYPE_NOT_ELIGIBLE_V3", ["REJECTED"]),
  // §5.6 information requests.
  reason("ESSENTIAL_FIELD_MISSING", ["INFORMATION_REQUIRED"]),
  reason("SIGNATORY_EVIDENCE_REQUIRED", ["INFORMATION_REQUIRED", "APPROVED_CONDITIONAL"]),
  reason("LICENCE_COPY_REQUIRED", ["INFORMATION_REQUIRED", "APPROVED_CONDITIONAL"]),
  // §5.7 conditional approval — non-material operational item outstanding.
  reason("OPERATIONAL_ITEM_OUTSTANDING", ["APPROVED_CONDITIONAL"]),
];

export function reasonCodesFor(outcome: DecisionOutcome): ReasonCode[] {
  return REASON_CODES.filter((r) => r.outcomes.includes(outcome));
}

export function findReasonCode(code: string | undefined): ReasonCode | undefined {
  return code ? REASON_CODES.find((r) => r.code === code) : undefined;
}

/**
 * ZM-SON-013 requires the ineligibility message to be clear and non-pejorative,
 * and it is the one rejection reason that gets its own dedicated screen rather
 * than a line on the status page.
 */
export const INELIGIBILITY_CODE = "ENTITY_TYPE_NOT_ELIGIBLE_V3";

export function isIneligibility(code: string | undefined): boolean {
  return code === INELIGIBILITY_CODE;
}

/**
 * Reviewer-facing tone for a decision option. Rejection is the only genuinely
 * adverse outcome; INFORMATION_REQUIRED is a process step and stays neutral
 * (see the tone rules in ./status.ts).
 */
export function outcomeTone(outcome: DecisionOutcome): StatusTone {
  switch (outcome) {
    case "APPROVED":
      return "success";
    case "APPROVED_CONDITIONAL":
      return "info";
    case "REJECTED":
      return "danger";
    default:
      return "neutral";
  }
}

export const DECISION_OUTCOMES: DecisionOutcome[] = [
  "APPROVED",
  "APPROVED_CONDITIONAL",
  "INFORMATION_REQUIRED",
  "REJECTED",
];
