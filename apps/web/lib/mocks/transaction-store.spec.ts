import { describe, it, expect, beforeEach } from "vitest";
import {
  DUPLICATE_FIXTURE,
  INVOICE_FIXTURE,
  MISMATCH_FIXTURE,
  MISMATCH_QR_FACE_VALUE_FIXTURE,
  createDocument,
  createTransaction,
  extractionForDocument,
  fingerprint,
  linkBuyer,
  listTransactions,
  profileForFileName,
  resetTransactionMocks,
  resolveBuyer,
  searchBuyers,
  seedDuplicateCounterpart,
  setDeclarations,
  setInvoice,
  setMinimumAmount,
  submitTransaction,
  type MockTransaction,
} from "./transaction-store";
import { mockBuyers, ORG } from "./data";

/**
 * The Phase 3 checkpoint reproduced against mocks.
 *
 * This is the client-side statement of what the live checkpoint must show:
 * search → resolve → upload → extract → correct → floor → declare → submit →
 * ELIGIBLE, and the same invoice from a second supplier blocked by
 * fingerprint. It is not evidence the checkpoint passed — the endpoints are
 * still `mock` — but it is what makes the sequence drivable and regressions
 * visible before Agent A's half lands.
 */

const B1 = mockBuyers[0]; // Amman Retail Group, ACTIVE
const B4 = mockBuyers[3]; // Northern Textiles, SUSPENDED
const B6 = mockBuyers[5]; // Capital Medical Supplies, UNDER_LIQUIDATION

beforeEach(() => {
  resetTransactionMocks();
});

function completeDraft(
  orgId: string,
  overrides: Record<string, string> = {},
  floor = "11000.000",
): MockTransaction {
  const transaction = createTransaction(orgId);
  const id = transaction.id!;
  linkBuyer(id, B1.id);
  createDocument({
    documentType: "EINVOICE",
    fileName: "einvoice.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1024,
    subjectId: id,
  });
  setInvoice(id, { ...INVOICE_FIXTURE, ...overrides });
  setMinimumAmount(id, floor);
  setDeclarations(id, "1.0");
  return transaction;
}

describe("buyer search and resolution", () => {
  it("returns candidates without selecting one, even for an exact single match", () => {
    const result = searchBuyers("Amman Retail Group");
    expect(result.candidates.length).toBe(1);
    // There is deliberately no `selected` field for a UI to read.
    expect(result).not.toHaveProperty("selected");
    expect(result.requiresManualReview).toBe(false);
  });

  it("flags ambiguity when more than one record matches (ZM-BUY-010)", () => {
    const result = searchBuyers("30000");
    expect(result.candidates.length).toBeGreaterThan(1);
    expect(result.requiresManualReview).toBe(true);
  });

  it("refuses SUSPENDED and STRUCK_OFF, and accepts UNDER_LIQUIDATION", () => {
    expect(resolveBuyer(ORG.alnoor, B4.nationalEstablishmentNo).ok).toBe(false);
    expect(resolveBuyer(ORG.alnoor, mockBuyers[4].nationalEstablishmentNo).ok).toBe(false);
    // LT-02: liquidation is a manual-review path, not a refusal.
    expect(resolveBuyer(ORG.alnoor, B6.nationalEstablishmentNo).ok).toBe(true);
  });

  it("stores contact data against the relationship, never on the buyer", () => {
    const contact = { contactName: "Rami", contactRole: "Finance", contactPhone: "+962790000000" };
    const result = resolveBuyer(ORG.alnoor, B1.nationalEstablishmentNo, contact);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // ZM-BUY-005/008: the global Buyer record carries no contact fields.
      expect(result.buyer).not.toHaveProperty("contactName");
      expect(result.buyer).not.toHaveProperty("contactPhone");
    }
  });
});

describe("extraction profiles", () => {
  it("selects the seeded mismatch profile by file name", () => {
    expect(profileForFileName("einvoice-mismatch.pdf")).toBe("MISMATCH");
    expect(profileForFileName("einvoice-unparsed.pdf")).toBe("UNPARSED_QR");
    expect(profileForFileName("einvoice.pdf")).toBe("CLEAN");
  });

  it("keeps the OCR and QR readings separate on the mismatch fixture", () => {
    const doc = createDocument({
      documentType: "EINVOICE",
      fileName: "seeded-mismatch.pdf",
      mimeType: "application/pdf",
      sizeBytes: 2048,
    });
    const extraction = extractionForDocument(doc.id)!;
    // The deliberate discrepancy the phase file calls for, matching the real
    // seeded `INV-2026-0002-alnoor-levant-mismatch.pdf`: the page prints
    // 24500.000 and the QR carries 25000.000, so the two machine readings
    // disagree with each other and correcting one cannot silently satisfy
    // both.
    expect(extraction.ocr?.extractedFields?.faceValue).toBe(MISMATCH_FIXTURE.faceValue);
    expect(extraction.qr?.extractedFields?.faceValue).toBe(MISMATCH_QR_FACE_VALUE_FIXTURE);
    expect(extraction.mismatches?.length).toBeGreaterThan(0);
    // rawOutput is preserved separately from extractedFields (ZM-DOC-006).
    expect(extraction.ocr?.rawOutput).toBeDefined();
    expect(extraction.ocr?.rawOutput).not.toEqual(extraction.ocr?.extractedFields);
  });

  it("reports an unreadable QR as UNPARSED with nothing taken from it", () => {
    const doc = createDocument({
      documentType: "EINVOICE",
      fileName: "unparsed-qr.pdf",
      mimeType: "application/pdf",
      sizeBytes: 2048,
    });
    const extraction = extractionForDocument(doc.id)!;
    expect(extraction.qr?.validationStatus).toBe("UNPARSED");
    expect(extraction.qr?.parsed).toBe(false);
    expect(extraction.qr?.extractedFields).toEqual({});
  });

  it("produces no extraction for a non-e-invoice document", () => {
    const doc = createDocument({
      documentType: "DELIVERY_NOTE",
      fileName: "note.pdf",
      mimeType: "application/pdf",
      sizeBytes: 100,
    });
    expect(extractionForDocument(doc.id)).toBeUndefined();
  });
});

describe("invoice and floor", () => {
  it("recomputes the outstanding amount server-side rather than trusting the client", () => {
    const transaction = createTransaction(ORG.alnoor);
    setInvoice(transaction.id!, {
      invoiceNumber: "X",
      einvoiceIdentifier: "Y",
      issueDate: "2026-06-01",
      dueDate: "2026-09-01",
      subtotalAmount: "1000.000",
      taxAmount: "160.000",
      faceValue: "1160.000",
      paidAmount: "160.000",
    });
    expect(transaction.outstandingAmount).toBe("1000.000");
  });

  it("refuses a floor above the outstanding amount, and a non-positive one", () => {
    const transaction = completeDraft(ORG.alnoor);
    const id = transaction.id!;
    expect(setMinimumAmount(id, "99999.000")).toEqual({
      ok: false,
      error: "EXCEEDS_OUTSTANDING",
    });
    expect(setMinimumAmount(id, "0.000")).toEqual({ ok: false, error: "NOT_POSITIVE" });
    // Exactly the outstanding amount is permitted — the floor is a minimum
    // the supplier will accept, and accepting nothing less than face value
    // is a legitimate (if unlikely to be filled) position.
    expect(setMinimumAmount(id, INVOICE_FIXTURE.faceValue).ok).toBe(true);
  });
});

describe("submission and fingerprint uniqueness (ZM-VER-001)", () => {
  it("refuses an incomplete draft, naming what is missing", () => {
    const transaction = createTransaction(ORG.alnoor);
    const result = submitTransaction(transaction.id!);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error === "INCOMPLETE") {
      expect(result.missing).toContain("buyer");
      expect(result.missing).toContain("invoice");
      expect(result.missing).toContain("einvoice");
    }
  });

  it("reaches ELIGIBLE when every check passes", () => {
    const transaction = completeDraft(ORG.alnoor);
    const result = submitTransaction(transaction.id!);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transaction.state).toBe("ELIGIBLE");
      expect(result.transaction.verification?.overallResult).toBe("PASS");
      expect(result.transaction.verification?.checks?.length).toBe(8);
    }
  });

  it("blocks the same invoice submitted by a second supplier, with a review reference", () => {
    // The checkpoint case, and the seeded `INV-2026-0003` pair: the
    // fingerprint is platform-wide, so the *supplier* is deliberately not
    // part of it. Petra submits first; Al-Noor is blocked. The server half
    // keyed on the supplier until the Phase 3 audit, which would have let
    // this exact submission through.
    seedDuplicateCounterpart();
    const alnoor = completeDraft(ORG.alnoor, { ...DUPLICATE_FIXTURE }, "5000.000");
    const result = submitTransaction(alnoor.id!);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error === "DUPLICATE") {
      expect(result.reviewReference).toMatch(/^ZM-DUP-/);
    } else {
      throw new Error("expected a duplicate block");
    }
    // Blocked, not rejected: the draft and everything in it survives.
    expect(alnoor.state).toBe("DRAFT");
    expect(alnoor.invoice).toBeDefined();
    expect(alnoor.minimumAcceptableAmount).toBe("5000.000");
  });

  it("does not collide when any fingerprint component differs", () => {
    seedDuplicateCounterpart();
    // The happy-path invoice is a different receivable entirely.
    const alnoor = completeDraft(ORG.alnoor);
    expect(submitTransaction(alnoor.id!).ok).toBe(true);
  });

  it("keys the fingerprint on parties, number, date, value and tax (D-01)", () => {
    const a = completeDraft(ORG.alnoor);
    const b = completeDraft(ORG.petra);
    // Same invoice, different suppliers → identical fingerprint. That equality
    // is the check; if the supplier were part of the key it would be false and
    // the duplicate rule would silently never fire.
    expect(fingerprint(a)).toBe(fingerprint(b));
    expect(fingerprint(createTransaction(ORG.alnoor))).toBeNull();
  });

  it("refuses to submit a transaction that is no longer a draft", () => {
    const transaction = completeDraft(ORG.alnoor);
    expect(submitTransaction(transaction.id!).ok).toBe(true);
    expect(submitTransaction(transaction.id!)).toEqual({
      ok: false,
      error: "INVALID_STATE_TRANSITION",
    });
  });
});

describe("verification reflects the transaction rather than a canned list", () => {
  it("flags an OCR discrepancy as REVIEW and clears it when corrected", () => {
    const transaction = createTransaction(ORG.alnoor);
    const id = transaction.id!;
    linkBuyer(id, B1.id);
    createDocument({
      documentType: "EINVOICE",
      fileName: "seeded-mismatch.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1024,
      subjectId: id,
    });
    // The supplier confirms the printed figure OCR read (24500.000); the QR,
    // which carries 25000.000, still disagrees.
    setInvoice(id, { ...MISMATCH_FIXTURE });
    setMinimumAmount(id, "20000.000");
    setDeclarations(id, "1.0");

    const result = submitTransaction(id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const checks = result.transaction.verification!.checks!;
    expect(checks.find((c) => c.checkType === "OCR_CONSISTENCY")!.result).toBe("PASS");
    expect(checks.find((c) => c.checkType === "QR_CONSISTENCY")!.result).toBe("REVIEW");
    expect(result.transaction.state).toBe("UNDER_REVIEW");
  });

  it("records an unreadable QR as UNPARSED, not FAIL (ZM-DOC-010)", () => {
    const transaction = createTransaction(ORG.alnoor);
    const id = transaction.id!;
    linkBuyer(id, B1.id);
    createDocument({
      documentType: "EINVOICE",
      fileName: "unparsed-qr.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1024,
      subjectId: id,
    });
    setInvoice(id, { ...INVOICE_FIXTURE, invoiceNumber: "INV-2026-0099" });
    setMinimumAmount(id, "11000.000");
    setDeclarations(id, "1.0");

    const result = submitTransaction(id);
    if (!result.ok) throw new Error("expected submission to proceed");
    const qr = result.transaction.verification!.checks!.find((c) => c.checkType === "QR_CONSISTENCY");
    expect(qr!.result).toBe("UNPARSED");
    // An unreadable payload routes to review; it is never a failure.
    expect(result.transaction.verification!.overallResult).not.toBe("FAIL");
  });

  it("routes a non-ACTIVE buyer to review rather than passing eligibility", () => {
    const transaction = createTransaction(ORG.alnoor);
    const id = transaction.id!;
    linkBuyer(id, B6.id); // UNDER_LIQUIDATION
    createDocument({
      documentType: "EINVOICE",
      fileName: "einvoice.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1024,
      subjectId: id,
    });
    setInvoice(id, { ...INVOICE_FIXTURE, invoiceNumber: "INV-2026-0100" });
    setMinimumAmount(id, "11000.000");
    setDeclarations(id, "1.0");

    const result = submitTransaction(id);
    if (!result.ok) throw new Error("expected submission to proceed");
    const eligibility = result.transaction.verification!.checks!.find(
      (c) => c.checkType === "ELIGIBILITY"
    );
    expect(eligibility!.result).toBe("REVIEW");
  });
});

describe("transaction listing is scoped to the active organization", () => {
  it("does not leak another supplier's transactions", () => {
    completeDraft(ORG.alnoor);
    completeDraft(ORG.petra);
    expect(listTransactions(ORG.alnoor).length).toBe(1);
    expect(listTransactions(ORG.petra).length).toBe(1);
    expect(listTransactions(null).length).toBe(2);
  });
});
