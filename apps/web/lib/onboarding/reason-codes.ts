/**
 * The unified decision reason-code catalogue (Q-06 resolution).
 *
 * Two families, one list. Reviewer-selectable codes are the ZM-SON-012/013
 * transcription this file always held; `automated: true` marks the codes the
 * server itself emits from registry facts on hard rejection
 * (application-state.ts) — those appear on decided applications but are not
 * offered in the reviewer's picker, because a reviewer asserting a registry
 * fact by hand would bypass the automated check that proves it. The server
 * validates reviewer-supplied codes against this same list, so a code that
 * isn't here is a 422, not silent drift.
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
  /** Emitted by the server's automated hard-rejection rules; never reviewer-picked. */
  automated?: boolean;
}

function reason(code: string, outcomes: DecisionOutcome[], automated = false): ReasonCode {
  return {
    code,
    outcomes,
    labelKey: `onboarding.reasonCode.${code}.label`,
    supplierMessageKey: `onboarding.reasonCode.${code}.supplier`,
    automated,
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

  // Server-emitted automated hard-rejection codes (application-state.ts).
  reason("ENTITY_NOT_FOUND_IN_REGISTRY", ["REJECTED"], true),
  reason("SOLE_PROPRIETORSHIP_NOT_ELIGIBLE", ["REJECTED"], true),
  reason("REGISTRY_STATUS_SUSPENDED", ["REJECTED"], true),
  reason("REGISTRY_STATUS_STRUCK_OFF", ["REJECTED"], true),
  reason("REGISTRY_STATUS_UNDER_LIQUIDATION", ["REJECTED"], true),
  reason("LICENCE_SUSPENDED", ["REJECTED"], true),
  reason("LICENCE_CANCELLED", ["REJECTED"], true),
];

export function reasonCodesFor(outcome: DecisionOutcome): ReasonCode[] {
  // Automated codes are excluded: a reviewer asserting a registry fact by
  // hand would bypass the automated check that proves it.
  return REASON_CODES.filter((r) => !r.automated && r.outcomes.includes(outcome));
}

export function findReasonCode(code: string | undefined): ReasonCode | undefined {
  return code ? REASON_CODES.find((r) => r.code === code) : undefined;
}

/**
 * ZM-SON-013 requires the ineligibility message to be clear and non-pejorative,
 * and it is the one rejection reason that gets its own dedicated screen rather
 * than a line on the status page.
 *
 * Two codes trigger it: the server's automated hard rejection emits
 * `SOLE_PROPRIETORSHIP_NOT_ELIGIBLE` (the code live data actually carries),
 * and `ENTITY_TYPE_NOT_ELIGIBLE_V3` remains the reviewer-selectable variant
 * for entity types a future ruling excludes by hand.
 */
export const INELIGIBILITY_CODES = [
  "SOLE_PROPRIETORSHIP_NOT_ELIGIBLE",
  "ENTITY_TYPE_NOT_ELIGIBLE_V3",
] as const;

export function isIneligibility(code: string | undefined): boolean {
  return !!code && (INELIGIBILITY_CODES as readonly string[]).includes(code);
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
