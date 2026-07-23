"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Badge } from "@/components/ui/Badge";
import { SkeletonText } from "@/components/ui/Skeleton";
import { ErrorState, EmptyState } from "@/components/ui/StatePanels";
import { MoneyDisplay } from "@/components/money/MoneyDisplay";
import { useCurrentListing } from "@/lib/marketplace/useListingActivation";
import { useListingOffers, type Offer } from "@/lib/marketplace/useOffers";
import { RECOURSE_TYPES, TRANSACTION_TYPES } from "@/lib/marketplace/offer-domain";

/**
 * The supplier's offer comparison screen — per the phase file, "the most
 * important screen in the product". Three rules the requirement calls out
 * explicitly, each with a concrete consequence here rather than left to a
 * component author's judgement later:
 *
 * - **Net payout is the visual anchor** (ZM-OFR-002): rendered largest, once
 *   per offer, ahead of the deduction breakdown rather than buried at the
 *   bottom of it.
 * - **No default sort by amount, no "best"/"recommended" marking anywhere**
 *   (explicit in the phase file's B tasks): offers render in the order the
 *   API returns them (submission order) and nothing here computes a
 *   ranking, a highlight, or a badge that implies one offer is better than
 *   another.
 * - **Every offer's transaction type and recourse type are prominent, with
 *   their plain-language explanation**, since a supplier may legitimately
 *   be comparing genuinely different transaction types at once (ZM-OFR-011).
 */
export default function OfferComparisonPage() {
  const t = useTranslations();
  const params = useParams<{ locale: string; id: string }>();
  const locale = params?.locale === "ar" ? "ar" : "en";
  const transactionId = params?.id;

  const { data: listing, loading: listingLoading, error: listingError, reload: reloadListing } =
    useCurrentListing(transactionId);
  const { data: offers, loading: offersLoading, error: offersError, reload: reloadOffers } = useListingOffers(
    listing?.id
  );

  if (listingLoading) return <SkeletonText lines={6} />;
  if (listingError) {
    return <ErrorState title={listingError} onRetry={reloadListing} retryLabel={t("common.retry")} />;
  }
  if (!listing) {
    return <EmptyState title={t("marketplace.comparison.noListing")} />;
  }

  return (
    <div className="max-w-3xl">
      <Link
        href={`/${locale}/supplier/invoices/${transactionId}`}
        className="text-sm text-(--color-muted) underline underline-offset-2"
      >
        {t("marketplace.comparison.backToInvoice")}
      </Link>

      <div className="mt-3 mb-1 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">{t("marketplace.comparison.title")}</h1>
        {listing.supplierSelectionDeadline && <SelectionCountdown deadline={listing.supplierSelectionDeadline} />}
      </div>
      <p className="mb-5 text-sm text-(--color-muted)">{t("marketplace.comparison.intro")}</p>

      {offersError && (
        <ErrorState title={offersError} onRetry={reloadOffers} retryLabel={t("common.retry")} />
      )}
      {!offersError && offersLoading && <SkeletonText lines={8} />}
      {!offersError && !offersLoading && (offers ?? []).length === 0 && (
        <EmptyState title={t("marketplace.comparison.empty")} />
      )}
      {!offersError && !offersLoading && (offers ?? []).length > 0 && (
        <div className="flex flex-col gap-4">
          {/* Submission order — never sorted by amount, never ranked. */}
          {(offers ?? []).map((offer) => (
            <OfferCard key={offer.id} offer={offer} locale={locale} />
          ))}
        </div>
      )}
    </div>
  );
}

function OfferCard({ offer, locale }: { offer: Offer; locale: "en" | "ar" }) {
  const t = useTranslations();
  const transactionType = TRANSACTION_TYPES.find((tt) => tt.value === offer.transactionType);
  const recourseType = RECOURSE_TYPES.find((rt) => rt.value === offer.recourseType);

  return (
    <div className="rounded-lg border border-(--color-border) p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">{offer.bankName ?? "—"}</span>
        <div className="flex gap-2">
          <Badge tone="info">{transactionType ? t(transactionType.labelKey) : offer.transactionType}</Badge>
          <Badge tone="info">{recourseType ? t(recourseType.labelKey) : offer.recourseType}</Badge>
        </div>
      </div>
      {(transactionType || recourseType) && (
        <p className="mt-2 text-xs text-(--color-muted)">
          {transactionType && t(transactionType.explainKey)} {recourseType && t(recourseType.explainKey)}
        </p>
      )}

      {/* The net figure — visual anchor, largest text on the card. */}
      <div className="mt-4">
        <p className="text-xs text-(--color-muted)">{t("marketplace.offer.netSupplierPayout")}</p>
        {offer.netSupplierPayout && (
          <MoneyDisplay
            value={offer.netSupplierPayout}
            locale={locale}
            emphasis="strong"
            className="text-2xl"
          />
        )}
      </div>

      <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
        <BreakdownRow label={t("marketplace.offer.grossFundingAmount")} value={offer.grossFundingAmount} locale={locale} />
        <BreakdownRow label={t("marketplace.offer.bankDiscountAmount")} value={offer.bankDiscountAmount} locale={locale} />
        <BreakdownRow label={t("marketplace.offer.bankFeesAmount")} value={offer.bankFeesAmount} locale={locale} />
        <BreakdownRow
          label={t("marketplace.offer.platformCommissionAmount")}
          value={offer.platformCommissionAmount}
          locale={locale}
        />
        <BreakdownRow label={t("marketplace.offer.listingFeeAmount")} value={offer.listingFeeAmount} locale={locale} />
        <BreakdownRow
          label={t("marketplace.offer.otherDeductionsAmount")}
          value={offer.otherDeductionsAmount}
          locale={locale}
        />
      </dl>

      <dl className="mt-4 grid gap-2 text-xs text-(--color-muted) sm:grid-cols-2">
        <div>
          <dt>{t("marketplace.offer.expectedPayoutDate")}</dt>
          <dd className="zm-ltr-embed mt-0.5">{offer.expectedPayoutDate ?? "—"}</dd>
        </div>
        <div>
          <dt>{t("marketplace.offer.validUntil")}</dt>
          <dd className="zm-ltr-embed mt-0.5">
            {offer.validUntil
              ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
                  new Date(offer.validUntil)
                )
              : "—"}
          </dd>
        </div>
      </dl>

      {offer.conditions && offer.conditions.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-medium text-(--color-muted)">{t("marketplace.offer.conditionsTitle")}</p>
          <ul className="mt-2 flex flex-col gap-1.5">
            {offer.conditions.map((c) => (
              <li key={c.id} className="flex items-start justify-between gap-2 text-sm">
                <span>
                  {c.title || t(`marketplace.offer.conditionType.${c.conditionType}`)}
                  {c.description && <span className="text-(--color-muted)"> — {c.description}</span>}
                </span>
                {c.isMandatory && <Badge tone="warning">{t("marketplace.offer.conditionMandatory")}</Badge>}
              </li>
            ))}
          </ul>
        </div>
      )}
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

/** Live countdown to the supplier-selection deadline (AS-02's reminder window, shown as remaining time rather than reminder events themselves). */
function SelectionCountdown({ deadline }: { deadline: string }) {
  const t = useTranslations();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, []);

  const remainingMs = new Date(deadline).getTime() - now;
  if (remainingMs <= 0) {
    return <Badge tone="neutral">{t("marketplace.comparison.deadlinePassed")}</Badge>;
  }
  const hours = Math.floor(remainingMs / 3_600_000);
  const minutes = Math.floor((remainingMs % 3_600_000) / 60_000);
  return (
    <Badge tone="info">
      <span className="zm-ltr-embed">
        {t("marketplace.comparison.timeRemaining", { hours: String(hours), minutes: String(minutes) })}
      </span>
    </Badge>
  );
}
