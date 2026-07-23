/**
 * The accepted supplier-declaration template versions (Q-13 resolution).
 *
 * Same pattern, and same reasoning, as `onboarding/decision-catalogue.ts`:
 * this value is client-supplied and `required`, and the frozen pack declares
 * no catalogue for it. Until this file existed the service accepted **any**
 * non-empty string, which is exactly the shape of the Q-09 consent-vocabulary
 * defect — the two halves each picked a value, neither side validated, and
 * the divergence would only have surfaced on the first integration day.
 *
 * LT-04 makes the declaration text a versioned template whose accepted
 * version is stored per submission. A version the platform does not
 * recognise cannot be that: it would record an affirmation against wording
 * nobody can produce, which is precisely what the recourse and indemnity
 * provisions rest on.
 *
 * Mirrored by `apps/web/lib/invoices/declarations.ts`
 * (`DECLARATION_TEMPLATE_VERSION`). Adding a version is a cross-half change:
 * add it here, update the web constant and the declaration copy in both
 * locales, in the same commit.
 */
export const DECLARATION_TEMPLATE_VERSIONS: ReadonlySet<string> = new Set(['1.0']);

/** The version new submissions should carry — the latest published template. */
export const CURRENT_DECLARATION_TEMPLATE_VERSION = '1.0';
