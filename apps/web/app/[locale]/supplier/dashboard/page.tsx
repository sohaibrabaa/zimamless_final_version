"use client";

import { useSession } from "@/lib/session/SessionProvider";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { EmptyState } from "@/components/ui/StatePanels";
import { SkeletonText } from "@/components/ui/Skeleton";

export default function SupplierDashboardPage() {
  const t = useTranslations();
  const { me, loading } = useSession();

  return (
    <div>
      <h1 className="mb-4 text-lg font-semibold">
        {t("nav.dashboard")}
        {me && <span className="ms-2 text-sm font-normal text-(--color-muted)">— {me.user.fullName}</span>}
      </h1>
      {loading ? <SkeletonText lines={4} /> : <EmptyState title={t("portal.emptyDashboard")} />}
    </div>
  );
}
