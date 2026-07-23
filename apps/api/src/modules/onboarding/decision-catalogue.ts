/**
 * The unified decision and consent catalogues (Q-06 / Q-09 resolutions).
 *
 * Mirrored by `apps/web/lib/onboarding/reason-codes.ts` and `consents.ts` —
 * the two halves validated against different vocabularies during Phase 2 and
 * neither side noticed, because this side accepted any string. Validation
 * here is what turns future drift into a loud 422 instead of silent data.
 *
 * Changing a code is a cross-half change: update the web catalogue and its
 * display copy in the same commit.
 */

/** Codes a reviewer may supply on POST …/decide. ZM-SON-012/013 + §5.6/§5.7. */
export const REVIEWER_REASON_CODES: ReadonlySet<string> = new Set([
  'COMPANY_NOT_ACTIVE',
  'COMPANY_NOT_FOUND',
  'COMPANY_IN_LIQUIDATION',
  'LICENCE_NOT_VALID',
  'SIGNATORY_AUTHENTICITY_FAILED',
  'ESSENTIAL_CONSENT_REFUSED',
  'BANK_ACCOUNT_OWNERSHIP_UNPROVEN',
  'LEGAL_PROHIBITION_OR_SANCTIONS_MATCH',
  'ENTITY_TYPE_NOT_ELIGIBLE_V3',
  'ESSENTIAL_FIELD_MISSING',
  'SIGNATORY_EVIDENCE_REQUIRED',
  'LICENCE_COPY_REQUIRED',
  'OPERATIONAL_ITEM_OUTSTANDING',
]);

/**
 * Codes the automated hard-rejection rules emit (application-state.ts).
 * Deliberately NOT reviewer-suppliable: a reviewer asserting a registry fact
 * by hand would bypass the automated check that proves it.
 */
export const AUTOMATED_REASON_CODES: ReadonlySet<string> = new Set([
  'ENTITY_NOT_FOUND_IN_REGISTRY',
  'SOLE_PROPRIETORSHIP_NOT_ELIGIBLE',
  'REGISTRY_STATUS_SUSPENDED',
  'REGISTRY_STATUS_STRUCK_OFF',
  'REGISTRY_STATUS_UNDER_LIQUIDATION',
  'LICENCE_SUSPENDED',
  'LICENCE_CANCELLED',
]);

/**
 * The four essential consent types, all required before submission
 * (ZM-SON-012's essential-consent rule), all currently at version "1.0".
 * The wizard sends exactly these; the seed records exactly these.
 */
export const CONSENT_TYPES: ReadonlySet<string> = new Set([
  'GOVERNMENT_LOOKUP_AUTHORIZATION',
  'BANK_DISCLOSURE_AUTHORIZATION',
  'TERMS_OF_SERVICE',
  'PRIVACY_POLICY',
]);

export const CONSENT_VERSION = '1.0';
