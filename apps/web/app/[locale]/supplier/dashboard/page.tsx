"use client";

import { useParams } from "next/navigation";
import { useSession } from "@/lib/session/SessionProvider";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { SkeletonText } from "@/components/ui/Skeleton";
import { ConditionalApprovalBanner } from "@/components/onboarding/ConditionalApprovalBanner";
import { SlaTracker } from "@/components/onboarding/SlaTracker";
import { StatCards } from "@/components/layout/StatCards";
import { useMyApplication } from "@/lib/onboarding/useApplication";
import { isDecided } from "@/lib/onboarding/status";
import { useTransactionList } from "@/lib/invoices/useTransactions";
import { useInbox } from "@/lib/payments/usePayments";

/**
 * Supplier dashboard: where the money is, in five numbers.
 *
 * All counts are client-side aggregates of the same reads the linked
 * screens use, so the number on the card and the rows behind the click
 * cannot disagree. The onboarding SLA tracker stays on top while an
 * application is in review (ZM-SON-009: visible at all times).
 */
const ROUND_STATES = new Set(["OPEN_FOR_OFFERS", "OFFER_PERIOD_CLOSED", "AWAITING_SELECTION"]);
const IN_FLIGHT_STATES = new Set([
  "OFFER_ACCEPTED",
  "CONDITIONS_PENDING",
  "CONTRACTED",
  "READY_FOR_DISBURSEMENT",
  "FUNDING_IN_PROGRESS",
  "FUNDING_CONFIRMATION_PENDING",
]);
const FUNDED_STATES = new Set(["FUNDED", "PARTIALLY_PAID", "OVERDUE_UNCONFIRMED", "OVERDUE"]);

export default function SupplierDashboardPage() {
  const t = useTranslations();
  const params = useParams<{ locale: string }>();
  const locale = params?.locale === "ar" ? "ar" : "en";
  const { me, loading } = useSession();
  const { data: application, loading: applicationLoading } = useMyApplication();
  const transactions = useTransactionList(1, 100);
  const inbox = useInbox(true);

  const showTracker = application && !isDecided(application.status);
  const items = transactions.data?.items ?? [];

  const inRound = items.filter((r) => r.state && ROUND_STATES.has(r.state)).length;
  const inFlight = items.filter((r) => r.state && IN_FLIGHT_STATES.has(r.state)).length;
  const funded = items.filter((r) => r.state && FUNDED_STATES.has(r.state)).length;
  const unread = inbox.data?.unreadCount ?? 0;

  const busy = loading || applicationLoading || transactions.loading;

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

      {busy ? (
        <SkeletonText lines={4} />
      ) : (
        <StatCards
          stats={[
            {
              label: t("dashboard.supplier.receivables"),
              value: transactions.data?.pagination?.total ?? items.length,
              href: `/${locale}/supplier/invoices`,
            },
            {
              label: t("dashboard.supplier.inRound"),
              value: inRound,
              href: `/${locale}/supplier/offers`,
              tone: inRound > 0 ? "attention" : "default",
            },
            {
              label: t("dashboard.supplier.inFlight"),
              value: inFlight,
              href: `/${locale}/supplier/funding`,
            },
            {
              label: t("dashboard.supplier.funded"),
              value: funded,
              href: `/${locale}/supplier/payments`,
            },
            {
              label: t("dashboard.unread"),
              value: unread,
              href: `/${locale}/supplier/notifications`,
              tone: unread > 0 ? "attention" : "default",
            },
          ]}
        />
      )}
    </div>
  );
}
