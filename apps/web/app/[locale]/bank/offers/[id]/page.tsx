"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Badge } from "@/components/ui/Badge";
import { SkeletonText } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/StatePanels";
import { MoneyDisplay } from "@/components/money/MoneyDisplay";
import { useOffer } from "@/lib/marketplace/useOffers";
import { RECOURSE_TYPES, TRANSACTION_TYPES } from "@/lib/marketplace/offer-domain";

/**
 * A bank's own offer, in isolation — ACTIVE and (once selection runs,
 * Phase 6) NOT_SELECTED both land here. `Offer` never carries another
 * bank's data at the type level, so there is no competitor field this
 * screen could accidentally render (ZM-MKT-011).
 */
export default function BankOfferStatusPage() {
  const t = useTranslations();
  const params = useParams<{ locale: string; id: string }>();
  const locale = params?.locale === "ar" ? "ar" : "en";
  const id = params?.id;

  const { data: offer, loading, error, reload } = useOffer(id);

  if (loading) return <SkeletonText lines={6} />;
  if (error || !offer) {
    return <ErrorState title={error ?? t("marketplace.offer.notFound")} onRetry={reload} retryLabel={t("common.retry")} />;
  }

  const transactionType = TRANSACTION_TYPES.find((tt) => tt.value === offer.transactionType);
  const recourseType = RECOURSE_TYPES.find((rt) => rt.value === offer.recourseType);

  return (
    <div className="max-w-2xl">
      <Link
        href={`/${locale}/bank/offers`}
        className="text-sm text-(--color-muted) underline underline-offset-2"
      >
        {t("marketplace.offer.backToOffers")}
      </Link>

      <div className="mt-3 mb-1 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">{t("marketplace.offer.statusTitle")}</h1>
        {offer.status && (
          <Badge tone={offer.status === "ACTIVE" || offer.status === "SELECTED" ? "success" : "neutral"}>
            {t(`marketplace.offer.status.${offer.status}`)}
          </Badge>
        )}
      </div>

      {/* ZM-MKT-011: this bank learns nothing about the winner or the
          competing offers — the copy says so rather than leaving the bank
          to wonder whether something is merely not loaded. */}
      {offer.status === "NOT_SELECTED" && (
        <p className="mb-5 rounded-lg border border-(--color-border) px-4 py-3 text-sm text-(--color-muted)">
          {t("marketplace.offer.notSelectedExplain")}
        </p>
      )}
      {offer.status === "SELECTED" && offer.transactionId && (
        <p className="mb-5">
          <Link
            href={`/${locale}/bank/offers/${id}/contract`}
            className="text-sm underline underline-offset-2"
          >
            {t("marketplace.offer.viewContract")}
          </Link>
        </p>
      )}

      <dl className="grid gap-3 rounded-lg border border-(--color-border) p-4 sm:grid-cols-2">
        <div>
          <dt className="text-xs text-(--color-muted)">{t("marketplace.offer.transactionTypeLabel")}</dt>
          <dd className="mt-0.5 text-sm">{transactionType ? t(transactionType.labelKey) : offer.transactionType}</dd>
        </div>
        <div>
          <dt className="text-xs text-(--color-muted)">{t("marketplace.offer.recourseTypeLabel")}</dt>
          <dd className="mt-0.5 text-sm">{recourseType ? t(recourseType.labelKey) : offer.recourseType}</dd>
        </div>
        <div>
          <dt className="text-xs text-(--color-muted)">{t("marketplace.offers.column.version")}</dt>
          <dd className="mt-0.5 text-sm">v{offer.versionNumber ?? 1}</dd>
        </div>
        <div>
          <dt className="text-xs text-(--color-muted)">{t("marketplace.offers.column.creator")}</dt>
          <dd className="mt-0.5 text-sm">{offer.createdByUserName ?? "—"}</dd>
        </div>
      </dl>

      <dl className="mt-4 grid gap-2 rounded-lg border border-(--color-border) p-4 text-sm sm:grid-cols-2">
        <BreakdownRow label={t("marketplace.offer.grossFundingAmount")} value={offer.grossFundingAmount} locale={locale} />
        <BreakdownRow label={t("marketplace.offer.bankDiscountAmount")} value={offer.bankDiscountAmount} locale={locale} />
        <BreakdownRow label={t("marketplace.offer.bankFeesAmount")} value={offer.bankFeesAmount} locale={locale} />
        <BreakdownRow
          label={t("marketplace.offer.platformCommissionAmount")}
          value={offer.platformCommissionAmount}
          locale={locale}
        />
        <BreakdownRow label={t("marketplace.offer.listingFeeAmount")} value={offer.listingFeeAmount} locale={locale} />
        <div className="sm:col-span-2">
          <dt className="text-xs text-(--color-muted)">{t("marketplace.offer.netSupplierPayout")}</dt>
          <dd className="mt-0.5">
            {offer.netSupplierPayout && (
              <MoneyDisplay value={offer.netSupplierPayout} locale={locale} emphasis="strong" />
            )}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function BreakdownRow({ label, value, locale }: { label: string; value?: string; locale: "en" | "ar" }) {
  return (
    <div>
      <dt className="text-xs text-(--color-muted)">{label}</dt>
      <dd className="mt-0.5">{value ? <MoneyDisplay value={value} locale={locale} /> : "—"}</dd>
    </div>
  );
}
