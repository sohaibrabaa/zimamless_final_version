"use client";

import { useParams } from "next/navigation";
import { useSession } from "@/lib/session/SessionProvider";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { SkeletonText } from "@/components/ui/Skeleton";
import { StatCards } from "@/components/layout/StatCards";
import { useTransactionList } from "@/lib/invoices/useTransactions";
import { useCases } from "@/lib/payments/usePayments";
import { useAuditLogs } from "@/lib/admin/useAdmin";

/**
 * Platform dashboard: the operator's overview — how much is on the
 * platform, what needs a decision, and the audit trail's size as a running
 * proof that everything that happened is on the record. Counts come from
 * the same reads the linked screens use.
 */
export default function PlatformDashboardPage() {
  const t = useTranslations();
  const params = useParams<{ locale: string }>();
  const locale = params?.locale === "ar" ? "ar" : "en";
  const { me, loading } = useSession();

  const transactions = useTransactionList(1, 1);
  const cases = useCases({});
  const audit = useAuditLogs(1, 1);

  const busy = loading || transactions.loading || cases.loading;

  return (
    <div>
      <h1 className="mb-4 text-lg font-semibold">
        {t("nav.dashboard")}
        {me && <span className="ms-2 text-sm font-normal text-(--color-muted)">— {me.user.fullName}</span>}
      </h1>

      {busy ? (
        <SkeletonText lines={4} />
      ) : (
        <StatCards
          stats={[
            {
              label: t("dashboard.platform.receivables"),
              value: transactions.data?.pagination?.total ?? 0,
              href: `/${locale}/platform/transactions`,
            },
            {
              label: t("dashboard.platform.openCases"),
              value: (cases.data ?? []).length,
              href: `/${locale}/platform/cases`,
              tone: (cases.data ?? []).length > 0 ? "attention" : "default",
            },
            {
              label: t("dashboard.platform.auditEntries"),
              value: audit.data?.pagination?.total ?? 0,
              href: `/${locale}/platform/audit`,
            },
            {
              label: t("dashboard.platform.settings"),
              value: "→",
              href: `/${locale}/platform/settings`,
            },
          ]}
        />
      )}
    </div>
  );
}
