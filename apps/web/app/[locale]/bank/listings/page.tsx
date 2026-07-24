"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Table, type TableColumn } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { ErrorState } from "@/components/ui/StatePanels";
import { MoneyDisplay } from "@/components/money/MoneyDisplay";
import { useBankOffers, type OfferWithCreator } from "@/lib/marketplace/useOffers";

/**
 * The bank's rounds — where each participation stands.
 *
 * `/bank/marketplace` is what the bank COULD bid on; `/bank/offers` is where
 * offers are drafted, approved and withdrawn. This screen is the third
 * question: of the rounds this bank entered, how did each end? The offer
 * status carries the round outcome by construction — SELECTED means the
 * round was won, NOT_SELECTED lost, EXPIRED lapsed unselected, ACTIVE still
 * in play — so this is the same `GET /offers` read presented as a ledger of
 * participations, newest first, with no competitor visible anywhere
 * (INV-11: what other banks did in the same round is not this bank's data,
 * and nothing here fetches it).
 */
const OUTCOME_TONE: Record<string, "success" | "info" | "neutral" | "warning"> = {
  SELECTED: "success",
  ACTIVE: "info",
  PENDING_INTERNAL_APPROVAL: "info",
  DRAFT: "neutral",
  NOT_SELECTED: "neutral",
  EXPIRED: "neutral",
  WITHDRAWN: "neutral",
  REVISED: "neutral",
};

export default function BankRoundsPage() {
  const t = useTranslations();
  const params = useParams<{ locale: string }>();
  const locale = params?.locale === "ar" ? "ar" : "en";

  const { data, loading, error, reload } = useBankOffers();

  if (error) {
    return (
      <ErrorState title={t("portal.errorLoadingData")} onRetry={reload} retryLabel={t("common.retry")} />
    );
  }

  const columns: TableColumn<OfferWithCreator>[] = [
    {
      key: "offer",
      header: t("marketplace.offers.column.version"),
      render: (row) => (
        <Link href={`/${locale}/bank/offers/${row.id}`} className="underline underline-offset-2">
          v{row.versionNumber ?? 1}
        </Link>
      ),
    },
    {
      key: "outcome",
      header: t("bankRounds.column.outcome"),
      render: (row) => (
        <Badge tone={(row.status && OUTCOME_TONE[row.status]) || "neutral"}>
          {row.status ? t(`marketplace.offer.status.${row.status}`) : "—"}
        </Badge>
      ),
    },
    {
      key: "gross",
      header: t("bankRounds.column.gross"),
      align: "end",
      render: (row) =>
        row.grossFundingAmount ? <MoneyDisplay value={row.grossFundingAmount} locale={locale} /> : "—",
    },
    {
      key: "net",
      header: t("marketplace.offers.column.netSupplierPayout"),
      align: "end",
      render: (row) =>
        row.netSupplierPayout ? <MoneyDisplay value={row.netSupplierPayout} locale={locale} /> : "—",
    },
    {
      key: "creator",
      header: t("marketplace.offers.column.creator"),
      render: (row) => row.createdByUserName ?? "—",
    },
  ];

  return (
    <div>
      <h1 className="mb-1 text-lg font-semibold">{t("nav.listings")}</h1>
      <p className="mb-4 text-sm text-(--color-muted)">{t("bankRounds.intro")}</p>

      <Table
        columns={columns}
        rows={data?.items ?? []}
        rowKey={(row) => row.id ?? ""}
        loading={loading}
        emptyMessage={t("bankRounds.empty")}
      />
    </div>
  );
}
