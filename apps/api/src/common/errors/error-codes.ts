/**
 * Stable, machine-readable error codes.
 *
 * Contract rule 6: `code` is stable and machine-readable, `message` is
 * localized and for humans. Agent B branches on `code`, never on the message
 * and — per D-14 — never on the HTTP status either (the contract uses 401
 * for a wrong funding OTP, which sits confusingly next to auth 401s).
 *
 * Adding a code is additive. Changing or removing one is a contract change.
 */
export const ErrorCode = {
  // --- Authentication and context ---------------------------------------
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_TOKEN: 'INVALID_TOKEN',
  /** X-Organization-Id absent. Cross-cutting rule 1 → 403, not 400. */
  ORGANIZATION_CONTEXT_REQUIRED: 'ORGANIZATION_CONTEXT_REQUIRED',
  /** Header names an org the user has no ACTIVE membership in. */
  ORGANIZATION_CONTEXT_INVALID: 'ORGANIZATION_CONTEXT_INVALID',
  INSUFFICIENT_ROLE: 'INSUFFICIENT_ROLE',
  USER_SUSPENDED: 'USER_SUSPENDED',
  ORGANIZATION_NOT_ACTIVE: 'ORGANIZATION_NOT_ACTIVE',

  // --- Generic ----------------------------------------------------------
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',

  // --- Domain (used from the phase that implements each) ----------------
  /**
   * The offer's net payout is below the supplier's private floor.
   * Deliberately says nothing about the gap or the floor: this message is
   * bank-facing, and INV-8's sentinel scan asserts the response body carries
   * no numeric content other than the bank's own figures.
   */
  OFFER_BELOW_SUPPLIER_REQUIREMENT: 'OFFER_BELOW_SUPPLIER_REQUIREMENT',
  SELF_APPROVAL_FORBIDDEN: 'SELF_APPROVAL_FORBIDDEN',
  TRANSACTION_ALREADY_LOCKED: 'TRANSACTION_ALREADY_LOCKED',
  OFFER_NOT_ACTIVE: 'OFFER_NOT_ACTIVE',
  OFFER_EXPIRED: 'OFFER_EXPIRED',
  DUPLICATE_INVOICE: 'DUPLICATE_INVOICE',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  OTP_INVALID: 'OTP_INVALID',
  OTP_EXPIRED: 'OTP_EXPIRED',
  OTP_MAX_ATTEMPTS: 'OTP_MAX_ATTEMPTS',
  BUYER_BLOCKED: 'BUYER_BLOCKED',
  DEMO_DISABLED: 'DEMO_DISABLED',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];
