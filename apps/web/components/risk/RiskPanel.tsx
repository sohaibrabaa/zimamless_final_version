"use client";

import { useI18n, useTranslations } from "@/lib/i18n/dictionary-context";
import { Badge } from "@/components/ui/Badge";
import { TrustScoreGauge } from "./TrustScoreGauge";
import { ComponentBars } from "./ComponentBars";
import { FactorList } from "./FactorList";
import { modelModeLabelKey, type RiskAssessment } from "@/lib/risk/risk-presentation";

/**
 * Composes the score display: gauge, component bars, factors, and the four
 * things that must appear on **every** score display per the phase file
 * and requirements — the disclaimer (ZM-RSK-001/002, both languages), model
 * version, calculation date, and the `mlUsed`/fallback flag (ZM-RSK-017).
 *
 * The disclaimer text is sourced from i18n, not from `assessment.disclaimer`.
 * The contract types that field as a bare string with no locale guarantee,
 * and ZM-RSK-002 requires the disclaimer in **both** languages — the same
 * reasoning that keeps every other compliance-adjacent string in this
 * codebase (consent text, declaration text, ineligibility copy) sourced from
 * the message catalogues rather than trusted to arrive pre-localized.
 */
export function RiskPanel({ assessment }: { assessment: RiskAssessment | null | undefined }) {
  const t = useTranslations();
  const { locale } = useI18n();

  if (!assessment) {
    return (
      <div className="rounded-lg border border-(--color-border) p-4">
        <p className="text-sm text-(--color-muted)">{t("risk.notAvailable")}</p>
      </div>
    );
  }

  const calculatedAt = assessment.calculatedAt
    ? new Intl.DateTimeFormat(locale === "ar" ? "ar" : "en", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(assessment.calculatedAt))
    : null;

  return (
    <div className="flex flex-col gap-4">
      <TrustScoreGauge assessment={assessment} />
      <ComponentBars assessment={assessment} />
      <FactorList assessment={assessment} />

      <div className="rounded-lg border border-(--color-border) p-4">
        <div className="flex flex-wrap items-center gap-2 text-xs text-(--color-muted)">
          <span>{t("risk.modelVersion", { version: assessment.modelVersion ?? "—" })}</span>
          {calculatedAt && (
            <>
              <span aria-hidden>·</span>
              <span className="zm-ltr-embed">{t("risk.calculatedAt", { date: calculatedAt })}</span>
            </>
          )}
          <span aria-hidden>·</span>
          <Badge tone={assessment.mlUsed === false ? "neutral" : "info"}>
            {t(modelModeLabelKey(assessment.mlUsed))}
          </Badge>
        </div>

        {assessment.mlUsed === false && (
          <p className="mt-2 text-xs text-(--color-muted)">
            {t("risk.fallbackNotice", {
              reason: assessment.mlFallbackReason ?? t("risk.fallbackReasonUnknown"),
            })}
          </p>
        )}

        {/* ZM-RSK-002: on every score display, both languages — this line is
            never omitted regardless of screen or persona. */}
        <p className="mt-3 border-t border-(--color-border) pt-3 text-xs text-(--color-muted)">
          {t("risk.disclaimer")}
        </p>

        {/* ZM-RSK-016: the synthetic-training-data limitation is disclosed in
            the UI, not only in the ML design doc. */}
        <p className="mt-1 text-xs text-(--color-muted)">{t("risk.syntheticDataNotice")}</p>
      </div>
    </div>
  );
}
