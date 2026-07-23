"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { SkeletonText } from "@/components/ui/Skeleton";
import { ErrorState, EmptyState } from "@/components/ui/StatePanels";
import { ApiError } from "@/lib/api/client";
import { fulfilCondition, useConditions, type OfferCondition } from "@/lib/contracts/useContracts";

/**
 * Conditions checklist (`GET /transactions/{id}/conditions`,
 * `POST /conditions/{id}/fulfil`). Every condition on the accepted offer's
 * frozen snapshot, with per-condition status and a fulfil action that
 * attaches evidence — ZM-CON-006 will not let a contract generate while any
 * *mandatory* condition here is still `PENDING`, so this screen is the
 * thing standing between acceptance and the contract, not a courtesy log.
 *
 * No waive action exists here: the contract declares no waive endpoint
 * (only `fulfil`), so a "waived with reason" state — which ZM-CON-006 also
 * names as acceptable — has nothing to call. Not filed as a gap: waiving is
 * plausibly a platform/bank-side decision, not a supplier self-service
 * action, so its absence from *this* screen's endpoint may be intentional.
 */
export default function ConditionsChecklistPage() {
  const t = useTranslations();
  const params = useParams<{ locale: string; id: string }>();
  const locale = params?.locale === "ar" ? "ar" : "en";
  const transactionId = params?.id;

  const { data: conditions, loading, error, reload } = useConditions(transactionId);

  if (loading) return <SkeletonText lines={5} />;
  if (error) return <ErrorState title={error} onRetry={reload} retryLabel={t("common.retry")} />;

  return (
    <div className="max-w-2xl">
      <Link
        href={`/${locale}/supplier/invoices/${transactionId}`}
        className="text-sm text-(--color-muted) underline underline-offset-2"
      >
        {t("marketplace.comparison.backToInvoice")}
      </Link>

      <h1 className="mt-3 mb-1 text-lg font-semibold">{t("marketplace.conditions.title")}</h1>
      <p className="mb-5 text-sm text-(--color-muted)">{t("marketplace.conditions.intro")}</p>

      {(conditions ?? []).length === 0 && <EmptyState title={t("marketplace.conditions.empty")} />}

      <div className="flex flex-col gap-3">
        {(conditions ?? []).map((condition) => (
          <ConditionRow key={condition.id} condition={condition} onFulfilled={reload} />
        ))}
      </div>
    </div>
  );
}

function ConditionRow({ condition, onFulfilled }: { condition: OfferCondition; onFulfilled: () => void }) {
  const t = useTranslations();
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fulfil() {
    if (!condition.id) return;
    setBusy(true);
    setError(null);
    try {
      await fulfilCondition(condition.id, notes || undefined);
      onFulfilled();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("common.unknownError"));
    } finally {
      setBusy(false);
    }
  }

  const resolved = condition.fulfilment === "FULFILLED" || condition.fulfilment === "WAIVED";

  return (
    <div className="rounded-lg border border-(--color-border) p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">
          {condition.title || t(`marketplace.offer.conditionType.${condition.conditionType}`)}
        </span>
        <div className="flex gap-2">
          {condition.isMandatory && <Badge tone="warning">{t("marketplace.offer.conditionMandatory")}</Badge>}
          <Badge tone={resolved ? "success" : "neutral"}>
            {t(`marketplace.conditions.status.${condition.fulfilment ?? "PENDING"}`)}
          </Badge>
        </div>
      </div>
      {condition.description && <p className="mt-1 text-xs text-(--color-muted)">{condition.description}</p>}

      {!resolved && (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
          <Input
            label={t("marketplace.conditions.notesLabel")}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="flex-1"
          />
          <Button type="button" size="sm" disabled={busy} onClick={fulfil}>
            {busy ? t("common.loading") : t("marketplace.conditions.markFulfilled")}
          </Button>
        </div>
      )}
      {error && <p className="mt-2 text-xs text-(--color-danger)">{error}</p>}
    </div>
  );
}
