"use client";

import { useState } from "react";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { ErrorState } from "@/components/ui/StatePanels";
import { SkeletonText } from "@/components/ui/Skeleton";
import { ApiError } from "@/lib/api/client";
import {
  createPolicyFilter,
  updatePolicyFilter,
  usePolicyFilters,
  type PolicyFilterInput,
} from "@/lib/marketplace/usePolicyFilters";
import { RISK_BAND_OPTIONS, type PolicyFilterRecord } from "@/lib/marketplace/policy-filters";

const EMPTY_DRAFT: PolicyFilterInput = { name: "", isActive: true };

/**
 * Policy-filter configuration (ZM-MKT-001, v3.1.0 `PATCH .../{id}` — D-12).
 * Every field the requirement's table names is present; only the range and
 * threshold rows are actually evaluated against a listing today (see the
 * "not applicable" note in `lib/marketplace/policy-filters.ts` for
 * `sectorsInclude`/`sectorsExclude` and the two per-offer type filters —
 * they are still configurable here since the requirement lists them as
 * bank-configurable, they just do not gate eligibility yet).
 */
export default function PolicyFiltersPage() {
  const t = useTranslations();
  const { data: filters, loading, error, reload } = usePolicyFilters();
  const [draft, setDraft] = useState<PolicyFilterInput>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function submitNew() {
    if (!draft.name) return;
    setBusy(true);
    setFormError(null);
    try {
      await createPolicyFilter(draft);
      setDraft(EMPTY_DRAFT);
      reload();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : t("common.unknownError"));
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(filter: PolicyFilterRecord) {
    setBusy(true);
    try {
      await updatePolicyFilter(filter.id, { isActive: !filter.isActive });
      reload();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : t("common.unknownError"));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <SkeletonText lines={4} />;
  if (error) {
    return <ErrorState title={t("portal.errorLoadingData")} onRetry={reload} retryLabel={t("common.retry")} />;
  }

  return (
    <div className="max-w-2xl">
      <h1 className="mb-1 text-lg font-semibold">{t("marketplace.policyFilters.title")}</h1>
      <p className="mb-4 text-sm text-(--color-muted)">{t("marketplace.policyFilters.intro")}</p>

      <div className="flex flex-col gap-3">
        {(filters ?? []).map((filter) => (
          <div key={filter.id} className="rounded-lg border border-(--color-border) p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">{filter.name}</p>
              <Badge tone={filter.isActive ? "success" : "neutral"}>
                {filter.isActive ? t("marketplace.policyFilters.active") : t("marketplace.policyFilters.inactive")}
              </Badge>
            </div>
            <dl className="mt-3 grid gap-2 text-xs text-(--color-muted) sm:grid-cols-2">
              {filter.minAmount && (
                <div>
                  {t("marketplace.policyFilters.minAmount")}: <span className="zm-ltr-embed">{filter.minAmount}</span>
                </div>
              )}
              {filter.maxAmount && (
                <div>
                  {t("marketplace.policyFilters.maxAmount")}: <span className="zm-ltr-embed">{filter.maxAmount}</span>
                </div>
              )}
              {filter.minTenorDays !== undefined && (
                <div>
                  {t("marketplace.policyFilters.minTenorDays")}: {filter.minTenorDays}
                </div>
              )}
              {filter.maxTenorDays !== undefined && (
                <div>
                  {t("marketplace.policyFilters.maxTenorDays")}: {filter.maxTenorDays}
                </div>
              )}
              {filter.minTrustScore !== undefined && (
                <div>
                  {t("marketplace.policyFilters.minTrustScore")}: {filter.minTrustScore}
                </div>
              )}
              {filter.maxRiskBand && (
                <div>
                  {t("marketplace.policyFilters.maxRiskBand")}: {filter.maxRiskBand}
                </div>
              )}
            </dl>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="mt-3"
              disabled={busy}
              onClick={() => toggleActive(filter)}
            >
              {filter.isActive
                ? t("marketplace.policyFilters.deactivate")
                : t("marketplace.policyFilters.activate")}
            </Button>
          </div>
        ))}
        {(filters ?? []).length === 0 && (
          <p className="text-sm text-(--color-muted)">{t("marketplace.policyFilters.empty")}</p>
        )}
      </div>

      <section className="mt-6 rounded-lg border border-(--color-border) p-4">
        <h2 className="text-sm font-semibold">{t("marketplace.policyFilters.newTitle")}</h2>
        <div className="mt-3 flex flex-col gap-3">
          <Input
            label={t("marketplace.policyFilters.name")}
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            required
          />
          <Input
            label={t("marketplace.policyFilters.minAmount")}
            value={draft.minAmount ?? ""}
            onChange={(e) => setDraft((d) => ({ ...d, minAmount: e.target.value || undefined }))}
          />
          <Input
            label={t("marketplace.policyFilters.maxAmount")}
            value={draft.maxAmount ?? ""}
            onChange={(e) => setDraft((d) => ({ ...d, maxAmount: e.target.value || undefined }))}
          />
          <Input
            label={t("marketplace.policyFilters.minTenorDays")}
            type="number"
            value={draft.minTenorDays ?? ""}
            onChange={(e) =>
              setDraft((d) => ({ ...d, minTenorDays: e.target.value ? +e.target.value : undefined }))
            }
          />
          <Input
            label={t("marketplace.policyFilters.maxTenorDays")}
            type="number"
            value={draft.maxTenorDays ?? ""}
            onChange={(e) =>
              setDraft((d) => ({ ...d, maxTenorDays: e.target.value ? +e.target.value : undefined }))
            }
          />
          <Input
            label={t("marketplace.policyFilters.minTrustScore")}
            type="number"
            value={draft.minTrustScore ?? ""}
            onChange={(e) =>
              setDraft((d) => ({ ...d, minTrustScore: e.target.value ? +e.target.value : undefined }))
            }
          />
          <Select
            label={t("marketplace.policyFilters.maxRiskBand")}
            value={draft.maxRiskBand ?? ""}
            onChange={(e) =>
              setDraft((d) => ({ ...d, maxRiskBand: (e.target.value || undefined) as PolicyFilterInput["maxRiskBand"] }))
            }
            options={[
              { value: "", label: t("marketplace.policyFilters.noRiskBandCeiling") },
              ...RISK_BAND_OPTIONS.map((b) => ({ value: b, label: b })),
            ]}
          />
          {formError && <p className="text-sm text-(--color-danger)">{formError}</p>}
          <Button type="button" onClick={submitNew} disabled={busy || !draft.name}>
            {t("marketplace.policyFilters.create")}
          </Button>
        </div>
      </section>
    </div>
  );
}
