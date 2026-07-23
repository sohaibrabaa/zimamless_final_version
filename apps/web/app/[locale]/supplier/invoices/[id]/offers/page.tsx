"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { SkeletonText } from "@/components/ui/Skeleton";
import { ErrorState, EmptyState } from "@/components/ui/StatePanels";
import { MoneyDisplay } from "@/components/money/MoneyDisplay";
import { ApiError } from "@/lib/api/client";
import { useCurrentListing } from "@/lib/marketplace/useListingActivation";
import { useListingOffers, type Offer } from "@/lib/marketplace/useOffers";
import { RECOURSE_TYPES, TRANSACTION_TYPES } from "@/lib/marketplace/offer-domain";
import { rejectAllOffers, useOfferAcceptance, type AcceptedOfferSnapshotFull } from "@/lib/contracts/useAcceptance";

/**
 * The supplier's offer comparison screen — per the phase file, "the most
 * important screen in the product" — plus Phase 6's acceptance and
 * reject-all flows, which live here rather than on a separate route: they
 * are actions taken *from* the comparison the supplier is already looking
 * at, not a destination of their own.
 *
 * Three comparison rules the requirement calls out explicitly:
 *
 * - **Net payout is the visual anchor** (ZM-OFR-002): rendered largest, once
 *   per offer, ahead of the deduction breakdown rather than buried at the
 *   bottom of it.
 * - **No default sort by amount, no "best"/"recommended" marking anywhere**:
 *   offers render in the order the API returns them (submission order) and
 *   nothing here computes a ranking, a highlight, or a badge that implies
 *   one offer is better than another — the accept button on the *lowest*
 *   offer works identically to the one on the highest (ZM-SEL-006).
 * - **Every offer's transaction type and recourse type are prominent, with
 *   their plain-language explanation** (ZM-OFR-011).
 *
 * The acceptance modal spells out atomic-and-irreversible and shows the
 * full breakdown one last time (phase file, B tasks) — `ZM-OFR-003`'s
 * client-preview-only rule means this modal's numbers are exactly what is
 * already on the card, not recomputed; the actual figure that counts is
 * whatever `POST /offers/{id}/accept` returns.
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

  const [pendingAccept, setPendingAccept] = useState<Offer | null>(null);
  const [pendingReject, setPendingReject] = useState(false);
  const [snapshot, setSnapshot] = useState<AcceptedOfferSnapshotFull | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const { accept, resetAttempt } = useOfferAcceptance();

  function closeAcceptModal() {
    if (busy) return;
    setPendingAccept(null);
    resetAttempt();
  }

  async function confirmAccept() {
    if (!pendingAccept?.id) return;
    setBusy(true);
    setActionError(null);
    try {
      const result = await accept(pendingAccept.id);
      setSnapshot(result);
      setPendingAccept(null);
      resetAttempt();
      reloadListing();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message || t("common.unknownError") : t("common.unknownError"));
    } finally {
      setBusy(false);
    }
  }

  async function confirmRejectAll() {
    if (!listing?.id) return;
    setBusy(true);
    setActionError(null);
    try {
      await rejectAllOffers(listing.id);
      setPendingReject(false);
      reloadListing();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t("common.unknownError"));
    } finally {
      setBusy(false);
    }
  }

  if (listingLoading) return <SkeletonText lines={6} />;
  if (listingError) {
    return <ErrorState title={listingError} onRetry={reloadListing} retryLabel={t("common.retry")} />;
  }
  if (!listing) {
    return <EmptyState title={t("marketplace.comparison.noListing")} />;
  }

  if (snapshot || listing.status === "OFFER_SELECTED") {
    return (
      <div className="max-w-2xl">
        <h1 className="mb-1 text-lg font-semibold">{t("marketplace.acceptance.successTitle")}</h1>
        <p className="mb-5 text-sm text-(--color-muted)">{t("marketplace.acceptance.successIntro")}</p>
        {snapshot && (
          <div className="rounded-lg border border-(--color-border) p-4">
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <BreakdownRow label={t("marketplace.offer.netSupplierPayout")} value={snapshot.netSupplierPayout} locale={locale} />
              <BreakdownRow label={t("marketplace.offer.grossFundingAmount")} value={snapshot.grossFundingAmount} locale={locale} />
              <BreakdownRow label={t("marketplace.offer.platformCommissionAmount")} value={snapshot.platformCommissionAmount} locale={locale} />
              <BreakdownRow label={t("marketplace.offer.listingFeeAmount")} value={snapshot.listingFeeAmount} locale={locale} />
            </dl>
            <p className="zm-ltr-embed mt-3 text-xs text-(--color-muted)">{snapshot.snapshotHash}</p>
          </div>
        )}
        <div className="mt-5 flex flex-wrap gap-3">
          <Link href={`/${locale}/supplier/invoices/${transactionId}/conditions`}>
            <Button type="button" variant="secondary">{t("marketplace.acceptance.viewConditions")}</Button>
          </Link>
          <Link href={`/${locale}/supplier/invoices/${transactionId}`}>
            <Button type="button" variant="ghost">{t("marketplace.comparison.backToInvoice")}</Button>
          </Link>
        </div>
      </div>
    );
  }

  if (listing.status === "CANCELLED") {
    return <EmptyState title={t("marketplace.acceptance.allRejected")} />;
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
        <>
          <div className="flex flex-col gap-4">
            {/* Submission order — never sorted by amount, never ranked. */}
            {(offers ?? []).map((offer) => (
              <OfferCard key={offer.id} offer={offer} locale={locale} onAccept={() => setPendingAccept(offer)} />
            ))}
          </div>
          <Button type="button" variant="ghost" className="mt-4" onClick={() => setPendingReject(true)}>
            {t("marketplace.acceptance.rejectAll")}
          </Button>
        </>
      )}

      <Modal
        open={!!pendingAccept}
        onClose={closeAcceptModal}
        title={t("marketplace.acceptance.confirmTitle")}
        footer={
          <>
            <Button type="button" variant="secondary" disabled={busy} onClick={closeAcceptModal}>
              {t("common.cancel")}
            </Button>
            <Button type="button" disabled={busy} onClick={confirmAccept}>
              {busy ? t("common.loading") : t("marketplace.acceptance.confirmAccept")}
            </Button>
          </>
        }
      >
        {/* ZM-SEL-002/003/004: said plainly, not softened. */}
        <p className="text-sm font-medium text-(--color-danger)">{t("marketplace.acceptance.irreversibleWarning")}</p>
        {pendingAccept && (
          <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            <BreakdownRow label={t("marketplace.offer.netSupplierPayout")} value={pendingAccept.netSupplierPayout} locale={locale} />
            <BreakdownRow label={t("marketplace.offer.grossFundingAmount")} value={pendingAccept.grossFundingAmount} locale={locale} />
            <BreakdownRow label={t("marketplace.offer.bankDiscountAmount")} value={pendingAccept.bankDiscountAmount} locale={locale} />
            <BreakdownRow label={t("marketplace.offer.bankFeesAmount")} value={pendingAccept.bankFeesAmount} locale={locale} />
            <BreakdownRow label={t("marketplace.offer.platformCommissionAmount")} value={pendingAccept.platformCommissionAmount} locale={locale} />
            <BreakdownRow label={t("marketplace.offer.listingFeeAmount")} value={pendingAccept.listingFeeAmount} locale={locale} />
          </dl>
        )}
        {actionError && <p className="mt-3 text-xs text-(--color-danger)">{actionError}</p>}
      </Modal>

      <Modal
        open={pendingReject}
        onClose={() => (busy ? undefined : setPendingReject(false))}
        title={t("marketplace.acceptance.rejectAllConfirmTitle")}
        footer={
          <>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => setPendingReject(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="button" variant="danger" disabled={busy} onClick={confirmRejectAll}>
              {busy ? t("common.loading") : t("marketplace.acceptance.rejectAllConfirm")}
            </Button>
          </>
        }
      >
        <p className="text-sm">{t("marketplace.acceptance.rejectAllExplain")}</p>
        {actionError && <p className="mt-3 text-xs text-(--color-danger)">{actionError}</p>}
      </Modal>
    </div>
  );
}

function OfferCard({
  offer,
  locale,
  onAccept,
}: {
  offer: Offer;
  locale: "en" | "ar";
  onAccept: () => void;
}) {
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

      <Button type="button" className="mt-4" onClick={onAccept}>
        {t("marketplace.acceptance.accept")}
      </Button>
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
