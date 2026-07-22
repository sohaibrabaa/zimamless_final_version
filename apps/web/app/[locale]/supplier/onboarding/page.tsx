"use client";

import { useTranslations } from "@/lib/i18n/dictionary-context";
import { SkeletonText } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/StatePanels";
import { Badge } from "@/components/ui/Badge";
import { BootstrapForm } from "@/components/onboarding/BootstrapForm";
import { OnboardingWizard } from "@/components/onboarding/OnboardingWizard";
import { SlaTracker } from "@/components/onboarding/SlaTracker";
import { InformationRequestInbox } from "@/components/onboarding/InformationRequestInbox";
import { ConditionalApprovalBanner } from "@/components/onboarding/ConditionalApprovalBanner";
import { IneligibilityNotice } from "@/components/onboarding/IneligibilityNotice";
import { GovernmentFieldList } from "@/components/onboarding/GovernmentFieldList";
import { GovernmentSourcePanel } from "@/components/onboarding/GovernmentSourcePanel";
import { useMyApplication } from "@/lib/onboarding/useApplication";
import { normalizeGovernmentData } from "@/lib/onboarding/government";
import { findReasonCode, isIneligibility } from "@/lib/onboarding/reason-codes";
import { statusLabelKey, statusTone } from "@/lib/onboarding/status";

/**
 * The supplier's onboarding home. Routes on application state rather than
 * exposing separate URLs per stage, so a supplier who bookmarks "onboarding"
 * always lands on whatever is actually required of them next:
 *
 *   no application  → bootstrap form (D-04)
 *   DRAFT           → the 4-step wizard
 *   submitted/…     → SLA tracker + information-request inbox
 *   REJECTED (ZM-SON-013 code) → ineligibility notice
 *   decided         → outcome + the registry data behind it
 */
export default function SupplierOnboardingPage() {
  const t = useTranslations();
  const { data: application, loading, error, reload } = useMyApplication();

  if (loading) return <SkeletonText lines={5} />;

  if (error) {
    return (
      <ErrorState
        title={t("portal.errorLoadingData")}
        onRetry={reload}
        retryLabel={t("common.retry")}
      />
    );
  }

  if (!application) {
    return (
      <div>
        <h1 className="mb-4 text-lg font-semibold">{t("nav.onboarding")}</h1>
        <BootstrapForm onCreated={reload} />
      </div>
    );
  }

  const fields = normalizeGovernmentData(application.governmentData);
  const reason = findReasonCode(application.decisionReasonCode);

  if (application.status === "REJECTED" && isIneligibility(application.decisionReasonCode)) {
    return (
      <div className="max-w-3xl">
        <h1 className="mb-4 text-lg font-semibold">{t("nav.onboarding")}</h1>
        <IneligibilityNotice establishmentNumber={application.nationalEstablishmentNumber} />
      </div>
    );
  }

  if (application.status === "DRAFT") {
    return (
      <div className="max-w-3xl">
        <h1 className="mb-4 text-lg font-semibold">{t("nav.onboarding")}</h1>
        <OnboardingWizard application={application} onSubmitted={reload} />
      </div>
    );
  }

  return (
    <div className="max-w-3xl">
      <h1 className="mb-4 text-lg font-semibold">{t("nav.onboarding")}</h1>

      <ConditionalApprovalBanner application={application} />

      {application.status === "REJECTED" && (
        <div className="mb-4 rounded-lg border border-(--color-border) px-4 py-3">
          <div className="flex items-center gap-2">
            <Badge tone={statusTone(application.status)}>
              {t(statusLabelKey(application.status))}
            </Badge>
          </div>
          {reason && <p className="mt-2 text-sm text-(--color-fg)">{t(reason.supplierMessageKey)}</p>}
          {application.decisionNotes && (
            <p className="mt-1 text-sm text-(--color-muted)">{application.decisionNotes}</p>
          )}
        </div>
      )}

      <SlaTracker application={application} />

      <section className="mt-6">
        <h2 className="mb-2 text-sm font-semibold">
          {t("onboarding.informationRequests.title")}
        </h2>
        <InformationRequestInbox applicationId={application.id} onResponded={reload} />
      </section>

      <section className="mt-6">
        <GovernmentSourcePanel requests={application.governmentRequests} fields={fields} />
      </section>

      <section className="mt-6">
        <h2 className="mb-1 text-sm font-semibold">
          {t("onboarding.government.registryDataTitle")}
        </h2>
        <p className="mb-2 text-xs text-(--color-muted)">
          {t("onboarding.government.readOnlyNotice")}
        </p>
        <GovernmentFieldList fields={fields} />
      </section>
    </div>
  );
}
