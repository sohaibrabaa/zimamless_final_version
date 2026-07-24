"use client";

import { useParams } from "next/navigation";
import { useSession } from "@/lib/session/SessionProvider";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { SkeletonText } from "@/components/ui/Skeleton";
import { StatCards } from "@/components/layout/StatCards";
import { useEligibleListings } from "@/lib/marketplace/useMarketplace";
import { useBankOffers } from "@/lib/marketplace/useOffers";
import { useCases } from "@/lib/payments/usePayments";

/**
 * Bank dashboard: the desk's morning questions, answered in numbers that
 * click through to the screens where the work happens. Counts aggregate the
 * exact reads those screens use — nothing here fetches anything a bank may
 * not see (the eligible feed is already policy-filtered server-side, the
 * offers read is own-org only, the case read is own-cases only).
 */
export default function BankDashboardPage() {
  const t = useTranslations();
  const params = useParams<{ locale: string }>();
  const locale = params?.locale === "ar" ? "ar" : "en";
  const { me, loading } = useSession();

  const feed = useEligibleListings(1, 1);
  const offers = useBankOffers();
  const recourse = useCases({ type: "RECOURSE" });

  const offerItems = offers.data?.items ?? [];
  const live = offerItems.filter((o) => o.status === "ACTIVE").length;
  const queue = offerItems.filter((o) => o.status === "PENDING_INTERNAL_APPROVAL").length;
  const won = offerItems.filter((o) => o.status === "SELECTED").length;
  const openRecourse = (recourse.data ?? []).length;

  const busy = loading || feed.loading || offers.loading;

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
              label: t("dashboard.bank.opportunities"),
              value: feed.data?.pagination?.total ?? 0,
              href: `/${locale}/bank/marketplace`,
            },
            {
              label: t("dashboard.bank.liveOffers"),
              value: live,
              href: `/${locale}/bank/offers`,
            },
            {
              label: t("dashboard.bank.approvalQueue"),
              value: queue,
              href: `/${locale}/bank/offers`,
              tone: queue > 0 ? "attention" : "default",
            },
            {
              label: t("dashboard.bank.wonRounds"),
              value: won,
              href: `/${locale}/bank/listings`,
            },
            {
              label: t("dashboard.bank.openRecourse"),
              value: openRecourse,
              href: `/${locale}/bank/recourse`,
              tone: openRecourse > 0 ? "attention" : "default",
            },
          ]}
        />
      )}
    </div>
  );
}
