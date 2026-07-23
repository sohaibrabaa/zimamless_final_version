"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { MoneyDisplay } from "@/components/money/MoneyDisplay";
import { ApiError } from "@/lib/api/client";
import { LISTING_FEE_AMOUNT } from "@/lib/marketplace/offer-money";
import {
  activateListingForTransaction,
  useCurrentListing,
} from "@/lib/marketplace/useListingActivation";

/**
 * ZM-FEE-007: the fee, with amount, MUST be shown before the supplier
 * confirms activation, alongside the "applies whether or not financing
 * succeeds" warning (ZM-FEE-001). Deadlines (ZM-MKT-007) are shown only
 * *after* activation, when they actually exist — the supplier does not and
 * cannot choose them (ZM-MKT-008).
 */
export function ListingActivationPanel({
  transactionId,
  locale,
  eligible,
  onActivated,
}: {
  transactionId: string;
  locale: "en" | "ar";
  eligible: boolean;
  onActivated?: () => void;
}) {
  const t = useTranslations();
  const { data: listing, loading, reload } = useCurrentListing(transactionId);
  const [modalOpen, setModalOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirmActivation() {
    setBusy(true);
    setError(null);
    try {
      await activateListingForTransaction(transactionId);
      setModalOpen(false);
      reload();
      onActivated?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message || t("common.unknownError") : t("common.unknownError"));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return null;

  if (listing) {
    return (
      <section className="mt-4 rounded-lg border border-(--color-border) p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">{t("marketplace.listing.sectionTitle")}</h2>
          <Badge tone="info">{t(`marketplace.listing.status.${listing.status}`)}</Badge>
        </div>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-xs text-(--color-muted)">{t("marketplace.listing.offerDeadline")}</dt>
            <dd className="zm-ltr-embed mt-0.5 text-sm">
              {listing.offerSubmissionDeadline
                ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
                    new Date(listing.offerSubmissionDeadline)
                  )
                : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-(--color-muted)">{t("marketplace.listing.selectionDeadline")}</dt>
            <dd className="zm-ltr-embed mt-0.5 text-sm">
              {listing.supplierSelectionDeadline
                ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
                    new Date(listing.supplierSelectionDeadline)
                  )
                : "—"}
            </dd>
          </div>
          {typeof listing.offerCount === "number" && (
            <div>
              <dt className="text-xs text-(--color-muted)">{t("marketplace.listing.offerCount")}</dt>
              <dd className="mt-0.5 text-sm">{listing.offerCount}</dd>
            </div>
          )}
        </dl>
        <Link
          href={`/${locale}/supplier/invoices/${transactionId}/offers`}
          className="mt-3 inline-block text-sm underline underline-offset-2"
        >
          {t("marketplace.listing.compareOffers")}
        </Link>
      </section>
    );
  }

  if (!eligible) return null;

  return (
    <section className="mt-4 rounded-lg border border-(--color-border) p-4">
      <h2 className="text-sm font-semibold">{t("marketplace.listing.sectionTitle")}</h2>
      <p className="mt-2 text-sm text-(--color-muted)">{t("marketplace.listing.intro")}</p>
      <Button type="button" className="mt-3" onClick={() => setModalOpen(true)}>
        {t("marketplace.listing.activate")}
      </Button>

      <Modal
        open={modalOpen}
        onClose={() => (busy ? undefined : setModalOpen(false))}
        title={t("marketplace.listing.confirmTitle")}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setModalOpen(false)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button type="button" onClick={confirmActivation} disabled={busy}>
              {busy ? t("common.loading") : t("marketplace.listing.confirmActivate")}
            </Button>
          </>
        }
      >
        <p className="text-sm">{t("marketplace.listing.feeLabel")}</p>
        <p className="mt-1">
          <MoneyDisplay value={LISTING_FEE_AMOUNT} locale={locale} emphasis="strong" />
        </p>
        {/* ZM-FEE-001/007: incurred at activation regardless of outcome — said plainly, not buried in fine print. */}
        <p className="mt-3 rounded-md border border-(--color-border) px-3 py-2 text-xs text-(--color-muted)">
          {t("marketplace.listing.feeWarning")}
        </p>
        {error && <p className="mt-3 text-xs text-(--color-danger)">{error}</p>}
      </Modal>
    </section>
  );
}
