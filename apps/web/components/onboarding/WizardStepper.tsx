"use client";

import { useTranslations } from "@/lib/i18n/dictionary-context";
import { clsx } from "@/lib/clsx";

export interface WizardStep {
  key: string;
  labelKey: string;
}

/**
 * Wizard progress indicator.
 *
 * Steps render in document order and the connector uses logical inline
 * properties, so the whole strip mirrors under `dir="rtl"` without a
 * per-locale reversed array (RTL checklist rules #2 and #3). The step number
 * is the only numeral shown and is locale-formatted by the browser.
 */
export function WizardStepper({
  steps,
  currentIndex,
}: {
  steps: WizardStep[];
  currentIndex: number;
}) {
  const t = useTranslations();

  return (
    <nav aria-label={t("onboarding.wizard.progressLabel")}>
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-3">
        {steps.map((step, index) => {
          const done = index < currentIndex;
          const current = index === currentIndex;
          return (
            <li key={step.key} className="flex items-center gap-2">
              <span
                aria-hidden
                className={clsx(
                  "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-medium",
                  current
                    ? "bg-(--color-primary) text-(--color-primary-fg)"
                    : done
                      ? "bg-(--color-success-bg) text-(--color-success)"
                      : "bg-(--color-neutral-bg) text-(--color-muted)"
                )}
              >
                {index + 1}
              </span>
              <span
                aria-current={current ? "step" : undefined}
                className={clsx(
                  "text-sm",
                  current ? "font-medium text-(--color-fg)" : "text-(--color-muted)"
                )}
              >
                {t(step.labelKey)}
              </span>
              {index < steps.length - 1 && (
                <span
                  aria-hidden
                  className="ms-2 hidden h-px w-8 bg-(--color-border) sm:inline-block"
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
