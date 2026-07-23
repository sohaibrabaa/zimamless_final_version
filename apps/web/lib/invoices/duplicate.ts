import { ApiError } from "@/lib/api/client";

/**
 * Reading the duplicate-fingerprint refusal.
 *
 * ZM-VER-001: the active-invoice fingerprint is unique platform-wide; a
 * collision blocks submission **and opens a review record**. The phase file
 * requires the blocked screen to show that record's reference, so the supplier
 * has something to quote when they contact the platform — a dead end with no
 * reference is the difference between "blocked" and "abandoned".
 *
 * `POST /transactions/{id}/submit` declares `409 Duplicate invoice fingerprint
 * detected` with the standard `Error` envelope, whose `details` is
 * `additionalProperties: true`. So the code is declared and reliable; the
 * review reference lives in a free-form object with no declared key. This
 * module is the single place that assumes one, and it degrades to "no
 * reference available" rather than rendering `undefined` or inventing a value.
 * Filed as **Q-11** — the same class of gap as Q-05, and isolated the same way.
 */

export const DUPLICATE_ERROR_CODES = ["DUPLICATE_INVOICE", "DUPLICATE_FINGERPRINT"] as const;

export interface DuplicateBlock {
  /** Review-record reference to quote to support, when the server sends one. */
  reviewReference: string | null;
  correlationId: string | null;
}

function firstString(source: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

/**
 * Returns duplicate-block details when `error` is the 409 from `submit`, and
 * null for anything else — including a 409 with a different code, which is a
 * different refusal and must not be rendered as a duplicate.
 */
export function readDuplicateBlock(error: unknown): DuplicateBlock | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status !== 409) return null;
  if (!DUPLICATE_ERROR_CODES.includes(error.code as (typeof DUPLICATE_ERROR_CODES)[number])) {
    return null;
  }

  const details = (error.details ?? {}) as Record<string, unknown>;
  return {
    reviewReference: firstString(details, [
      "reviewReference",
      "reviewRecordId",
      "reviewId",
      "caseReference",
    ]),
    // Always present on the live envelope, and worth surfacing: it is what
    // makes a support request tractable when no review reference came back.
    correlationId: error.correlationId ?? null,
  };
}
