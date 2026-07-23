"use client";

import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Badge } from "@/components/ui/Badge";
import type { RiskAssessment } from "@/lib/risk/risk-presentation";

/**
 * Positive factors, risk factors, and structured reason codes (ZM-RSK-004,
 * ZM-RSK-012). All three are bare strings on the wire — the contract does not
 * declare a catalogue — so each is looked up against a small local dictionary
 * and, for anything this client doesn't recognise, rendered as-is rather than
 * dropped. A factor the model produced that this build doesn't have a label
 * for is still real information; hiding it would be worse than showing the
 * raw code.
 */
function translateOrRaw(t: (key: string) => string, key: string, prefix: string): string {
  const translated = t(`${prefix}.${key}`);
  // useTranslations() returns the key itself when nothing matches — treat
  // that as "no label available" and fall back to the raw value.
  return translated === `${prefix}.${key}` ? key : translated;
}

export function FactorList({ assessment }: { assessment: RiskAssessment }) {
  const t = useTranslations();
  const positive = assessment.positiveFactors ?? [];
  const risk = assessment.riskFactors ?? [];
  const reasonCodes = assessment.reasonCodes ?? [];

  if (positive.length === 0 && risk.length === 0 && reasonCodes.length === 0) {
    return (
      <div className="rounded-lg border border-(--color-border) p-4">
        <p className="text-sm text-(--color-muted)">{t("risk.factors.none")}</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-(--color-border) p-4">
      {positive.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold">{t("risk.factors.positiveTitle")}</h3>
          <ul className="mt-2 flex flex-col gap-1.5">
            {positive.map((factor) => (
              <li key={factor} className="flex items-start gap-2 text-sm">
                <Badge tone="success">{t("risk.factors.positiveBadge")}</Badge>
                <span>{translateOrRaw(t, factor, "risk.factor.positive")}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {risk.length > 0 && (
        <div className={positive.length > 0 ? "mt-4" : undefined}>
          <h3 className="text-sm font-semibold">{t("risk.factors.riskTitle")}</h3>
          {/*
            "info" tone, not "warning" or "danger": ZM-VER-002's reasoning
            applies here too — a risk factor is something the bank should
            look at, not a verdict the platform has already reached. The
            bank forms its own credit decision (ZM-RSK-001); this list is
            the input to that, not the output.
          */}
          <ul className="mt-2 flex flex-col gap-1.5">
            {risk.map((factor) => (
              <li key={factor} className="flex items-start gap-2 text-sm">
                <Badge tone="info">{t("risk.factors.riskBadge")}</Badge>
                <span>{translateOrRaw(t, factor, "risk.factor.risk")}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {reasonCodes.length > 0 && (
        <div className={positive.length > 0 || risk.length > 0 ? "mt-4" : undefined}>
          <h3 className="text-sm font-semibold">{t("risk.factors.reasonCodesTitle")}</h3>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {reasonCodes.map((code) => (
              <li key={code}>
                <Badge tone="neutral">{translateOrRaw(t, code, "risk.reasonCode")}</Badge>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
