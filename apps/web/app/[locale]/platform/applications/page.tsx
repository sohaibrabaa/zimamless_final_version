"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { apiClient } from "@/lib/api/client";
import { useAsyncResource } from "@/lib/api/useAsyncResource";
import { useI18n, useTranslations } from "@/lib/i18n/dictionary-context";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { Table, type TableColumn } from "@/components/ui/Table";
import { ErrorState } from "@/components/ui/StatePanels";
import { breakDownBusinessSeconds, formatDateTime } from "@/lib/onboarding/sla";
import { REVIEW_QUEUE_FILTERS, statusLabelKey, statusTone } from "@/lib/onboarding/status";
import type { ApplicationView } from "@/lib/onboarding/useApplication";

const PAGE_SIZE = 20;

/**
 * Reviewer queue (D-05 `/onboarding/applications-list`).
 *
 * Order is exactly what the server returns and there is no "priority" or
 * "review this next" affordance — the reviewer picks. Remaining SLA is shown
 * as information, not as a ranking, and a paused clock says "paused" rather
 * than displaying a countdown that isn't running.
 */
export default function PlatformApplicationsPage() {
  const t = useTranslations();
  const { locale } = useI18n();
  const { locale: localeParam } = useParams<{ locale: string }>();

  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);

  const { data, loading, error, reload } = useAsyncResource(async () => {
    const { data: body, error: apiError } = await apiClient.GET("/onboarding/applications-list", {
      params: { query: { page, pageSize: PAGE_SIZE, ...(status ? { status } : {}) } },
    });
    if (apiError) throw apiError;
    return body;
  }, [page, status]);

  const items = (data?.items as ApplicationView[] | undefined) ?? [];
  const totalPages = data?.pagination?.totalPages ?? 1;
  const total = data?.pagination?.total ?? 0;

  const columns: TableColumn<ApplicationView>[] = [
    {
      key: "organization",
      header: t("onboarding.queue.column.organization"),
      render: (row) => (
        <Link
          href={`/${localeParam}/platform/applications/${row.id}`}
          className="font-medium text-(--color-primary) underline-offset-2 hover:underline"
        >
          {row.organizationName ?? row.organizationId ?? "—"}
        </Link>
      ),
    },
    {
      key: "establishmentNumber",
      header: t("onboarding.field.nationalEstablishmentNumber"),
      render: (row) => (
        <span className="zm-ltr-embed">{row.nationalEstablishmentNumber ?? "—"}</span>
      ),
    },
    {
      key: "status",
      header: t("onboarding.queue.column.status"),
      render: (row) => <Badge tone={statusTone(row.status)}>{t(statusLabelKey(row.status))}</Badge>,
    },
    {
      key: "submittedAt",
      header: t("onboarding.queue.column.submitted"),
      render: (row) => formatDateTime(row.submittedAt, locale) ?? "—",
    },
    {
      key: "sla",
      header: t("onboarding.queue.column.slaRemaining"),
      align: "end",
      render: (row) => {
        if (row.slaPaused) {
          return <span className="text-(--color-muted)">{t("onboarding.queue.slaPaused")}</span>;
        }
        const remaining = breakDownBusinessSeconds(row.slaRemainingBusinessSeconds);
        return remaining
          ? t("onboarding.sla.remainingValue", {
              hours: remaining.hours,
              minutes: remaining.minutes,
            })
          : "—";
      },
    },
  ];

  return (
    <div>
      <h1 className="mb-4 text-lg font-semibold">{t("onboarding.queue.title")}</h1>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Select
          label={t("onboarding.queue.filterByStatus")}
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
          options={[
            { value: "", label: t("onboarding.queue.allStatuses") },
            ...REVIEW_QUEUE_FILTERS.map((s) => ({ value: s, label: t(`onboarding.status.${s}`) })),
          ]}
        />
        <span className="pb-2 text-xs text-(--color-muted)">
          {t("onboarding.queue.resultCount", { count: total })}
        </span>
      </div>

      {error ? (
        <ErrorState
          title={t("portal.errorLoadingData")}
          onRetry={reload}
          retryLabel={t("common.retry")}
        />
      ) : (
        <>
          <Table
            columns={columns}
            rows={items}
            rowKey={(row) => row.id ?? ""}
            loading={loading}
            emptyMessage={t("onboarding.queue.empty")}
          />
          {totalPages > 1 && (
            <div className="mt-3 flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                {t("common.back")}
              </Button>
              <span className="text-xs text-(--color-muted)">
                {t("onboarding.queue.pageOf", { page, totalPages })}
              </span>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                {t("common.next")}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
