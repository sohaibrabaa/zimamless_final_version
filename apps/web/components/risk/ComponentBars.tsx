"use client";

import { useTranslations } from "@/lib/i18n/dictionary-context";
import {
  COMPONENT_KEYS,
  componentLabelKey,
  dataAvailabilityLabel,
  dataAvailabilityNeutralTone,
  type RiskAssessment,
} from "@/lib/risk/risk-presentation";
import { Badge } from "@/components/ui/Badge";

/**
 * The five §9.2 components, plus `dataAvailabilityPct` shown as its own row
 * — never one of the five bars, and never coloured by value (ZM-RSK-005/006).
 *
 * This separation is the component's entire reason to exist: a reviewer
 * skimming five bars and a sixth number should not be able to mistake the
 * sixth for a sixth component. It gets a divider, a different label pattern
 * (a badge, not a filled bar), and an explanatory tooltip rather than a bar
 * fill — because a bar fill invites reading "more filled = better", which is
 * precisely backwards for a number that only ever means "we know less".
 */
export function ComponentBars({ assessment }: { assessment: RiskAssessment }) {
  const t = useTranslations();
  const components = assessment.components ?? {};

  return (
    <div className="rounded-lg border border-(--color-border) p-4">
      <h3 className="text-sm font-semibold">{t("risk.components.title")}</h3>
      {/*
        Every bar fills in the same colour regardless of value — a low
        component score is a measurement, not an alert (ZM-RSK-001: the
        score is decision support, not a verdict), and a colour that dims or
        reddens with the number would read as one anyway.
      */}
      <ul className="mt-3 flex flex-col gap-3">
        {COMPONENT_KEYS.map((key) => {
          const value = components[key];
          return (
            <li key={key}>
              <div className="mb-1 flex items-center justify-between text-sm">
                <span>{t(componentLabelKey(key))}</span>
                <span className="zm-ltr-embed tabular-nums text-(--color-muted)">
                  {typeof value === "number" ? value : "—"}
                </span>
              </div>
              <div
                className="h-1.5 w-full overflow-hidden rounded-full bg-(--color-neutral-bg)"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={typeof value === "number" ? value : undefined}
                aria-label={t(componentLabelKey(key))}
              >
                <div
                  className="h-full rounded-full bg-(--color-primary)"
                  style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>

      <div className="mt-4 border-t border-(--color-border) pt-3">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-sm">
            {t("risk.dataAvailability.label")}
            <span
              className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-(--color-border) text-[10px] text-(--color-muted)"
              title={t("risk.dataAvailability.tooltip")}
              aria-hidden
            >
              ?
            </span>
          </span>
          {/*
            Deliberately a neutral Badge, not a coloured bar — and its tone
            comes from `dataAvailabilityNeutralTone()`, a function with no
            code path that can return a warning shade, so a future edit
            cannot accidentally wire this to score-style coloring.
          */}
          <Badge tone={dataAvailabilityNeutralTone()}>
            {dataAvailabilityLabel(assessment.dataAvailabilityPct)}
          </Badge>
        </div>
        <p className="mt-1 text-xs text-(--color-muted)">{t("risk.dataAvailability.tooltip")}</p>
      </div>
    </div>
  );
}
