"use client";

import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Badge } from "@/components/ui/Badge";
import { bandLabelKey, bandTone, type RiskAssessment } from "@/lib/risk/risk-presentation";

/**
 * The composite score and band (ZM-RSK-003). A single number 0–100 plus a
 * band badge — deliberately not a speedometer-style graphic with a needle,
 * which tends to read as more precise/authoritative than "decision support
 * only" (ZM-RSK-001) can support. The number is the whole visual; nothing
 * else on this component competes with it for attention.
 */
export function TrustScoreGauge({ assessment }: { assessment: RiskAssessment }) {
  const t = useTranslations();
  const score = assessment.compositeScore;

  return (
    <div className="rounded-lg border border-(--color-border) p-4">
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="text-xs text-(--color-muted)">{t("risk.compositeScoreLabel")}</p>
          <p className="zm-ltr-embed mt-1 text-3xl font-semibold tabular-nums" aria-hidden>
            {typeof score === "number" ? score : "—"}
            <span className="ms-1 text-base font-normal text-(--color-muted)">/ 100</span>
          </p>
        </div>
        <Badge tone={bandTone(assessment.band)}>{t(bandLabelKey(assessment.band))}</Badge>
      </div>
      <p className="sr-only">
        {t("risk.compositeScoreLabel")}: {typeof score === "number" ? score : "—"} {t("risk.outOf100")}.{" "}
        {t(bandLabelKey(assessment.band))}
      </p>
      <div
        className="mt-3 h-2 w-full overflow-hidden rounded-full bg-(--color-neutral-bg)"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={typeof score === "number" ? score : undefined}
        aria-label={t("risk.compositeScoreLabel")}
      >
        <div
          className="h-full rounded-full bg-(--color-primary)"
          style={{ width: `${Math.max(0, Math.min(100, score ?? 0))}%` }}
        />
      </div>
    </div>
  );
}
