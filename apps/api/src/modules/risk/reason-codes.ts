/**
 * The structured risk reason-code catalogue (ZM-RSK-012).
 *
 * Same pattern, and the same reasoning, as `onboarding/decision-catalogue.ts`
 * and `transactions/declaration-catalogue.ts`. Three times now the project has
 * paid for a vocabulary that lived only in one half's head — Q-06 (decision
 * reasons), Q-09 (consents), Q-13 (declaration versions) — so this one is
 * written as a catalogue on the first day rather than after the divergence.
 *
 * A reason code is a stable identifier, never a message. The English text
 * here is documentation for whoever reads this file; the strings a supplier
 * or a banker actually sees are looked up by code in the web locale files, so
 * the two languages ZM-RSK-002 requires are B's to render and neither half
 * has to parse the other's prose.
 *
 * Codes are grouped by what produced them, because the groups have different
 * force:
 *
 *   BLOCK_*   a deterministic hard blocker. The ML model cannot override one
 *             (ZM-RSK-015) — see `rules-engine.ts`.
 *   RISK_*    an adverse factor that legitimately lowers a component.
 *   POS_*     a positive factor.
 *   INFO_*    an observation that must NOT move the score, most importantly
 *             an unavailable source (ZM-RSK-005/006, INV-9). These exist so
 *             that "we could not see this" is still *reportable* without
 *             being *punishable*, which is the distinction ZM-RSK-008
 *             requires be preserved structurally at every layer.
 */

export const BLOCK_CODES = {
  BUYER_STRUCK_OFF: 'BLOCK_BUYER_STRUCK_OFF',
  BUYER_SUSPENDED: 'BLOCK_BUYER_SUSPENDED',
  SUPPLIER_NOT_ACTIVE: 'BLOCK_SUPPLIER_NOT_ACTIVE',
  DUPLICATE_INVOICE: 'BLOCK_DUPLICATE_INVOICE',
  FILE_INTEGRITY_FAILED: 'BLOCK_FILE_INTEGRITY_FAILED',
  INVOICE_PAST_DUE: 'BLOCK_INVOICE_PAST_DUE',
  TENOR_TOO_SHORT: 'BLOCK_TENOR_TOO_SHORT',
  DECLARATIONS_MISSING: 'BLOCK_DECLARATIONS_MISSING',
  NO_ELECTRONIC_INVOICE: 'BLOCK_NO_ELECTRONIC_INVOICE',
} as const;

export const RISK_CODES = {
  BUYER_UNDER_LIQUIDATION: 'RISK_BUYER_UNDER_LIQUIDATION',
  BUYER_NOT_IN_REGISTRY: 'RISK_BUYER_NOT_IN_REGISTRY',
  OCR_MISMATCH: 'RISK_OCR_MISMATCH',
  QR_INVALID: 'RISK_QR_INVALID',
  QR_UNPARSED: 'RISK_QR_UNPARSED',
  SHORT_TENOR: 'RISK_SHORT_TENOR',
  LONG_TENOR: 'RISK_LONG_TENOR',
  NEW_BUYER_RELATIONSHIP: 'RISK_NEW_BUYER_RELATIONSHIP',
  NO_PLATFORM_HISTORY: 'RISK_NO_PLATFORM_HISTORY',
  PRIOR_DUPLICATE_REFERRAL: 'RISK_PRIOR_DUPLICATE_REFERRAL',
  PRIOR_DISPUTE: 'RISK_PRIOR_DISPUTE',
  PRIOR_RECOURSE: 'RISK_PRIOR_RECOURSE',
  PARTIAL_PAYMENT_RECORDED: 'RISK_PARTIAL_PAYMENT_RECORDED',
  STALE_GOVERNMENT_SNAPSHOT: 'RISK_STALE_GOVERNMENT_SNAPSHOT',
} as const;

export const POSITIVE_CODES = {
  BUYER_ACTIVE_REGISTRY: 'POS_BUYER_ACTIVE_REGISTRY',
  ESTABLISHED_RELATIONSHIP: 'POS_ESTABLISHED_RELATIONSHIP',
  BUYER_PAYMENT_HISTORY: 'POS_BUYER_PAYMENT_HISTORY',
  SUPPLIER_FULLY_VERIFIED: 'POS_SUPPLIER_FULLY_VERIFIED',
  EINVOICE_QR_VALID: 'POS_EINVOICE_QR_VALID',
  OCR_MATCHES_ENTRY: 'POS_OCR_MATCHES_ENTRY',
  CLEAN_PLATFORM_RECORD: 'POS_CLEAN_PLATFORM_RECORD',
  GOVERNMENT_VERIFIED: 'POS_GOVERNMENT_VERIFIED',
} as const;

/**
 * Observations that never move a component.
 *
 * Every code here describes a gap in what the platform could see, never a
 * fact about the supplier. `scoring.ts` cannot express "this code lowered a
 * score" for these, because an unavailable signal is dropped from both the
 * numerator and the denominator rather than being scored as zero.
 */
export const INFO_CODES = {
  GOVERNMENT_SOURCE_UNAVAILABLE: 'INFO_GOVERNMENT_SOURCE_UNAVAILABLE',
  FIELD_NOT_PUBLISHED: 'INFO_FIELD_NOT_PUBLISHED',
  BUYER_DATA_UNAVAILABLE: 'INFO_BUYER_DATA_UNAVAILABLE',
  ML_UNAVAILABLE: 'INFO_ML_UNAVAILABLE',
  SYNTHETIC_TRAINING_DATA: 'INFO_SYNTHETIC_TRAINING_DATA',
} as const;

export const ALL_REASON_CODES: ReadonlySet<string> = new Set([
  ...Object.values(BLOCK_CODES),
  ...Object.values(RISK_CODES),
  ...Object.values(POSITIVE_CODES),
  ...Object.values(INFO_CODES),
]);

/**
 * Codes that must never be capable of reducing a score component.
 *
 * Exported so the INV-9 test can assert over the catalogue itself rather than
 * over a hand-written list that would drift from it.
 */
export const NON_SCORING_CODES: ReadonlySet<string> = new Set(Object.values(INFO_CODES));

export function isKnownReasonCode(code: string): boolean {
  return ALL_REASON_CODES.has(code);
}
