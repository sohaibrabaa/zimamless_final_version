"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Table, type TableColumn } from "@/components/ui/Table";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { ErrorState } from "@/components/ui/StatePanels";
import { MoneyDisplay } from "@/components/money/MoneyDisplay";
import { useEligibleListings, type BankListingView } from "@/lib/marketplace/useMarketplace";
import { bandLabelKey, bandTone } from "@/lib/risk/risk-presentation";

/**
 * Bank marketplace feed — `GET /marketplace/eligible` (phase file B tasks,
 * Phase 5 head start per the Phase 4 kickoff). Policy-filter-driven
 * eligibility is Agent A's real Phase 5 work; this session's mock returns a
 * fixed, illustrative set rather than evaluating this bank's actual filters,
 * and is flagged as such in the completion report.
 *
 * The floor is not a column here, and never will be: `BankListingView`
 * excludes `minimumAcceptableAmount` by contract, so there is nothing to
 * accidentally render.
 */
const PAGE_SIZE = 20;

export default function BankMarketplacePage() {
  const t = useTranslations();
  const params = useParams<{ locale: string }>();
  const locale = params?.locale === "ar" ? "ar" : "en";
  const [page, setPage] = useState(1);

  const { data, loading, error, reload } = useEligibleListings(page, PAGE_SIZE);

  const columns: TableColumn<BankListingView>[] = [
    {
      key: "supplier",
      header: t("marketplace.feed.column.supplier"),
      render: (row) => (
        <Link
          href={`/${locale}/bank/marketplace/${row.listingId}`}
          className="underline underline-offset-2"
        >
          {row.supplier?.legalName ?? "—"}
        </Link>
      ),
    },
    {
      key: "buyer",
      header: t("marketplace.feed.column.buyer"),
      render: (row) => row.buyer?.legalCompanyName ?? "—",
    },
    {
      key: "faceValue",
      header: t("marketplace.feed.column.faceValue"),
      align: "end",
      render: (row) =>
        row.invoice?.faceValue ? <MoneyDisplay value={row.invoice.faceValue} locale={locale} /> : "—",
    },
    {
      key: "band",
      header: t("marketplace.feed.column.riskBand"),
      render: (row) =>
        row.risk?.band ? (
          <Badge tone={bandTone(row.risk.band)}>{t(bandLabelKey(row.risk.band))}</Badge>
        ) : (
          "—"
        ),
    },
    {
      key: "deadline",
      header: t("marketplace.feed.column.deadline"),
      render: (row) => (
        <span className="zm-ltr-embed text-xs text-(--color-muted)">
          {row.offerSubmissionDeadline
            ? new Intl.DateTimeFormat(locale === "ar" ? "ar" : "en", { dateStyle: "medium" }).format(
                new Date(row.offerSubmissionDeadline)
              )
            : "—"}
        </span>
      ),
    },
    {
      key: "action",
      header: "",
      align: "end",
      render: (row) => (
        <Link href={`/${locale}/bank/marketplace/${row.listingId}`}>
          <Button type="button" variant="secondary" size="sm">
            {t("marketplace.feed.review")}
          </Button>
        </Link>
      ),
    },
  ];

  if (error) {
    return (
      <ErrorState title={t("portal.errorLoadingData")} onRetry={reload} retryLabel={t("common.retry")} />
    );
  }

  const totalPages = data?.pagination?.totalPages ?? 1;

  return (
    <div>
      <h1 className="mb-1 text-lg font-semibold">{t("nav.marketplace")}</h1>
      <p className="mb-4 text-sm text-(--color-muted)">{t("marketplace.feed.intro")}</p>

      <Table
        columns={columns}
        rows={data?.items ?? []}
        rowKey={(row) => row.listingId ?? ""}
        loading={loading}
        emptyMessage={t("marketplace.feed.empty")}
      />

      {totalPages > 1 && (
        <div className="mt-4 flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            {t("common.back")}
          </Button>
          <span className="text-sm text-(--color-muted)">
            {t("common.pageOf", { page: String(page), total: String(totalPages) })}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            {t("common.next")}
          </Button>
        </div>
      )}
    </div>
  );
}
