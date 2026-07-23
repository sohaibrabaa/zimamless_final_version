import { describe, it, expect } from "vitest";
import {
  buyerSelectability,
  buyerStatusTone,
  contactIsComplete,
  initialBuyerSelection,
  isBuyerBlocked,
  type BuyerCandidate,
} from "./buyer-rules";
import {
  COMPARABLE_FIELDS,
  compareFields,
  hasMismatches,
  prefillFromExtraction,
  qrStatusTone,
  suggestedValue,
  type Extraction,
} from "./extraction";
import {
  DECLARATIONS,
  allDeclarationsAffirmed,
  buildDeclarationBody,
  type DeclarationKey,
} from "./declarations";
import { readDuplicateBlock } from "./duplicate";
import { CHECK_TYPES, checkResultTone, orderedChecks, overallResultTone } from "./verification";
import { rejectFile, MAX_FILE_SIZE_BYTES } from "./documents";
import { transactionStateLabelKey, transactionStateTone } from "./transaction-status";
import { ApiError } from "@/lib/api/client";

// ---------------------------------------------------------------------------
// ZM-BUY-009 — the platform never auto-selects a buyer
// ---------------------------------------------------------------------------

describe("buyer selection never happens automatically (ZM-BUY-009)", () => {
  const exactMatch: BuyerCandidate = {
    nationalEstablishmentNumber: "30000201",
    legalCompanyName: "Amman Retail Group",
    registryStatus: "ACTIVE",
    governorate: "Amman",
  };

  it("returns no selection for a single 100% name match", () => {
    // The requirement says "under any circumstances", and this is the
    // circumstance most likely to tempt an exception: one candidate, exact
    // name, active registry status, nothing ambiguous about it.
    expect(initialBuyerSelection([exactMatch])).toBeNull();
  });

  it("returns no selection for an empty or multi-candidate list either", () => {
    expect(initialBuyerSelection([])).toBeNull();
    expect(initialBuyerSelection([exactMatch, { ...exactMatch, nationalEstablishmentNumber: "30000202" }])).toBeNull();
  });
});

describe("buyer registry status drives selectability, not tone", () => {
  it("blocks SUSPENDED and STRUCK_OFF only", () => {
    expect(buyerSelectability("SUSPENDED")).toBe("blocked");
    expect(buyerSelectability("STRUCK_OFF")).toBe("blocked");
    expect(isBuyerBlocked("SUSPENDED")).toBe(true);
    expect(isBuyerBlocked("STRUCK_OFF")).toBe(true);
  });

  it("routes UNDER_LIQUIDATION to manual review rather than refusing it (LT-02)", () => {
    // Agent A's half returns 409 for two statuses, not three. If this ever
    // becomes "blocked", the UI refuses a buyer the live API accepts.
    expect(buyerSelectability("UNDER_LIQUIDATION")).toBe("manualReview");
    expect(isBuyerBlocked("UNDER_LIQUIDATION")).toBe(false);
  });

  it("treats an unknown or unrecognised status as review, never as blocked", () => {
    expect(buyerSelectability("UNKNOWN")).toBe("manualReview");
    expect(buyerSelectability("SOMETHING_NEW")).toBe("manualReview");
    expect(buyerSelectability(undefined)).toBe("manualReview");
  });

  it("never colours a blocked buyer as danger", () => {
    // A suspended buyer is a fact about the buyer's registry record, not a
    // finding against the supplier trying to invoice them — the same
    // neutral-tone discipline GOVERNMENT_SERVICE_UNAVAILABLE gets.
    for (const status of ["SUSPENDED", "STRUCK_OFF", "UNDER_LIQUIDATION", "UNKNOWN"]) {
      expect(buyerStatusTone(status), status).not.toBe("danger");
      expect(buyerStatusTone(status), status).not.toBe("warning");
    }
  });

  it("requires name, role and phone for a contact, email optional (ZM-BUY-011)", () => {
    expect(contactIsComplete({ contactName: "A", contactRole: "B", contactPhone: "C" })).toBe(true);
    expect(contactIsComplete({ contactName: "A", contactRole: "B" })).toBe(false);
    expect(contactIsComplete({ contactName: " ", contactRole: "B", contactPhone: "C" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ZM-DOC-006 — raw extraction and supplier corrections stay independent
// ---------------------------------------------------------------------------

const mismatchExtraction: Extraction = {
  documentId: "doc-1",
  ocr: {
    rawOutput: { engine: "test", pages: 1 },
    extractedFields: { invoiceNumber: "INV-1", taxAmount: "2000.000", faceValue: "14500.000" },
    confidence: 0.8,
  },
  qr: {
    parsed: true,
    extractedFields: { invoiceNumber: "INV-1", taxAmount: "2100.000", faceValue: "14600.000" },
    validationStatus: "VALID",
  },
};

describe("extraction and correction are independent (ZM-DOC-006)", () => {
  it("a supplier correction does not mutate the extraction it disagrees with", () => {
    const entered = { taxAmount: "2050.000" };
    const before = JSON.stringify(mismatchExtraction);
    const comparisons = compareFields(mismatchExtraction, entered);
    // Both machine readings survive the comparison and are still retrievable
    // beside the supplier's value — that is the whole requirement.
    const tax = comparisons.find((c) => c.field === "taxAmount")!;
    expect(tax.ocrValue).toBe("2000.000");
    expect(tax.qrValue).toBe("2100.000");
    expect(tax.userValue).toBe("2050.000");
    expect(tax.mismatch).toBe(true);
    expect(JSON.stringify(mismatchExtraction)).toBe(before);
  });

  it("pre-fill never overwrites a value the supplier already typed", () => {
    const filled = prefillFromExtraction(mismatchExtraction, { taxAmount: "9999.000" });
    expect(filled.taxAmount).toBe("9999.000");
    expect(filled.invoiceNumber).toBe("INV-1");
  });

  it("prefers the QR payload over OCR when the QR parsed", () => {
    expect(suggestedValue(mismatchExtraction, "taxAmount")).toBe("2100.000");
  });

  it("does not trust an UNPARSED QR for pre-fill (ZM-DOC-010)", () => {
    const unparsed: Extraction = {
      ...mismatchExtraction,
      qr: { parsed: false, extractedFields: { taxAmount: "9.999" }, validationStatus: "UNPARSED" },
    };
    // Degrades to the OCR reading rather than guessing from a payload whose
    // format we did not recognise.
    expect(suggestedValue(unparsed, "taxAmount")).toBe("2000.000");
    const comparisons = compareFields(unparsed, { taxAmount: "2000.000" });
    expect(comparisons.find((c) => c.field === "taxAmount")!.qrValue).toBeNull();
  });

  it("an empty form field is not a mismatch", () => {
    // The supplier has not disagreed with anything yet; flagging this would
    // show a discrepancy warning on a form nobody has filled in.
    const comparisons = compareFields(mismatchExtraction, {});
    expect(hasMismatches(comparisons)).toBe(false);
  });

  it("matching either machine value clears the mismatch", () => {
    expect(hasMismatches(compareFields(mismatchExtraction, { taxAmount: "2100.000" }))).toBe(false);
    expect(hasMismatches(compareFields(mismatchExtraction, { taxAmount: "2000.000" }))).toBe(false);
  });

  it("omits fields no machine read rather than showing an empty comparison row", () => {
    const comparisons = compareFields(mismatchExtraction, { issueDate: "2026-06-15" });
    expect(comparisons.some((c) => c.field === "issueDate")).toBe(false);
  });

  it("degrades to no comparisons for a malformed or absent extraction", () => {
    expect(compareFields(null, { taxAmount: "1.000" })).toEqual([]);
    expect(compareFields(undefined, {})).toEqual([]);
    expect(compareFields({ ocr: { extractedFields: undefined } }, { taxAmount: "1.000" })).toEqual([]);
  });

  it("never renders a QR status other than VALID as adverse", () => {
    for (const status of ["INVALID", "UNAVAILABLE", "UNPARSED", undefined] as const) {
      expect(qrStatusTone(status)).toBe("neutral");
    }
    expect(qrStatusTone("VALID")).toBe("success");
  });

  it("covers every comparable field the invoice form collects", () => {
    expect(COMPARABLE_FIELDS).toContain("faceValue");
    expect(COMPARABLE_FIELDS).toContain("taxAmount");
    expect(COMPARABLE_FIELDS.length).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// ZM-INV-004 — all eight declarations, none inferable
// ---------------------------------------------------------------------------

const allTrue = Object.fromEntries(DECLARATIONS.map((d) => [d.key, true])) as Record<
  DeclarationKey,
  boolean
>;

describe("supplier declarations (ZM-INV-004)", () => {
  it("has exactly the eight affirmations the requirement lists", () => {
    expect(DECLARATIONS.length).toBe(8);
    expect(new Set(DECLARATIONS.map((d) => d.key)).size).toBe(8);
  });

  it("is incomplete until every one is affirmed", () => {
    expect(allDeclarationsAffirmed(allTrue)).toBe(true);
    for (const declaration of DECLARATIONS) {
      const oneMissing = { ...allTrue, [declaration.key]: false };
      expect(allDeclarationsAffirmed(oneMissing), declaration.key).toBe(false);
    }
  });

  it("refuses to build a body rather than recording an affirmation not made", () => {
    // The contract types each field as `enum: [true]`, so there is no shape
    // for a declined declaration. Coercing to false would record something
    // the supplier did not say.
    expect(() => buildDeclarationBody({ ...allTrue, isAuthentic: false })).toThrow();
    expect(buildDeclarationBody(allTrue).acceptsRecourse).toBe(true);
    expect(buildDeclarationBody(allTrue).declarationTemplateVersion).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// ZM-VER-001 / ZM-VER-002 — duplicate block and check-result framing
// ---------------------------------------------------------------------------

describe("duplicate-fingerprint refusal (ZM-VER-001)", () => {
  it("reads the review reference out of the 409 details", () => {
    const err = new ApiError(409, {
      code: "DUPLICATE_INVOICE",
      message: "Already submitted",
      details: { reviewReference: "ZM-DUP-501" },
      correlationId: "corr-1",
    });
    expect(readDuplicateBlock(err)).toEqual({
      reviewReference: "ZM-DUP-501",
      correlationId: "corr-1",
    });
  });

  it("degrades to a null reference rather than inventing one", () => {
    const err = new ApiError(409, { code: "DUPLICATE_INVOICE", message: "x", correlationId: "c" });
    expect(readDuplicateBlock(err)?.reviewReference).toBeNull();
  });

  it("does not treat a different 409 as a duplicate", () => {
    // INVALID_STATE_TRANSITION is also a 409. Rendering the duplicate screen
    // for it would tell the supplier something untrue about their invoice.
    const other = new ApiError(409, { code: "INVALID_STATE_TRANSITION", message: "x" });
    expect(readDuplicateBlock(other)).toBeNull();
    expect(readDuplicateBlock(new ApiError(422, { code: "DUPLICATE_INVOICE", message: "x" }))).toBeNull();
    expect(readDuplicateBlock(new Error("boom"))).toBeNull();
  });
});

describe("verification results are results, not verdicts (ZM-VER-002)", () => {
  it("does not colour REVIEW, MISSING or UNPARSED as adverse", () => {
    // A failed check routes to review and is not proven fraud. MISSING and
    // UNPARSED say the platform lacks something, not that the supplier erred.
    expect(checkResultTone("REVIEW")).toBe("info");
    expect(checkResultTone("MISSING")).toBe("neutral");
    expect(checkResultTone("UNPARSED")).toBe("neutral");
    expect(checkResultTone("NOT_APPLICABLE")).toBe("neutral");
    expect(overallResultTone("REVIEW")).toBe("info");
  });

  it("names all eight §8.5 check types, in the strings the server emits", () => {
    // Three of these are the server's short forms rather than §8.5's prose
    // row titles. This half transcribed the prose in Phase 3 and the
    // divergence survived to the audit, because `checkType` is a bare string
    // in the contract and neither spelling violated it.
    expect([...CHECK_TYPES]).toEqual([
      "COMPLETENESS",
      "IDENTITY_MATCH",
      "DUPLICATE",
      "LOGIC",
      "ELIGIBILITY",
      "FILE_INTEGRITY",
      "OCR_CONSISTENCY",
      "QR_CONSISTENCY",
    ]);
  });

  it("orders checks by the §8.5 table and keeps unrecognised ones", () => {
    const ordered = orderedChecks({
      checks: [
        { checkType: "QR_CONSISTENCY", result: "PASS" },
        { checkType: "SOMETHING_NEW", result: "PASS" },
        { checkType: "COMPLETENESS", result: "PASS" },
      ],
    });
    expect(ordered.map((c) => c.checkType)).toEqual([
      "COMPLETENESS",
      "QR_CONSISTENCY",
      "SOMETHING_NEW",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Transaction state presentation
// ---------------------------------------------------------------------------

describe("transaction state presentation", () => {
  it("reads OVERDUE_UNCONFIRMED as awaiting confirmation, never as default (hard rule 8)", () => {
    expect(transactionStateLabelKey("OVERDUE_UNCONFIRMED")).toBe(
      "invoices.state.OVERDUE_UNCONFIRMED"
    );
    expect(transactionStateTone("OVERDUE_UNCONFIRMED")).toBe("neutral");
  });

  it("does not colour review states as warnings", () => {
    // Being looked at is not an adverse fact about the supplier.
    expect(transactionStateTone("UNDER_REVIEW")).toBe("info");
    expect(transactionStateTone("FRAUD_REVIEW")).toBe("info");
  });

  it("falls back to a labelled unknown rather than rendering a raw enum", () => {
    expect(transactionStateLabelKey("SOMETHING_FROM_A_LATER_PHASE")).toBe("invoices.state.UNKNOWN");
    expect(transactionStateTone(undefined)).toBe("neutral");
  });
});

describe("document acceptance", () => {
  it("rejects a wrong MIME type and an oversized file", () => {
    expect(rejectFile({ type: "application/zip", size: 10 })).toBe("MIME_TYPE");
    expect(rejectFile({ type: "application/pdf", size: MAX_FILE_SIZE_BYTES + 1 })).toBe("TOO_LARGE");
    expect(rejectFile({ type: "application/pdf", size: 1000 })).toBeNull();
    expect(rejectFile({ type: "image/jpeg", size: 1000 })).toBeNull();
  });
});
