import type { components } from "@/lib/api/generated/schema";
import type { BadgeTone } from "@/components/ui/Badge";

export type Buyer = components["schemas"]["Buyer"];
export type BuyerCandidate = components["schemas"]["BuyerCandidate"];
export type BuyerContactInput = components["schemas"]["BuyerContactInput"];

export type BuyerRegistryStatus = NonNullable<Buyer["registryStatus"]>;

/**
 * What a registry status means for selecting this buyer.
 *
 *   selectable    — proceed normally
 *   manualReview  — selectable, but the submission routes to review first
 *   blocked       — the platform refuses; `/buyers/resolve` returns 409
 *
 * The mapping is Agent A's (phase file, A tasks): 409 on SUSPENDED and
 * STRUCK_OFF; UNDER_LIQUIDATION goes to manual review per the LT-02 policy
 * rather than being refused outright. UNKNOWN means the registry did not tell
 * us — which is not the same as telling us something bad, so it reviews rather
 * than blocks, the same ZM-GOV-008 distinction the onboarding screens make.
 */
export type BuyerSelectability = "selectable" | "manualReview" | "blocked";

interface StatusPresentation {
  selectability: BuyerSelectability;
  labelKey: string;
  tone: BadgeTone;
  /** Why this buyer cannot be used, or what happens next. Blank for ACTIVE. */
  explanationKey?: string;
}

const STATUSES: Record<BuyerRegistryStatus, StatusPresentation> = {
  ACTIVE: {
    selectability: "selectable",
    labelKey: "invoices.buyer.status.ACTIVE",
    tone: "success",
  },
  SUSPENDED: {
    selectability: "blocked",
    labelKey: "invoices.buyer.status.SUSPENDED",
    tone: "neutral",
    explanationKey: "invoices.buyer.blocked.SUSPENDED",
  },
  STRUCK_OFF: {
    selectability: "blocked",
    labelKey: "invoices.buyer.status.STRUCK_OFF",
    tone: "neutral",
    explanationKey: "invoices.buyer.blocked.STRUCK_OFF",
  },
  UNDER_LIQUIDATION: {
    selectability: "manualReview",
    labelKey: "invoices.buyer.status.UNDER_LIQUIDATION",
    tone: "neutral",
    explanationKey: "invoices.buyer.review.UNDER_LIQUIDATION",
  },
  UNKNOWN: {
    selectability: "manualReview",
    labelKey: "invoices.buyer.status.UNKNOWN",
    tone: "neutral",
    explanationKey: "invoices.buyer.review.UNKNOWN",
  },
};

const UNRECOGNIZED: StatusPresentation = {
  // A status this client does not know about is not evidence of anything.
  // Route it to review rather than guessing in either direction.
  selectability: "manualReview",
  labelKey: "invoices.buyer.status.UNKNOWN",
  tone: "neutral",
  explanationKey: "invoices.buyer.review.UNKNOWN",
};

function presentation(status: string | undefined): StatusPresentation {
  return STATUSES[status as BuyerRegistryStatus] ?? UNRECOGNIZED;
}

export function buyerSelectability(status: string | undefined): BuyerSelectability {
  return presentation(status).selectability;
}

export function buyerStatusLabelKey(status: string | undefined): string {
  return presentation(status).labelKey;
}

/**
 * Tone for a registry status badge.
 *
 * Note that no blocked status is `danger`. A suspended or struck-off buyer is
 * a **fact about the buyer's registry record**, not a finding against the
 * supplier who is trying to invoice them — the same neutral-tone discipline
 * `GOVERNMENT_SERVICE_UNAVAILABLE` gets in Phase 2. Colouring these red would
 * read as an accusation aimed at the wrong party.
 */
export function buyerStatusTone(status: string | undefined): BadgeTone {
  return presentation(status).tone;
}

export function buyerStatusExplanationKey(status: string | undefined): string | undefined {
  return presentation(status).explanationKey;
}

export function isBuyerBlocked(status: string | undefined): boolean {
  return buyerSelectability(status) === "blocked";
}

/**
 * ZM-BUY-009: the platform MUST NOT auto-select a buyer on name similarity,
 * "under any circumstances". This helper exists so that rule is expressed once
 * and tested once, rather than being an absence in the component that a later
 * "helpful" edit could quietly fill in.
 *
 * It always returns null. A single exact-match candidate is the case most
 * likely to tempt an auto-selection, and it is precisely the case the
 * requirement names.
 */
export function initialBuyerSelection(candidates: readonly BuyerCandidate[]): null {
  // The candidates are deliberately not inspected. Reading them at all would
  // be the first step toward ranking them.
  void candidates;
  return null;
}

/** ZM-BUY-011: contact data is supplier-provided, never the registry's contact. */
export function contactIsComplete(contact: Partial<BuyerContactInput>): boolean {
  return (
    (contact.contactName ?? "").trim() !== "" &&
    (contact.contactRole ?? "").trim() !== "" &&
    (contact.contactPhone ?? "").trim() !== ""
  );
}
