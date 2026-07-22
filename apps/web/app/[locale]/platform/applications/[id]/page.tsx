"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useI18n, useTranslations } from "@/lib/i18n/dictionary-context";
import { Badge } from "@/components/ui/Badge";
import { SkeletonText } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/StatePanels";
import { SlaTracker } from "@/components/onboarding/SlaTracker";
import { GovernmentFieldList } from "@/components/onboarding/GovernmentFieldList";
import { GovernmentSourcePanel } from "@/components/onboarding/GovernmentSourcePanel";
import { InformationRequestInbox } from "@/components/onboarding/InformationRequestInbox";
import { DecisionForm } from "@/components/onboarding/DecisionForm";
import { useApplication } from "@/lib/onboarding/useApplication";
import { isSoleProprietorship, normalizeGovernmentData } from "@/lib/onboarding/government";
import { findReasonCode } from "@/lib/onboarding/reason-codes";
import { formatDateTime } from "@/lib/onboarding/sla";
import { statusLabelKey, statusTone } from "@/lib/onboarding/status";

/**
 * Reviewer application detail: government data panel + SLA state + decision.
 *
 * The government panel here is the same read-only component the supplier sees
 * — ZM-SON-003 forbids editing government-sourced values for *any* user,
 * administrators included, so there is deliberately no reviewer-only editable
 * variant.
 */
export default function PlatformApplicationDetailPage() {
  const t = useTranslations();
  const { locale } = useI18n();
  const { id, locale: localeParam } = useParams<{ id: string; locale: string }>();
  const { data: application, loading, error, reload } = useApplication(id);

  if (loading) return <SkeletonText lines={6} />;
  if (error || !application) {
    return (
      <ErrorState
        title={t("portal.errorLoadingData")}
        onRetry={reload}
        retryLabel={t("common.retry")}
      />
    );
  }

  const fields = normalizeGovernmentData(application.governmentData);
  const reason = findReasonCode(application.decisionReasonCode);
  const soleProprietorship = isSoleProprietorship(fields);

  return (
    <div className="max-w-4xl">
      <Link
        href={`/${localeParam}/platform/applications`}
        className="text-sm text-(--color-primary) underline-offset-2 hover:underline"
      >
        ← {t("onboarding.queue.title")}
      </Link>

      <div className="mt-2 mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">
          {application.organizationName ?? application.organizationId}
        </h1>
        <Badge tone={statusTone(application.status)}>{t(statusLabelKey(application.status))}</Badge>
      </div>

      <dl className="mb-4 grid gap-3 sm:grid-cols-3">
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
          <dd className="zm-ltr-embed text-sm">{application.professionLicenceNumber ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-xs text-(--color-muted)">
            {t("onboarding.queue.column.submitted")}
          </dt>
          <dd className="text-sm">{formatDateTime(application.submittedAt, locale) ?? "—"}</dd>
        </div>
      </dl>

      {soleProprietorship && (
        // ZM-SON-013 surfaced to the reviewer as an eligibility fact with the
        // matching reason code — not as a red flag against the applicant.
        <p className="mb-4 rounded-md bg-(--color-neutral-bg) px-3 py-2 text-sm text-(--color-neutral-fg)">
          {t("onboarding.decision.soleProprietorshipNotice")}
        </p>
      )}

      {application.decidedAt && (
        <div className="mb-4 rounded-lg border border-(--color-border) px-4 py-3">
          <p className="text-sm font-medium">{t("onboarding.decision.decidedTitle")}</p>
          <p className="mt-1 text-sm text-(--color-muted)">
            {formatDateTime(application.decidedAt, locale)}
            {reason && <> · {t(reason.labelKey)}</>}
          </p>
          {application.decisionNotes && (
            <p className="mt-1 text-sm text-(--color-muted)">{application.decisionNotes}</p>
          )}
        </div>
      )}

      <SlaTracker application={application} />

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

      <section className="mt-6">
        <h2 className="mb-2 text-sm font-semibold">
          {t("onboarding.informationRequests.title")}
        </h2>
        <InformationRequestInbox applicationId={application.id} onResponded={reload} readOnly />
      </section>

      <section className="mt-6">
        <DecisionForm
          applicationId={application.id ?? ""}
          currentStatus={application.status}
          onDecided={reload}
        />
      </section>
    </div>
  );
}
