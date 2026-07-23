import type { components } from "@/lib/api/generated/schema";
import type { BadgeTone } from "@/components/ui/Badge";

export type TransactionState = components["schemas"]["TransactionState"];

/**
 * Supplier-facing presentation of each transaction state. Phase 3 renders
 * states through ELIGIBLE (phase file, B tasks); the later states are mapped
 * now so a live payload from a further phase degrades to a labelled badge
 * rather than a raw enum string.
 *
 * Tone discipline (kickoff standing facts + brief §5):
 * - Review/queue states are informational, never warnings — being looked at
 *   is not an adverse fact about the supplier.
 * - FRAUD_REVIEW renders to the supplier as plain "under review". The
 *   internal case name is platform vocabulary; showing it to the supplier
 *   would present an unresolved screen as an accusation.
 * - OVERDUE_UNCONFIRMED always reads "awaiting bank confirmation", never
 *   "defaulted" (hard rule 8) — the key carries that copy from day one even
 *   though the state itself ships in Phase 7.
 */
interface StatePresentation {
  labelKey: string;
  tone: BadgeTone;
}

const STATES: Record<TransactionState, StatePresentation> = {
  DRAFT: { labelKey: "invoices.state.DRAFT", tone: "neutral" },
  SUBMITTED: { labelKey: "invoices.state.SUBMITTED", tone: "info" },
  AUTOMATED_CHECKS: { labelKey: "invoices.state.AUTOMATED_CHECKS", tone: "info" },
  UNDER_REVIEW: { labelKey: "invoices.state.UNDER_REVIEW", tone: "info" },
  INFORMATION_REQUIRED: { labelKey: "invoices.state.INFORMATION_REQUIRED", tone: "warning" },
  ELIGIBLE: { labelKey: "invoices.state.ELIGIBLE", tone: "success" },
  OPEN_FOR_OFFERS: { labelKey: "invoices.state.OPEN_FOR_OFFERS", tone: "info" },
  OFFER_ACCEPTED: { labelKey: "invoices.state.OFFER_ACCEPTED", tone: "success" },
  CONDITIONS_PENDING: { labelKey: "invoices.state.CONDITIONS_PENDING", tone: "info" },
  CONTRACTED: { labelKey: "invoices.state.CONTRACTED", tone: "info" },
  READY_FOR_DISBURSEMENT: { labelKey: "invoices.state.READY_FOR_DISBURSEMENT", tone: "info" },
  FUNDING_CONFIRMATION_PENDING: {
    labelKey: "invoices.state.FUNDING_CONFIRMATION_PENDING",
    tone: "info",
  },
  FUNDED: { labelKey: "invoices.state.FUNDED", tone: "success" },
  PARTIALLY_PAID: { labelKey: "invoices.state.PARTIALLY_PAID", tone: "info" },
  PAID: { labelKey: "invoices.state.PAID", tone: "success" },
  OVERDUE_UNCONFIRMED: { labelKey: "invoices.state.OVERDUE_UNCONFIRMED", tone: "neutral" },
  OVERDUE: { labelKey: "invoices.state.OVERDUE", tone: "warning" },
  RECOURSE_ACTIVE: { labelKey: "invoices.state.RECOURSE_ACTIVE", tone: "warning" },
  DISPUTED: { labelKey: "invoices.state.DISPUTED", tone: "warning" },
  FRAUD_REVIEW: { labelKey: "invoices.state.FRAUD_REVIEW", tone: "info" },
  CLOSED: { labelKey: "invoices.state.CLOSED", tone: "neutral" },
  REJECTED: { labelKey: "invoices.state.REJECTED", tone: "danger" },
  CANCELLED: { labelKey: "invoices.state.CANCELLED", tone: "neutral" },
};

const UNKNOWN: StatePresentation = { labelKey: "invoices.state.UNKNOWN", tone: "neutral" };

export function transactionStateLabelKey(state: string | undefined): string {
  return (STATES[state as TransactionState] ?? UNKNOWN).labelKey;
}

export function transactionStateTone(state: string | undefined): BadgeTone {
  return (STATES[state as TransactionState] ?? UNKNOWN).tone;
}

/** States in which the transaction is still the supplier's to edit. */
export function isEditable(state: string | undefined): boolean {
  return state === "DRAFT";
}

/** States from which a verification run exists to show. */
export function hasVerificationRun(state: string | undefined): boolean {
  return state !== undefined && state !== "DRAFT" && state !== "CANCELLED";
}
