"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { SkeletonText } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/StatePanels";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { MoneyDisplay } from "@/components/money/MoneyDisplay";
import { RiskPanel } from "@/components/risk/RiskPanel";
import { RiskModeToggle } from "@/components/dev/RiskModeToggle";
import { useListing } from "@/lib/marketplace/useMarketplace";
import { buyerStatusLabelKey, buyerStatusTone } from "@/lib/invoices/buyer-rules";

/**
 * Bank underwriting view — `GET /marketplace/listings/{id}` (D-07, phase
 * file B tasks). This is where the Phase 4 risk display components meet
 * their first real screen: `<RiskPanel>` here is the same component that
 * will render on every future bank listing view, not a Phase-4-only demo
 * harness.
 *
 * `BankListingView` structurally excludes `minimumAcceptableAmount` and
 * `offerCount` — nothing on this page reads either, and neither field
 * exists anywhere in the type this screen consumes, so there is no value to
 * accidentally leak.
 */
export default function BankListingDetailPage() {
  const t = useTranslations();
  const params = useParams<{ locale: string; id: string }>();
  const locale = params?.locale === "ar" ? "ar" : "en";
  const id = params?.id;

  const { data: listing, loading, error, reload } = useListing(id);

  if (loading) return <SkeletonText lines={8} />;

  if (error || !listing) {
    return (
      <ErrorState
        title={error ?? t("marketplace.detail.notFound")}
        onRetry={reload}
        retryLabel={t("common.retry")}
      />
    );
  }

  return (
    <div className="max-w-3xl">
      <Link
        href={`/${locale}/bank/marketplace`}
        className="text-sm text-(--color-muted) underline underline-offset-2"
      >
        {t("marketplace.detail.backToFeed")}
      </Link>

      <div className="mt-3">
        <RiskModeToggle onChange={reload} />
      </div>

      <h1 className="mb-1 text-lg font-semibold">
        {listing.supplier?.legalName ?? t("marketplace.detail.title")}
      </h1>
      <p className="zm-ltr-embed mb-5 text-xs text-(--color-muted)">
        {listing.supplier?.nationalEstablishmentNumber}
      </p>

      <section className="rounded-lg border border-(--color-border) p-4">
        <h2 className="text-sm font-semibold">{t("marketplace.detail.supplierSection")}</h2>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          <Row label={t("marketplace.detail.legalName")}>{listing.supplier?.legalName ?? "—"}</Row>
          <Row label={t("marketplace.detail.establishmentNumber")}>
            <span className="zm-ltr-embed">{listing.supplier?.nationalEstablishmentNumber ?? "—"}</span>
          </Row>
          <Row label={t("marketplace.detail.registryStatus")}>{listing.supplier?.registryStatus ?? "—"}</Row>
        </dl>
      </section>

      <section className="mt-4 rounded-lg border border-(--color-border) p-4">
        <h2 className="text-sm font-semibold">{t("invoices.detail.buyerSection")}</h2>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-sm">{listing.buyer?.legalCompanyName ?? "—"}</span>
          {listing.buyer?.registryStatus && (
            <Badge tone={buyerStatusTone(listing.buyer.registryStatus)}>
              {t(buyerStatusLabelKey(listing.buyer.registryStatus))}
            </Badge>
          )}
        </div>
        <p className="zm-ltr-embed mt-1 text-xs text-(--color-muted)">
          {listing.buyer?.nationalEstablishmentNumber}
        </p>
      </section>

      <section className="mt-4 rounded-lg border border-(--color-border) p-4">
        <h2 className="text-sm font-semibold">{t("invoices.detail.invoiceSection")}</h2>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          <Row label={t("invoices.field.invoiceNumber")}>
            <span className="zm-ltr-embed">{listing.invoice?.invoiceNumber ?? "—"}</span>
          </Row>
          <Row label={t("invoices.field.dueDate")}>
            <span className="zm-ltr-embed">{listing.invoice?.dueDate ?? "—"}</span>
          </Row>
          <Row label={t("invoices.field.faceValue")}>
            {listing.invoice?.faceValue ? (
              <MoneyDisplay value={listing.invoice.faceValue} locale={locale} emphasis="strong" />
            ) : (
              "—"
            )}
          </Row>
        </dl>
      </section>

      {listing.documents && listing.documents.length > 0 && (
        <section className="mt-4 rounded-lg border border-(--color-border) p-4">
          <h2 className="text-sm font-semibold">{t("invoices.detail.documentsSection")}</h2>
          <ul className="mt-3 flex flex-col gap-1.5">
            {listing.documents.map((doc) => (
              <li key={doc.id} className="text-sm">
                {t(`invoices.documents.type.${doc.documentType}`)}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-4">
        <h2 className="mb-2 text-sm font-semibold">{t("risk.sectionTitle")}</h2>
        <RiskPanel assessment={listing.risk} />
      </section>

      {/* ZM-CON-018: the platform is the sole point of control against
          double-financing across banks; stated plainly so a bank does not
          read the marketplace's confidentiality as an absence of that
          control. */}
      <p className="mt-4 rounded-lg border border-(--color-border) px-4 py-3 text-xs text-(--color-muted)">
        {t("marketplace.detail.doubleFinancingNotice")}
      </p>

      <div className="mt-6">
        <Link href={`/${locale}/bank/marketplace/${listing.listingId}/offer`}>
          <Button type="button">{t("marketplace.detail.createOffer")}</Button>
        </Link>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-(--color-muted)">{label}</dt>
      <dd className="mt-0.5 text-sm">{children}</dd>
    </div>
  );
}
