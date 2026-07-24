"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { FinancingGate } from "@/components/onboarding/FinancingGate";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Table, type TableColumn } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ErrorState } from "@/components/ui/StatePanels";
import { MoneyDisplay } from "@/components/money/MoneyDisplay";
import { useTransactionList, type TransactionSummary } from "@/lib/invoices/useTransactions";
import {
  transactionStateLabelKey,
  transactionStateTone,
} from "@/lib/invoices/transaction-status";

/**
 * The supplier's offers hub — every round that has offers to look at.
 *
 * The comparison itself (net-payout-anchored, unranked, ZM-OFR-002/ZM-SEL-006)
 * lives on `/supplier/invoices/{id}/offers`; this screen exists to answer
 * "which of my receivables are in a round right now?" without walking the
 * whole invoice list. It is the invoice list's read, filtered client-side to
 * the round states — one fetch, no new endpoint.
 *
 * Gated by ZM-SON-011 like every financing action.
 */
export default function Page() {
  return (
    <FinancingGate>
      <OffersHub />
    </FinancingGate>
  );
}

/** The states in which a round exists and the comparison screen has content. */
const ROUND_STATES = new Set(["OPEN_FOR_OFFERS", "OFFER_PERIOD_CLOSED", "AWAITING_SELECTION"]);

function OffersHub() {
  const t = useTranslations();
  const params = useParams<{ locale: string }>();
  const locale = params?.locale === "ar" ? "ar" : "en";

  // One page of 100 covers any realistic number of *simultaneously open*
  // rounds; a supplier with more has a portfolio, not a screen problem.
  const { data, loading, error, reload } = useTransactionList(1, 100);

  if (error) {
    return (
      <ErrorState title={t("portal.errorLoadingData")} onRetry={reload} retryLabel={t("common.retry")} />
    );
  }

  const rounds = (data?.items ?? []).filter((row) => row.state && ROUND_STATES.has(row.state));

  const columns: TableColumn<TransactionSummary>[] = [
    {
      key: "reference",
      header: t("invoices.list.column.reference"),
      render: (row) => (
        <Link
          href={`/${locale}/supplier/invoices/${row.id}`}
          className="zm-ltr-embed underline underline-offset-2"
        >
          {row.referenceNumber ?? row.id}
        </Link>
      ),
    },
    {
      key: "buyer",
      header: t("invoices.list.column.buyer"),
      render: (row) => row.buyerName ?? "—",
    },
    {
      key: "faceValue",
      header: t("invoices.list.column.faceValue"),
      align: "end",
      render: (row) => (row.faceValue ? <MoneyDisplay value={row.faceValue} locale={locale} /> : "—"),
    },
    {
      key: "state",
      header: t("invoices.list.column.state"),
      render: (row) => (
        <Badge tone={transactionStateTone(row.state)}>{t(transactionStateLabelKey(row.state))}</Badge>
      ),
    },
    {
      key: "action",
      header: "",
      align: "end",
      render: (row) => (
        <Link href={`/${locale}/supplier/invoices/${row.id}/offers`}>
          <Button type="button" size="sm">
            {t("offersHub.compare")}
          </Button>
        </Link>
      ),
    },
  ];

  return (
    <div>
      <h1 className="mb-1 text-lg font-semibold">{t("nav.offers")}</h1>
      <p className="mb-4 text-sm text-(--color-muted)">{t("offersHub.intro")}</p>

      <Table
        columns={columns}
        rows={rounds}
        rowKey={(row) => row.id ?? ""}
        loading={loading}
        emptyMessage={t("offersHub.empty")}
      />
    </div>
  );
}
