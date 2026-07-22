"use client";

import { useState } from "react";
import { apiClient, ApiError } from "@/lib/api/client";
import { useI18n, useTranslations } from "@/lib/i18n/dictionary-context";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { SkeletonText } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/StatePanels";
import { useToast } from "@/components/ui/Toast";
import { formatDateTime } from "@/lib/onboarding/sla";
import { useInformationRequests } from "@/lib/onboarding/useApplication";

/**
 * Information-request inbox and response form (§5.6).
 *
 * Responding is what resumes the SLA clock (ZM-SON-008 records the resume
 * server-side), so the form states that plainly — the supplier should
 * understand that the delay is currently on their side, without the UI
 * scolding them about it.
 */
export function InformationRequestInbox({
  applicationId,
  onResponded,
  /**
   * The reviewer sees the same thread but cannot answer on the supplier's
   * behalf — responding is what resumes the clock, and only the supplier may
   * do that (§5.5 INFORMATION_RESUBMITTED).
   */
  readOnly = false,
}: {
  applicationId: string | undefined;
  onResponded: () => void;
  readOnly?: boolean;
}) {
  const t = useTranslations();
  const { locale } = useI18n();
  const { show } = useToast();
  const { data, loading, error, reload } = useInformationRequests(applicationId);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [response, setResponse] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function submitResponse(informationRequestId: string) {
    setBusy(true);
    setFormError(null);
    try {
      const { error: apiError } = await apiClient.POST(
        "/onboarding/applications/{id}/respond",
        {
          params: { path: { id: applicationId ?? "" } },
          body: { informationRequestId, response: response.trim() },
        }
      );
      if (apiError) throw apiError;
      show({ title: t("onboarding.informationRequests.responded"), tone: "success" });
      setActiveId(null);
      setResponse("");
      reload();
      onResponded();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : t("common.unknownError"));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <SkeletonText lines={3} />;
  if (error) {
    return (
      <ErrorState
        title={t("portal.errorLoadingData")}
        onRetry={reload}
        retryLabel={t("common.retry")}
      />
    );
  }
  if (!data || data.length === 0) {
    return (
      <EmptyState
        title={t("onboarding.informationRequests.emptyTitle")}
        description={t("onboarding.informationRequests.emptyBody")}
      />
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {data.map((request) => {
        const open = request.status === "OPEN";
        const requestedAt = formatDateTime(request.requestedAt, locale);
        return (
          <li key={request.id} className="rounded-lg border border-(--color-border) px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">{request.requestedItem}</p>
              {/* Neutral for OPEN: an outstanding request is a normal step, not a fault. */}
              <Badge tone={open ? "neutral" : "success"}>
                {t(`onboarding.informationRequests.status.${request.status ?? "OPEN"}`)}
              </Badge>
            </div>
            {request.description && (
              <p className="mt-1 text-sm text-(--color-muted)">{request.description}</p>
            )}
            {requestedAt && (
              <p className="mt-1 text-xs text-(--color-muted)">
                {t("onboarding.informationRequests.requestedOn", { date: requestedAt })}
              </p>
            )}

            {open && !readOnly && activeId !== request.id && (
              <Button
                type="button"
                size="sm"
                className="mt-3"
                onClick={() => {
                  setActiveId(request.id ?? null);
                  setResponse("");
                }}
              >
                {t("onboarding.informationRequests.respond")}
              </Button>
            )}

            {open && !readOnly && activeId === request.id && (
              <form
                className="mt-3 flex flex-col gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (request.id) submitResponse(request.id);
                }}
              >
                <label
                  htmlFor={`response-${request.id}`}
                  className="text-sm font-medium text-(--color-fg)"
                >
                  {t("onboarding.informationRequests.responseLabel")}
                </label>
                <textarea
                  id={`response-${request.id}`}
                  rows={4}
                  value={response}
                  onChange={(e) => setResponse(e.target.value)}
                  required
                  className="rounded-md border border-(--color-border) bg-(--color-bg) px-3 py-2 text-sm text-(--color-fg) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-primary)"
                />
                {/*
                  Document attachment needs POST /documents/upload-url, which is
                  Phase 3. Placeholder rather than a non-functional file input.
                */}
                <p className="rounded-md border border-dashed border-(--color-border) px-3 py-2 text-xs text-(--color-muted)">
                  {t("onboarding.informationRequests.attachmentPlaceholder")}
                </p>
                <p className="text-xs text-(--color-muted)">
                  {t("onboarding.informationRequests.resumesClock")}
                </p>
                {formError && (
                  <p role="alert" className="text-sm text-(--color-danger)">
                    {formError}
                  </p>
                )}
                <div className="flex gap-2">
                  <Button type="submit" size="sm" loading={busy} disabled={response.trim() === ""}>
                    {t("common.submit")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => setActiveId(null)}
                  >
                    {t("common.cancel")}
                  </Button>
                </div>
              </form>
            )}
          </li>
        );
      })}
    </ul>
  );
}
