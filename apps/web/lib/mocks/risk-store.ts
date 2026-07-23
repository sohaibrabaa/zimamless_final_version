/**
 * Assembles `RiskInputs` for a mock transaction and runs them through the
 * pure engine (`lib/risk/risk-engine.ts`). This file is the only place that
 * reads `sourceAvailability` off the *supplier's onboarding application*
 * rather than the transaction itself — the government sources that matter
 * for the Trust Score are the ones consulted when the supplier's profile was
 * verified in Phase 2, not anything about this specific invoice.
 */

import { computeRiskAssessment, FULLY_AVAILABLE, type RiskInputs, type SourceAvailability } from "@/lib/risk/risk-engine";
import type { RiskAssessment } from "@/lib/risk/risk-presentation";
import { findApplicationByOrganization } from "./onboarding-store";
import { findTransaction, type MockTransaction } from "./transaction-store";
import { getStoredRiskMode } from "./risk-mode-store";

function sourceAvailabilityForOrganization(organizationId: string): SourceAvailability {
  const application = findApplicationByOrganization(organizationId);
  const requests = application?.governmentRequests;
  if (!requests || requests.length === 0) return FULLY_AVAILABLE;

  // A source never queried for this supplier is not the same as a source
  // that answered "unavailable" — but a demo score has to start somewhere,
  // and treating "not yet queried" as available (rather than penalising a
  // supplier for a lookup that simply hasn't run) is the safer default.
  const availableFor = (source: "CCD" | "ISTD" | "GAM") =>
    requests.find((r) => r.source === source)?.sourceAvailable !== false;

  return {
    ccdAvailable: availableFor("CCD"),
    istdAvailable: availableFor("ISTD"),
    gamAvailable: availableFor("GAM"),
  };
}

function tenorDaysFor(transaction: MockTransaction): number | null {
  const dueDate = transaction.invoice?.dueDate;
  if (!dueDate) return null;
  const due = new Date(`${dueDate}T00:00:00Z`).getTime();
  return Math.floor((due - Date.now()) / 86_400_000);
}

/**
 * Fingerprint collisions this org has triggered — a stand-in for a real
 * conduct history. The mock keeps no separate audit trail of blocked
 * attempts, so this is always 0; the parameter is kept so the call site
 * reads as "per organization" rather than "always zero" when A's real
 * conduct-history signal lands.
 */
function priorDuplicateFlagsFor(organizationId: string): number {
  // The parameter is deliberately unused for now — kept so the call site
  // reads as "per organization" rather than "always zero" when A's real
  // conduct-history signal lands.
  void organizationId;
  return 0;
}

export function riskForTransaction(id: string): RiskAssessment | undefined {
  const transaction = findTransaction(id);
  if (!transaction) return undefined;

  // Only a submitted transaction has a verification result to score against —
  // a DRAFT has nothing yet to assess.
  if (!transaction.submittedAt) return undefined;

  const mode = getStoredRiskMode();
  const inputs: RiskInputs = {
    buyerRegistryStatus: transaction.buyer?.registryStatus,
    verificationOverallResult: transaction.verification?.overallResult as RiskInputs["verificationOverallResult"],
    tenorDays: tenorDaysFor(transaction),
    priorDuplicateFlags: priorDuplicateFlagsFor(transaction.organizationId),
    sourceAvailability: sourceAvailabilityForOrganization(transaction.organizationId),
    mlUsed: mode === "ml",
    mlFallbackReason: mode === "rules-only" ? "ML_SERVICE_UNAVAILABLE" : undefined,
  };

  return computeRiskAssessment(inputs, new Date().toISOString());
}
