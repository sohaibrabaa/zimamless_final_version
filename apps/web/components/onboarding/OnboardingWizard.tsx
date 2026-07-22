"use client";

import { useState } from "react";
import { apiClient, ApiError } from "@/lib/api/client";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { WizardStepper, type WizardStep } from "./WizardStepper";
import { GovernmentFieldList } from "./GovernmentFieldList";
import { GovernmentSourcePanel } from "./GovernmentSourcePanel";
import { normalizeGovernmentData } from "@/lib/onboarding/government";
import { CONSENT_CATALOGUE, allEssentialGranted } from "@/lib/onboarding/consents";
import { formatIbanForDisplay, ibanErrorKey, normalizeIban, validateIban } from "@/lib/onboarding/iban";
import type { ApplicationView } from "@/lib/onboarding/useApplication";

/**
 * The supplier onboarding wizard: establishment number → licence → consents →
 * bank account (brief §4 Phase 2, phase file B tasks).
 *
 * Steps 1 and 2 are *review* steps, not entry steps. The establishment and
 * licence numbers were captured at bootstrap; everything the registries
 * returned is shown read-only with provenance (ZM-SON-003/005). The only data
 * the supplier enters here is consents and the disbursement account —
 * ZM-SON-001's "minimum data that cannot be obtained from a government source".
 */

const STEPS: WizardStep[] = [
  { key: "identity", labelKey: "onboarding.wizard.step.identity" },
  { key: "licence", labelKey: "onboarding.wizard.step.licence" },
  { key: "consents", labelKey: "onboarding.wizard.step.consents" },
  { key: "bankAccount", labelKey: "onboarding.wizard.step.bankAccount" },
];

export function OnboardingWizard({
  application,
  onSubmitted,
}: {
  application: ApplicationView;
  onSubmitted: () => void;
}) {
  const t = useTranslations();
  const { show } = useToast();
  const [stepIndex, setStepIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [granted, setGranted] = useState<Record<string, boolean>>({});
  const [iban, setIban] = useState("");
  const [bankName, setBankName] = useState("");
  const [accountHolderName, setAccountHolderName] = useState("");
  const [ibanTouched, setIbanTouched] = useState(false);

  const applicationId = application.id ?? "";
  const fields = normalizeGovernmentData(application.governmentData);
  const ccdFields = fields.filter((f) => f.source === "CCD" || f.source === "ISTD" || f.source === null);
  const gamFields = fields.filter((f) => f.source === "GAM");

  const ibanProblem = iban.trim() === "" ? null : validateIban(iban);
  const ibanError = ibanTouched && ibanProblem ? t(ibanErrorKey(ibanProblem)) : undefined;
  const bankStepComplete =
    iban.trim() !== "" && !ibanProblem && bankName.trim() !== "" && accountHolderName.trim() !== "";

  async function saveConsents() {
    const { error: apiError } = await apiClient.POST(
      "/onboarding/applications/{id}/consents",
      {
        params: { path: { id: applicationId } },
        body: {
          consents: CONSENT_CATALOGUE.map((c) => ({
            consentType: c.consentType,
            consentVersion: c.consentVersion,
            granted: granted[c.consentType] === true,
          })),
        },
      }
    );
    if (apiError) throw apiError;
  }

  async function saveBankAccount() {
    const { error: apiError } = await apiClient.POST(
      "/onboarding/applications/{id}/bank-account",
      {
        params: { path: { id: applicationId } },
        body: {
          iban: normalizeIban(iban),
          bankName: bankName.trim(),
          accountHolderName: accountHolderName.trim(),
        },
      }
    );
    if (apiError) throw apiError;
  }

  async function handleNext() {
    setError(null);
    setBusy(true);
    try {
      if (stepIndex === 2) await saveConsents();
      if (stepIndex === 3) {
        await saveBankAccount();
        const { error: submitError } = await apiClient.POST(
          "/onboarding/applications/{id}/submit",
          { params: { path: { id: applicationId } } }
        );
        if (submitError) throw submitError;
        show({ title: t("onboarding.wizard.submitted"), tone: "success" });
        onSubmitted();
        return;
      }
      setStepIndex((i) => i + 1);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "UNKNOWN_ERROR";
      setError(
        code === "CONSENTS_REQUIRED"
          ? t("onboarding.consents.allRequired")
          : t("common.unknownError")
      );
    } finally {
      setBusy(false);
    }
  }

  const canAdvance =
    stepIndex === 2 ? allEssentialGranted(granted) : stepIndex === 3 ? bankStepComplete : true;

  return (
    <div>
      <WizardStepper steps={STEPS} currentIndex={stepIndex} />

      <div className="mt-6">
        {stepIndex === 0 && (
          <section aria-labelledby="wizard-step-heading">
            <h2 id="wizard-step-heading" className="text-base font-semibold">
              {t("onboarding.wizard.step.identity")}
            </h2>
            <p className="mt-1 text-sm text-(--color-muted)">
              {t("onboarding.wizard.identityIntro")}
            </p>
            <dl className="mt-4 grid gap-2 sm:grid-cols-2">
              <div>
                <dt className="text-xs text-(--color-muted)">
                  {t("onboarding.field.nationalEstablishmentNumber")}
                </dt>
                <dd className="zm-ltr-embed text-sm">
                  {application.nationalEstablishmentNumber ?? "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-(--color-muted)">
                  {t("onboarding.field.professionLicenceNumber")}
                </dt>
                <dd className="zm-ltr-embed text-sm">
                  {application.professionLicenceNumber ?? "—"}
                </dd>
              </div>
            </dl>
            <div className="mt-4">
              <GovernmentSourcePanel
                requests={application.governmentRequests}
                fields={fields}
              />
            </div>
            <h3 className="mt-6 mb-2 text-sm font-semibold">
              {t("onboarding.government.registryDataTitle")}
            </h3>
            <p className="mb-2 text-xs text-(--color-muted)">
              {t("onboarding.government.readOnlyNotice")}
            </p>
            <GovernmentFieldList fields={ccdFields} />
          </section>
        )}

        {stepIndex === 1 && (
          <section aria-labelledby="wizard-step-heading">
            <h2 id="wizard-step-heading" className="text-base font-semibold">
              {t("onboarding.wizard.step.licence")}
            </h2>
            <p className="mt-1 mb-3 text-sm text-(--color-muted)">
              {t("onboarding.wizard.licenceIntro")}
            </p>
            <GovernmentFieldList fields={gamFields} />
          </section>
        )}

        {stepIndex === 2 && (
          <section aria-labelledby="wizard-step-heading">
            <h2 id="wizard-step-heading" className="text-base font-semibold">
              {t("onboarding.wizard.step.consents")}
            </h2>
            <p className="mt-1 text-sm text-(--color-muted)">
              {t("onboarding.consents.intro")}
            </p>
            <ul className="mt-4 flex flex-col gap-3">
              {CONSENT_CATALOGUE.map((consent) => (
                <li
                  key={consent.consentType}
                  className="rounded-lg border border-(--color-border) px-4 py-3"
                >
                  <label className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 shrink-0"
                      checked={granted[consent.consentType] === true}
                      onChange={(e) =>
                        setGranted((prev) => ({
                          ...prev,
                          [consent.consentType]: e.target.checked,
                        }))
                      }
                    />
                    <span>
                      <span className="block text-sm font-medium">{t(consent.labelKey)}</span>
                      <span className="mt-0.5 block text-sm text-(--color-muted)">
                        {t(consent.descriptionKey)}
                      </span>
                      <span className="mt-1 block text-xs text-(--color-muted)">
                        {t("onboarding.consents.version", { version: consent.consentVersion })}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            {!allEssentialGranted(granted) && (
              <p className="mt-3 text-xs text-(--color-muted)">
                {t("onboarding.consents.allRequired")}
              </p>
            )}
          </section>
        )}

        {stepIndex === 3 && (
          <section aria-labelledby="wizard-step-heading" className="max-w-md">
            <h2 id="wizard-step-heading" className="text-base font-semibold">
              {t("onboarding.wizard.step.bankAccount")}
            </h2>
            <p className="mt-1 mb-4 text-sm text-(--color-muted)">
              {t("onboarding.bankAccount.intro")}
            </p>
            <div className="flex flex-col gap-4">
              <Input
                label={t("onboarding.bankAccount.iban")}
                hint={t("onboarding.bankAccount.ibanHint")}
                value={iban}
                onChange={(e) => setIban(e.target.value)}
                onBlur={() => setIbanTouched(true)}
                error={ibanError}
                // IBANs never flip direction, in either locale (RTL checklist).
                dir="ltr"
                autoComplete="off"
                required
              />
              {iban.trim() !== "" && !ibanProblem && (
                <p className="zm-ltr-embed text-xs text-(--color-muted)">
                  {formatIbanForDisplay(iban)}
                </p>
              )}
              <Input
                label={t("onboarding.bankAccount.bankName")}
                value={bankName}
                onChange={(e) => setBankName(e.target.value)}
                required
              />
              <Input
                label={t("onboarding.bankAccount.accountHolderName")}
                hint={t("onboarding.bankAccount.accountHolderHint")}
                value={accountHolderName}
                onChange={(e) => setAccountHolderName(e.target.value)}
                required
              />
              {/*
                Ownership evidence is a document upload, and the documents
                endpoints (POST /documents/upload-url) are Phase 3. Shown as a
                disabled placeholder rather than a fake control so the gap is
                visible rather than implied-complete (phase file B tasks).
              */}
              <div className="rounded-lg border border-dashed border-(--color-border) px-4 py-3">
                <p className="text-sm font-medium">
                  {t("onboarding.bankAccount.evidenceTitle")}
                </p>
                <p className="mt-1 text-xs text-(--color-muted)">
                  {t("onboarding.bankAccount.evidencePlaceholder")}
                </p>
              </div>
            </div>
          </section>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-4 text-sm text-(--color-danger)">
          {error}
        </p>
      )}

      <div className="mt-6 flex items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          disabled={stepIndex === 0 || busy}
          onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
        >
          {t("common.back")}
        </Button>
        <Button type="button" loading={busy} disabled={!canAdvance} onClick={handleNext}>
          {stepIndex === STEPS.length - 1 ? t("onboarding.wizard.submit") : t("common.next")}
        </Button>
      </div>
      {stepIndex === STEPS.length - 1 && (
        <p className="mt-2 text-xs text-(--color-muted)">{t("onboarding.wizard.submitNotice")}</p>
      )}
    </div>
  );
}
