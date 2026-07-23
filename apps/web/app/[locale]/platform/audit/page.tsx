"use client";

import { useState } from "react";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Table, type TableColumn } from "@/components/ui/Table";
import { ErrorState } from "@/components/ui/StatePanels";
import { useAuditLogs, type AuditLog } from "@/lib/admin/useAdmin";

/**
 * The audit trail (Phase 9.4's screen half).
 *
 * Every mutation the platform has recorded, paginated, filterable by the
 * entity it targeted. Read-only by construction: audit rows have no edit or
 * delete anywhere in the system (INV-7), so this screen offers none.
 *
 * The filter takes an entity id rather than free text because that is what
 * the endpoint indexes and what support actually holds when they arrive
 * here: a transaction id off an error screen's correlation trail.
 */
export default function PlatformAuditPage() {
  const t = useTranslations();
  const [page, setPage] = useState(1);
  const [entityInput, setEntityInput] = useState("");
  const [entityFilter, setEntityFilter] = useState<string | undefined>(undefined);

  const logs = useAuditLogs(page, 20, entityFilter);

  const columns: TableColumn<AuditLog>[] = [
    {
      key: "occurredAt",
      header: t("admin.audit.when"),
      render: (row) => (
        <span className="whitespace-nowrap tabular-nums">
          {row.occurredAt
            ? new Date(row.occurredAt).toISOString().replace("T", " ").slice(0, 19)
            : "—"}
        </span>
      ),
    },
    {
      key: "actionType",
      header: t("admin.audit.action"),
      render: (row) => <span className="font-medium">{row.actionType}</span>,
    },
    {
      key: "target",
      header: t("admin.audit.target"),
      render: (row) => (
        <span className="text-(--color-muted)">
          {row.targetEntityType}
          {row.targetEntityId ? ` · ${row.targetEntityId.slice(0, 8)}…` : ""}
        </span>
      ),
    },
    {
      key: "actor",
      header: t("admin.audit.actor"),
      render: (row) => (
        <span className="text-(--color-muted)">
          {row.actorUserId ? `${row.actorUserId.slice(0, 8)}…` : t("admin.audit.system")}
        </span>
      ),
    },
  ];

  const total = logs.data?.pagination?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / 20));

  return (
    <div className="max-w-4xl">
      <h1 className="mb-1 text-lg font-semibold">{t("admin.audit.title")}</h1>
      <p className="mb-4 text-sm text-(--color-muted)">{t("admin.audit.subtitle")}</p>

      <form
        className="mb-4 flex max-w-xl items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setEntityFilter(entityInput.trim() || undefined);
        }}
      >
        <div className="grow">
          <Input
            label={t("admin.audit.filterLabel")}
            placeholder={t("admin.audit.filterPlaceholder")}
            value={entityInput}
            onChange={(e) => setEntityInput(e.target.value)}
          />
        </div>
        <Button type="submit" size="sm">
          {t("admin.audit.filterApply")}
        </Button>
      </form>

      {logs.error ? (
        <ErrorState title={logs.error} onRetry={logs.reload} retryLabel={t("common.retry")} />
      ) : (
        <>
          <Table
            columns={columns}
            rows={logs.data?.items ?? []}
            rowKey={(row) => row.id ?? `${row.actionType}-${row.occurredAt}`}
            emptyMessage={t("admin.audit.empty")}
            loading={logs.loading}
          />
          <div className="mt-3 flex items-center justify-between text-sm text-(--color-muted)">
            <span>{t("admin.audit.pageInfo")}: {page} / {totalPages} · {total}</span>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={page <= 1 || logs.loading}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                {t("common.previous")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={page >= totalPages || logs.loading}
                onClick={() => setPage((p) => p + 1)}
              >
                {t("common.next")}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
