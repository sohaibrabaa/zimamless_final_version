/**
 * Supplier application states and their SLA-clock semantics.
 *
 * `SupplierApplication.status` is a bare `string` in the frozen contract
 * (03_API_CONTRACT.yaml L1368), so the authority for the value set is the
 * requirements table in §5.5 (order of authority: contract → requirements).
 * Every helper here degrades safely on an unrecognised value rather than
 * throwing — an unknown state must never blank the supplier's status screen.
 */

export const APPLICATION_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "AUTOMATED_VERIFICATION",
  "UNDER_REVIEW",
  "INFORMATION_REQUIRED",
  "INFORMATION_RESUBMITTED",
  "GOVERNMENT_SERVICE_UNAVAILABLE",
  "FINAL_REVIEW",
  "APPROVED",
  "APPROVED_CONDITIONAL",
  "REJECTED",
] as const;

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export function isApplicationStatus(value: string | undefined): value is ApplicationStatus {
  return !!value && (APPLICATION_STATUSES as readonly string[]).includes(value);
}

/** Per requirements §5.5 — "Not started" / "Running" / "Paused" / "Stops". */
export type SlaClockState = "NOT_STARTED" | "RUNNING" | "PAUSED" | "STOPPED";

const CLOCK_BY_STATUS: Record<ApplicationStatus, SlaClockState> = {
  DRAFT: "NOT_STARTED",
  SUBMITTED: "RUNNING",
  AUTOMATED_VERIFICATION: "RUNNING",
  UNDER_REVIEW: "RUNNING",
  INFORMATION_REQUIRED: "PAUSED",
  INFORMATION_RESUBMITTED: "RUNNING",
  GOVERNMENT_SERVICE_UNAVAILABLE: "PAUSED",
  FINAL_REVIEW: "RUNNING",
  APPROVED: "STOPPED",
  APPROVED_CONDITIONAL: "STOPPED",
  REJECTED: "STOPPED",
};

/**
 * The server's `slaPaused` flag wins when present — the client's status→clock
 * table exists so the tracker still reads correctly if the flag is absent, and
 * so a state that pauses for a reason we can't yet name (see Q-03) is at least
 * never shown as counting down.
 */
export function slaClockState(
  status: string | undefined,
  slaPaused: boolean | undefined
): SlaClockState {
  const fromStatus = isApplicationStatus(status) ? CLOCK_BY_STATUS[status] : "RUNNING";
  if (fromStatus === "NOT_STARTED" || fromStatus === "STOPPED") return fromStatus;
  if (slaPaused === true) return "PAUSED";
  if (slaPaused === false) return "RUNNING";
  return fromStatus;
}

export function isDecided(status: string | undefined): boolean {
  return status === "APPROVED" || status === "APPROVED_CONDITIONAL" || status === "REJECTED";
}

/** ZM-SON-011: conditional approval means login and completion, but no financing actions. */
export function financingBlocked(status: string | undefined): boolean {
  return status !== "APPROVED";
}

/**
 * Badge tone per status.
 *
 * Deliberately conservative (brief §5, "Score vs. availability"): only a
 * confirmed adverse decision — REJECTED — gets a danger tone.
 * `GOVERNMENT_SERVICE_UNAVAILABLE` and `INFORMATION_REQUIRED` are neutral:
 * they are process states, not findings against the supplier
 * (ZM-SON-010, ZM-GOV-003). Do not "improve" this by colouring them amber.
 */
export type StatusTone = "neutral" | "success" | "danger" | "info";

export function statusTone(status: string | undefined): StatusTone {
  switch (status) {
    case "APPROVED":
      return "success";
    case "APPROVED_CONDITIONAL":
      return "info";
    case "REJECTED":
      return "danger";
    default:
      return "neutral";
  }
}

/** Dotted i18n key for a status label; unknown values fall back to the raw string. */
export function statusLabelKey(status: string | undefined): string {
  return isApplicationStatus(status) ? `onboarding.status.${status}` : "onboarding.status.UNKNOWN";
}

/** The statuses a reviewer can filter the queue by, in workflow order. */
export const REVIEW_QUEUE_FILTERS: ApplicationStatus[] = [
  "SUBMITTED",
  "AUTOMATED_VERIFICATION",
  "UNDER_REVIEW",
  "INFORMATION_REQUIRED",
  "INFORMATION_RESUBMITTED",
  "GOVERNMENT_SERVICE_UNAVAILABLE",
  "FINAL_REVIEW",
  "APPROVED",
  "APPROVED_CONDITIONAL",
  "REJECTED",
];
