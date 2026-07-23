/**
 * Pure helpers for Phase 6 (selection, conditions, contracts). No React, no
 * mock-store dependency — testable in isolation, same discipline as every
 * other `*-domain.ts` file in this codebase.
 */

export interface ConditionLike {
  isMandatory?: boolean;
  fulfilment?: "PENDING" | "FULFILLED" | "WAIVED" | "FAILED";
}

/** ZM-CON-006: mandatory conditions must be fulfilled OR explicitly waived — PENDING and FAILED both block contract generation. */
export function allMandatoryConditionsResolved(conditions: ConditionLike[]): boolean {
  return conditions
    .filter((c) => c.isMandatory)
    .every((c) => c.fulfilment === "FULFILLED" || c.fulfilment === "WAIVED");
}

export type PreContractCheckFailure =
  | "CONDITIONS_UNFULFILLED"
  | "DECLARATIONS_NOT_RECONFIRMED"
  | "BANK_ACCOUNT_UNVERIFIED";

/** ZM-CON-006's four checks, in the order the requirement lists them (invoice-unchanged is structural in this mock — nothing here mutates a locked invoice, so it is never the failing check). */
export function preContractCheckFailures(input: {
  conditions: ConditionLike[];
  declarationTemplateVersion?: string;
  bankAccountVerified: boolean;
}): PreContractCheckFailure[] {
  const failures: PreContractCheckFailure[] = [];
  if (!allMandatoryConditionsResolved(input.conditions)) failures.push("CONDITIONS_UNFULFILLED");
  if (!input.declarationTemplateVersion) failures.push("DECLARATIONS_NOT_RECONFIRMED");
  if (!input.bankAccountVerified) failures.push("BANK_ACCOUNT_UNVERIFIED");
  return failures;
}

/** ZM-CON-010 default: one authorized supplier signatory + one authorized bank signatory. */
export function isFullySigned(signatures: { organizationType: "SUPPLIER" | "BANK" }[]): boolean {
  return (
    signatures.some((s) => s.organizationType === "SUPPLIER") &&
    signatures.some((s) => s.organizationType === "BANK")
  );
}

/**
 * A small, deterministic, non-cryptographic content hash — enough to prove
 * "this document's bytes did not change" in a mock, not a real digest
 * algorithm. `ZM-CON-005`/`ZM-SEL-007` ask for *a* content hash, not a
 * specific one; `crypto.subtle.digest` is async, and every other hash-like
 * id in this codebase (fingerprints, reference numbers) is already a
 * synchronous string function, which this matches.
 */
export function contentHash(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    hash = (hash * 31 + content.charCodeAt(i)) | 0;
  }
  return `sha-mock-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
