"use client";

import { useI18n, useTranslations } from "@/lib/i18n/dictionary-context";
import { Badge } from "@/components/ui/Badge";
import { slaClockState, statusLabelKey, statusTone } from "@/lib/onboarding/status";
import {
  breakDownBusinessSeconds,
  formatDateTime,
  pauseReasonFor,
  pauseReasonKey,
  slaProgressFraction,
} from "@/lib/onboarding/sla";
import type { ApplicationView } from "@/lib/onboarding/useApplication";

/**
 * ZM-SON-009: the supplier must see remaining SLA time and current state at
 * all times.
 *
 * Remaining time is the server's `slaRemainingBusinessSeconds` verbatim — the
 * business calendar is not reimplemented client-side, so this figure does not
 * tick down between fetches. That is deliberate: a client-side countdown would
 * drift from the server's `sla_clock_events` ledger, and a paused clock that
 * appears to keep running would be actively misleading.
 */
export function SlaTracker({ application }: { application: ApplicationView }) {
  const t = useTranslations();
  const { locale } = useI18n();

  const clock = slaClockState(application.status, application.slaPaused);
  const remaining = breakDownBusinessSeconds(application.slaRemainingBusinessSeconds);
  const fraction = slaProgressFraction(application.slaRemainingBusinessSeconds);
  const deadline = formatDateTime(application.slaDeadlineAt, locale);
  const submitted = formatDateTime(application.submittedAt, locale);

  return (
    <section
      aria-labelledby="sla-tracker-heading"
      className="rounded-lg border border-(--color-border) p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="sla-tracker-heading" className="text-sm font-semibold">
          {t("onboarding.sla.title")}
        </h2>
        <Badge tone={statusTone(application.status)}>{t(statusLabelKey(application.status))}</Badge>
      </div>

      {clock === "NOT_STARTED" && (
        <p className="mt-2 text-sm text-(--color-muted)">{t("onboarding.sla.notStarted")}</p>
      )}

      {clock === "STOPPED" && (
        <p className="mt-2 text-sm text-(--color-muted)">
          {t("onboarding.sla.stopped")}
          {application.decidedAt && (
            <> {t("onboarding.sla.decidedOn", { date: formatDateTime(application.decidedAt, locale) ?? "" })}</>
          )}
        </p>
      )}

      {(clock === "RUNNING" || clock === "PAUSED") && (
        <div className="mt-3">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-2xl font-semibold tabular-nums">
              {remaining
                ? t("onboarding.sla.remainingValue", {
                    hours: remaining.hours,
                    minutes: remaining.minutes,
                  })
                : "—"}
            </span>
            <span className="text-sm text-(--color-muted)">
              {t("onboarding.sla.remainingLabel")}
            </span>
          </div>

          {fraction !== null && (
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(fraction * 100)}
              aria-label={t("onboarding.sla.title")}
              // Logical inline sizing only; the bar fills from the inline-start
              // edge, which mirrors automatically under dir="rtl"
              // (RTL checklist — progress indicators).
              className="mt-2 h-2 w-full overflow-hidden rounded-full bg-(--color-neutral-bg)"
            >
              <div
                className={
                  clock === "PAUSED"
                    ? "h-full rounded-full bg-(--color-muted)"
                    : "h-full rounded-full bg-(--color-primary)"
                }
                style={{ inlineSize: `${fraction * 100}%` }}
              />
            </div>
          )}

          {clock === "PAUSED" ? (
            // Paused is a process state, not an adverse one — neutral surface,
            // never a warning colour (ZM-SON-010).
            <div className="mt-3 rounded-md bg-(--color-neutral-bg) px-3 py-2">
              <p className="text-sm font-medium text-(--color-neutral-fg)">
                {t("onboarding.sla.pausedTitle")}
              </p>
              <p className="mt-0.5 text-sm text-(--color-neutral-fg)">
                {t(
                  pauseReasonKey(pauseReasonFor(application.status, application.slaPausedReason))
                )}
              </p>
            </div>
          ) : (
            deadline && (
              <p className="mt-2 text-xs text-(--color-muted)">
                {t("onboarding.sla.targetDecisionBy", { date: deadline })}
              </p>
            )
          )}
        </div>
      )}

      {submitted && (
        <p className="mt-3 text-xs text-(--color-muted)">
          {t("onboarding.sla.submittedOn", { date: submitted })}
        </p>
      )}
      <p className="mt-1 text-xs text-(--color-muted)">{t("onboarding.sla.businessHoursNote")}</p>
    </section>
  );
}
