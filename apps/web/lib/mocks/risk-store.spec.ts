import { describe, it, expect, beforeEach } from "vitest";
import { riskForTransaction } from "./risk-store";
import { setStoredRiskMode } from "./risk-mode-store";
import {
  createDocument,
  createTransaction,
  linkBuyer,
  resetTransactionMocks,
  setDeclarations,
  setInvoice,
  setMinimumAmount,
  submitTransaction,
} from "./transaction-store";
import { mockBuyers, ORG } from "./data";

/**
 * Integration-level check that `riskForTransaction` — the function
 * `GET /transactions/{id}/risk`'s handler actually calls — wires the pure
 * engine correctly against real store state, not just against hand-built
 * `RiskInputs`. The engine's own invariants (INV-9, band mapping, ZM-RSK-007)
 * are `risk-engine.spec.ts`'s job; this file's job is "does the assembly
 * work", including reading the supplier's onboarding sourceAvailability.
 */

function submittedTransaction(orgId: string) {
  const transaction = createTransaction(orgId);
  const id = transaction.id!;
  linkBuyer(id, mockBuyers[0].id);
  createDocument({
    documentType: "ELECTRONIC_INVOICE",
    fileName: "einvoice.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1024,
    subjectId: id,
  });
  setInvoice(id, {
    invoiceNumber: "INV-2026-0001",
    einvoiceIdentifier: "JO-EINV-20000101-0001",
    issueDate: "2026-05-10",
    dueDate: "2026-08-10",
    subtotalAmount: "10650.000",
    taxAmount: "1704.000",
    faceValue: "12354.000",
  });
  setMinimumAmount(id, "11000.000");
  setDeclarations(id, "1.0");
  submitTransaction(id);
  return id;
}

beforeEach(() => {
  resetTransactionMocks();
  setStoredRiskMode("ml");
});

describe("riskForTransaction", () => {
  it("returns undefined for a transaction that has not been submitted", () => {
    const draft = createTransaction(ORG.alnoor);
    expect(riskForTransaction(draft.id!)).toBeUndefined();
  });

  it("returns undefined for an id that does not exist", () => {
    expect(riskForTransaction("no-such-id")).toBeUndefined();
  });

  it("scores a submitted transaction for Al-Noor (S1 — all government sources full)", () => {
    const id = submittedTransaction(ORG.alnoor);
    const risk = riskForTransaction(id);
    expect(risk).toBeDefined();
    // S1's onboarding fixture (lib/mocks/onboarding-store.ts) answers all
    // three sources, so dataAvailabilityPct should read 100 — this is the
    // cross-store wiring the unit-level engine tests can't exercise.
    expect(risk!.dataAvailabilityPct).toBe(100);
    expect(risk!.components).toBeDefined();
  });

  it("defaults to fully available when the organization has no onboarding application", () => {
    // A bank organization has no supplier onboarding record at all — the
    // fallback (treat as fully available rather than penalising a shape
    // that doesn't apply) has to hold here too, not just for a supplier
    // whose lookups simply haven't run yet.
    const id = submittedTransaction(ORG.jnb);
    const risk = riskForTransaction(id);
    expect(risk!.dataAvailabilityPct).toBe(100);
  });

  it("reads the dev-only risk-mode toggle for mlUsed / fallback", () => {
    const id = submittedTransaction(ORG.alnoor);

    setStoredRiskMode("ml");
    expect(riskForTransaction(id)!.mlUsed).toBe(true);
    expect(riskForTransaction(id)!.mlFallbackReason).toBeUndefined();

    setStoredRiskMode("rules-only");
    const degraded = riskForTransaction(id)!;
    expect(degraded.mlUsed).toBe(false);
    expect(degraded.mlFallbackReason).toBe("ML_SERVICE_UNAVAILABLE");
    // The ZM-RSK-017 property this test exists for: the degraded mode
    // changes the flag, not the score.
    expect(degraded.components).toEqual(riskForTransaction(id)!.components);
  });
});
