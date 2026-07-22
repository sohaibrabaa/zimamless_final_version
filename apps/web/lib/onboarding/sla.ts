/**
 * Presentation helpers for the 24-business-hour onboarding SLA (ZM-SON-006..009).
 *
 * The business calendar (Sun–Thu 08:00–17:00 Asia/Amman + holidays) lives
 * server-side and is NOT reimplemented here: the client only ever formats the
 * `slaRemainingBusinessSeconds` figure the API computed. Deriving business
 * time in the browser would drift from the server's `sla_clock_events` record
 * and is exactly the kind of client-side recomputation the build plan forbids.
 */

/** ZM-SON-006 target, used only to scale the progress bar. */
export const SLA_TOTAL_BUSINESS_SECONDS = 24 * 60 * 60;

export interface SlaBreakdown {
  hours: number;
  minutes: number;
  /** True once the server reports the remaining budget exhausted. */
  overdue: boolean;
}

export function breakDownBusinessSeconds(remaining: number | undefined): SlaBreakdown | null {
  if (remaining === undefined || !Number.isFinite(remaining)) return null;
  const clamped = Math.max(0, remaining);
  return {
    hours: Math.floor(clamped / 3600),
    minutes: Math.floor((clamped % 3600) / 60),
    overdue: remaining <= 0,
  };
}

/**
 * Fraction of the SLA budget still available, 0..1, for the progress bar.
 * Returns null when the API didn't send a remaining figure — the bar is then
 * omitted rather than rendered at a guessed width.
 */
export function slaProgressFraction(remaining: number | undefined): number | null {
  if (remaining === undefined || !Number.isFinite(remaining)) return null;
  const clamped = Math.min(Math.max(remaining, 0), SLA_TOTAL_BUSINESS_SECONDS);
  return clamped / SLA_TOTAL_BUSINESS_SECONDS;
}

/**
 * Pause reason.
 *
 * The contract exposes no pause-reason field (escalated as **Q-03**); until it
 * does, the reason is inferred from the two statuses requirements §5.5 marks
 * as pausing, and a server-sent `slaPausedReason` is preferred the moment one
 * appears. `GOVERNMENT_SERVICE_UNAVAILABLE` gets its own key precisely so it
 * can read as "the registry hasn't answered yet" and never as a finding
 * against the supplier (ZM-SON-010, ZM-GOV-003).
 */
export type SlaPauseReason =
  | "INFORMATION_REQUIRED"
  | "GOVERNMENT_SERVICE_UNAVAILABLE"
  | "UNSPECIFIED";

export function pauseReasonFor(
  status: string | undefined,
  serverReason: string | undefined
): SlaPauseReason {
  if (serverReason === "INFORMATION_REQUIRED" || serverReason === "GOVERNMENT_SERVICE_UNAVAILABLE") {
    return serverReason;
  }
  if (status === "INFORMATION_REQUIRED" || status === "GOVERNMENT_SERVICE_UNAVAILABLE") {
    return status;
  }
  return "UNSPECIFIED";
}

export function pauseReasonKey(reason: SlaPauseReason): string {
  return `onboarding.sla.pauseReason.${reason}`;
}

/** Absolute timestamps are rendered in the user's locale; the value itself stays the server's. */
export function formatDateTime(value: string | undefined | null, locale: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function formatDate(value: string | undefined | null, locale: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
}
