/**
 * Provisional consent catalogue for the onboarding wizard.
 *
 * `POST /onboarding/applications/{id}/consents` requires the client to supply
 * `consentType` + `consentVersion`, but the frozen pack defines neither the
 * codes nor the versions — escalated as **Q-05**. These four map to the
 * categories in requirements §5.2 ("lookup and sharing authorization; terms;
 * privacy; declarations"). All are `essential`: ZM-SON-012 makes refusal of an
 * essential consent a hard rejection, so the wizard cannot submit without them.
 *
 * Agent A's accepted `consentType`/`consentVersion` set must match this list.
 */

export interface ConsentDefinition {
  consentType: string;
  consentVersion: string;
  /** Refusal is a hard-rejection condition (ZM-SON-012) — cannot be skipped. */
  essential: boolean;
  labelKey: string;
  descriptionKey: string;
}

export const CONSENT_VERSION = "1.0";

export const CONSENT_CATALOGUE: ConsentDefinition[] = [
  {
    consentType: "GOVERNMENT_LOOKUP_AUTHORIZATION",
    consentVersion: CONSENT_VERSION,
    essential: true,
    labelKey: "onboarding.consents.GOVERNMENT_LOOKUP_AUTHORIZATION.label",
    descriptionKey: "onboarding.consents.GOVERNMENT_LOOKUP_AUTHORIZATION.description",
  },
  {
    consentType: "BANK_DISCLOSURE_AUTHORIZATION",
    consentVersion: CONSENT_VERSION,
    essential: true,
    labelKey: "onboarding.consents.BANK_DISCLOSURE_AUTHORIZATION.label",
    descriptionKey: "onboarding.consents.BANK_DISCLOSURE_AUTHORIZATION.description",
  },
  {
    consentType: "TERMS_OF_SERVICE",
    consentVersion: CONSENT_VERSION,
    essential: true,
    labelKey: "onboarding.consents.TERMS_OF_SERVICE.label",
    descriptionKey: "onboarding.consents.TERMS_OF_SERVICE.description",
  },
  {
    consentType: "PRIVACY_POLICY",
    consentVersion: CONSENT_VERSION,
    essential: true,
    labelKey: "onboarding.consents.PRIVACY_POLICY.label",
    descriptionKey: "onboarding.consents.PRIVACY_POLICY.description",
  },
];

export function allEssentialGranted(granted: Record<string, boolean>): boolean {
  return CONSENT_CATALOGUE.filter((c) => c.essential).every((c) => granted[c.consentType] === true);
}
