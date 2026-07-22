"use client";

import { useSession } from "@/lib/session/SessionProvider";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { EmptyState } from "@/components/ui/StatePanels";
import { SkeletonText } from "@/components/ui/Skeleton";
import { ConditionalApprovalBanner } from "@/components/onboarding/ConditionalApprovalBanner";
import { SlaTracker } from "@/components/onboarding/SlaTracker";
import { useMyApplication } from "@/lib/onboarding/useApplication";
import { isDecided } from "@/lib/onboarding/status";

export default function SupplierDashboardPage() {
  const t = useTranslations();
  const { me, loading } = useSession();
  const { data: application, loading: applicationLoading } = useMyApplication();

  // ZM-SON-009: the supplier sees remaining SLA time and current state at all
  // times — including from the dashboard, not only from the onboarding screen.
  const showTracker = application && !isDecided(application.status);

  return (
    <div>
      <h1 className="mb-4 text-lg font-semibold">
        {t("nav.dashboard")}
        {me && <span className="ms-2 text-sm font-normal text-(--color-muted)">— {me.user.fullName}</span>}
      </h1>

      {application && <ConditionalApprovalBanner application={application} />}

      {showTracker && (
        <div className="mb-4 max-w-2xl">
          <SlaTracker application={application} />
        </div>
      )}

      {loading || applicationLoading ? (
        <SkeletonText lines={4} />
      ) : (
        <EmptyState title={t("portal.emptyDashboard")} />
      )}
    </div>
  );
}
