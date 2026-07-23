import type { components } from "@/lib/api/generated/schema";
import type { BadgeTone } from "@/components/ui/Badge";

export type VerificationRun = components["schemas"]["VerificationRun"];
export type VerificationCheck = NonNullable<VerificationRun["checks"]>[number];
export type CheckResult = NonNullable<VerificationCheck["result"]>;

/**
 * The eight automated checks (requirements §8.5), in the order that table
 * lists them. `checkType` is a bare string in the contract, so this is the
 * client's transcription of the same eight rows — the ordering and labelling
 * only; an unrecognised check type still renders, labelled by its own code.
 */
export const CHECK_TYPES = [
  "COMPLETENESS",
  "IDENTITY_MATCH",
  "DUPLICATE_DETECTION",
  "TRANSACTION_LOGIC",
  "PARTY_ELIGIBILITY",
  "FILE_INTEGRITY",
  "OCR_CONSISTENCY",
  "QR_CONSISTENCY",
] as const;

export type CheckType = (typeof CHECK_TYPES)[number];

const CHECK_ORDER = new Map<string, number>(CHECK_TYPES.map((t, i) => [t, i]));

export function checkLabelKey(checkType: string | undefined): string {
  return CHECK_ORDER.has(checkType ?? "")
    ? `invoices.verification.check.${checkType}`
    : "invoices.verification.check.OTHER";
}

/**
 * Tone per check result.
 *
 * ZM-VER-002 is explicit that a failed check is not proven fraud — it routes
 * to review. So `REVIEW` is informational, not a warning, and `MISSING` and
 * `UNPARSED` are neutral: they say the platform does not have something, not
 * that the supplier did anything. Only an outright `FAIL` is adverse, and even
 * that is a check result rather than a verdict on the transaction.
 */
export function checkResultTone(result: string | undefined): BadgeTone {
  switch (result) {
    case "PASS":
      return "success";
    case "FAIL":
      return "danger";
    case "REVIEW":
      return "info";
    case "MISSING":
    case "UNPARSED":
    case "NOT_APPLICABLE":
      return "neutral";
    default:
      return "neutral";
  }
}

export function checkResultLabelKey(result: string | undefined): string {
  const known: CheckResult[] = ["PASS", "FAIL", "REVIEW", "MISSING", "UNPARSED", "NOT_APPLICABLE"];
  return known.includes(result as CheckResult)
    ? `invoices.verification.result.${result}`
    : "invoices.verification.result.UNKNOWN";
}

export function overallResultTone(result: string | undefined): BadgeTone {
  switch (result) {
    case "PASS":
      return "success";
    case "FAIL":
      return "danger";
    case "REVIEW":
      return "info";
    default:
      return "neutral";
  }
}

export function overallResultLabelKey(result: string | undefined): string {
  return result === "PASS" || result === "FAIL" || result === "REVIEW"
    ? `invoices.verification.overall.${result}`
    : "invoices.verification.overall.UNKNOWN";
}

/**
 * Checks in the §8.5 table order, with unrecognised types appended rather than
 * dropped. Sorting by result (failures first) was deliberately not done: it
 * would make the panel's shape depend on the outcome, and a supplier comparing
 * two transactions should find the same check in the same place.
 */
export function orderedChecks(run: VerificationRun | null | undefined): VerificationCheck[] {
  const checks = run?.checks ?? [];
  return [...checks].sort((a, b) => {
    const ai = CHECK_ORDER.get(a.checkType ?? "") ?? Number.MAX_SAFE_INTEGER;
    const bi = CHECK_ORDER.get(b.checkType ?? "") ?? Number.MAX_SAFE_INTEGER;
    return ai - bi;
  });
}
