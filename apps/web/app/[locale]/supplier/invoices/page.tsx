"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { FinancingGate } from "@/components/onboarding/FinancingGate";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Table, type TableColumn } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { ErrorState } from "@/components/ui/StatePanels";
import { MoneyDisplay } from "@/components/money/MoneyDisplay";
import { useTransactionList, type TransactionSummary } from "@/lib/invoices/useTransactions";
import {
  transactionStateLabelKey,
  transactionStateTone,
  type TransactionState,
} from "@/lib/invoices/transaction-status";

/**
 * Supplier transaction list.
 *
 * Sits behind the ZM-SON-011 financing gate, which was wired in Phase 2
 * against a placeholder screen — this is the screen it was waiting for. A
 * conditionally-approved supplier still reaches this route and is told why it
 * is unavailable rather than being bounced.
 */
export default function Page() {
  return (
    <FinancingGate>
      <InvoiceList />
    </FinancingGate>
  );
}

const PAGE_SIZE = 20;

function InvoiceList() {
  const t = useTranslations();
  const params = useParams<{ locale: string }>();
  const locale = params?.locale === "ar" ? "ar" : "en";
  const [page, setPage] = useState(1);
  const [state, setState] = useState<TransactionState | "">("");

  const { data, loading, error, reload } = useTransactionList(
    page,
    PAGE_SIZE,
    state === "" ? undefined : state
  );

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
      key: "invoiceNumber",
      header: t("invoices.list.column.invoiceNumber"),
      render: (row) => <span className="zm-ltr-embed">{row.invoiceNumber ?? "—"}</span>,
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
      key: "dueDate",
      header: t("invoices.list.column.dueDate"),
      render: (row) => <span className="zm-ltr-embed">{row.dueDate ?? "—"}</span>,
    },
    {
      key: "state",
      header: t("invoices.list.column.state"),
      render: (row) => (
        <Badge tone={transactionStateTone(row.state)}>{t(transactionStateLabelKey(row.state))}</Badge>
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
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">{t("nav.invoices")}</h1>
        <Link
          href={`/${locale}/supplier/invoices/new`}
          className="inline-flex items-center justify-center rounded-md bg-(--color-primary) px-4 py-2 text-sm font-medium text-(--color-primary-fg) hover:bg-(--color-primary-hover) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-primary) focus-visible:ring-offset-2"
        >
          {t("invoices.list.newInvoice")}
        </Link>
      </div>

      <div className="mb-4 max-w-xs">
        <Select
          label={t("invoices.list.filterByState")}
          value={state}
          onChange={(e) => {
            setState(e.target.value as TransactionState | "");
            setPage(1);
          }}
          options={[
            { value: "", label: t("invoices.list.allStates") },
            ...(["DRAFT", "UNDER_REVIEW", "ELIGIBLE", "REJECTED"] as const).map((s) => ({
              value: s,
              label: t(transactionStateLabelKey(s)),
            })),
          ]}
        />
      </div>

      <Table
        columns={columns}
        rows={data?.items ?? []}
        rowKey={(row) => row.id ?? ""}
        loading={loading}
        emptyMessage={t("invoices.list.empty")}
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
