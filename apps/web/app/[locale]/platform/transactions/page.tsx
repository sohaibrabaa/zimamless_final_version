"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
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
 * The platform's transaction register — the same `GET /transactions` read
 * the supplier list uses, unscoped by the server for a PLATFORM context, so
 * this is every receivable on the platform, newest first.
 *
 * Read-only by design: the platform observes the marketplace, it does not
 * operate in it. Actions live where the accountable role lives (the case
 * desk, the relisting queue, settings) — a platform-side button on someone
 * else's transaction would be a governance bug, not a feature. Each row
 * links to the audit trail scoped to that transaction, which is the
 * platform's actual lens on a receivable's history.
 */
const PAGE_SIZE = 20;

// The states an operator actually scans for, in lifecycle order. The full
// enum is in the badge either way; the filter is a shortlist, not a schema.
const FILTER_STATES = [
  "UNDER_REVIEW",
  "ELIGIBLE",
  "OPEN_FOR_OFFERS",
  "CONTRACTED",
  "FUNDED",
  "OVERDUE_UNCONFIRMED",
  "OVERDUE",
  "RECOURSE_ACTIVE",
  "DISPUTED",
  "PAID",
  "CANCELLED",
] as const;

export default function PlatformTransactionsPage() {
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
      render: (row) => <span className="zm-ltr-embed">{row.referenceNumber ?? row.id}</span>,
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
    {
      key: "audit",
      header: "",
      align: "end",
      render: (row) =>
        row.id ? (
          <Link
            href={`/${locale}/platform/audit?entity=${row.id}`}
            className="text-xs underline underline-offset-2"
          >
            {t("admin.transactions.viewAudit")}
          </Link>
        ) : null,
    },
  ];

  if (error) {
    return (
      <ErrorState title={t("portal.errorLoadingData")} onRetry={reload} retryLabel={t("common.retry")} />
    );
  }

  const totalPages = data?.pagination?.totalPages ?? 1;
  const total = data?.pagination?.total ?? 0;

  return (
    <div>
      <h1 className="mb-1 text-lg font-semibold">{t("nav.transactions")}</h1>
      <p className="mb-4 text-sm text-(--color-muted)">
        {t("admin.transactions.subtitle", { total: String(total) })}
      </p>

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
            ...FILTER_STATES.map((s) => ({ value: s, label: t(transactionStateLabelKey(s)) })),
          ]}
        />
      </div>

      <Table
        columns={columns}
        rows={data?.items ?? []}
        rowKey={(row) => row.id ?? ""}
        loading={loading}
        emptyMessage={t("admin.transactions.empty")}
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
