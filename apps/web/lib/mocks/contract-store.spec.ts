import { describe, it, expect, beforeEach } from "vitest";
import { acceptOffer, activateListing, approveOffer, createOffer, currentListingForTransaction, resetMarketplaceMocks } from "./marketplace-store";
import { resetPolicyFilterMocks } from "./policy-filter-store";
import {
  createDocument,
  linkBuyer,
  createTransaction,
  resetTransactionMocks,
  setDeclarations,
  setInvoice,
  setMinimumAmount,
  submitTransaction,
  findTransaction,
} from "./transaction-store";
import { mockBuyers, ORG } from "./data";
import type { ConditionType } from "@/lib/marketplace/offer-domain";
import { findApplicationByOrganization, recordBankAccount } from "./onboarding-store";
import {
  conditionsForTransaction,
  findContractById,
  findContractForTransaction,
  fulfilCondition,
  generateContract,
  resetContractMocks,
  signContract,
} from "./contract-store";

/** ZM-CON-006's fourth check — Al-Noor's Phase 2 fixture carries no bank account until one is recorded. */
function verifyBankAccount(orgId: string) {
  const application = findApplicationByOrganization(orgId);
  if (!application?.id) throw new Error("expected a seeded onboarding application");
  recordBankAccount(application.id, { iban: "JO00TEST0000000000000000", bankName: "Test Bank", accountHolderName: "Al-Noor Trading Company" });
}

function submittedTransaction(orgId: string, minimumAmount = "500.000") {
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
  setMinimumAmount(id, minimumAmount);
  setDeclarations(id, "1.0");
  submitTransaction(id);
  return id;
}

function acceptedTransaction(
  conditions: { conditionType?: ConditionType; title?: string; isMandatory?: boolean }[] = []
) {
  verifyBankAccount(ORG.alnoor);
  const id = submittedTransaction(ORG.alnoor);
  activateListing(id);
  const listing = currentListingForTransaction(id)!;
  const created = createOffer(listing.id, ORG.lcb, "user-maker-1", "Maker One", {
    transactionType: "INVOICE_FINANCING",
    recourseType: "FULL_RECOURSE",
    grossFundingAmount: "1000.000",
    validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    conditions,
  });
  if (!created.ok) throw new Error("expected offer creation to succeed");
  approveOffer(created.offer.id, ORG.lcb, "user-approver-1");
  const accepted = acceptOffer(created.offer.id, ORG.alnoor, "user-owner-1", `key-${id}`);
  if (!accepted.ok) throw new Error("expected acceptance to succeed");
  return id;
}

beforeEach(() => {
  resetTransactionMocks();
  resetMarketplaceMocks();
  resetPolicyFilterMocks();
  resetContractMocks();
});

describe("generateContract (ZM-CON-001..006)", () => {
  it("refuses generation before any offer has been accepted", () => {
    const id = submittedTransaction(ORG.alnoor);
    expect(generateContract(id)).toEqual({ ok: false, error: "NOT_ACCEPTED" });
  });

  it("generates once the pre-contract checks all pass (no conditions, declarations + bank account already set)", () => {
    const id = acceptedTransaction([]);
    const result = generateContract(id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contract.transactionId).toBe(id);
    expect(result.contract.status).toBe("PENDING_SIGNATURES");
    expect(result.contract.templateVersion).toBe("1.0");
    expect(result.contract.canonicalLanguage).toBe("EN");
    expect(result.contract.documentHash).toMatch(/^sha-mock-/);
  });

  it("refuses generation while a mandatory condition is unresolved", () => {
    const id = acceptedTransaction([
      { conditionType: "REQUIRED_DOCUMENT", title: "Signed guarantee", isMandatory: true },
    ]);
    const result = generateContract(id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("PRE_CONTRACT_CHECK_FAILED");
    if (result.error === "PRE_CONTRACT_CHECK_FAILED") {
      expect(result.failures).toContain("CONDITIONS_UNFULFILLED");
    }
  });

  it("generates once the mandatory condition is fulfilled", () => {
    const id = acceptedTransaction([
      { conditionType: "REQUIRED_DOCUMENT", title: "Signed guarantee", isMandatory: true },
    ]);
    const [condition] = conditionsForTransaction(id);
    fulfilCondition(condition.id, ["doc-1"], "attached");
    expect(generateContract(id).ok).toBe(true);
  });

  it("is idempotent — a second call returns the existing contract rather than creating a duplicate", () => {
    const id = acceptedTransaction([]);
    const first = generateContract(id);
    const second = generateContract(id);
    expect(first).toEqual(second);
  });
});

describe("signContract (ZM-CON-008..012)", () => {
  it("becomes FULLY_SIGNED only once both a supplier and a bank signature are recorded, and sets the transaction CONTRACTED", () => {
    const id = acceptedTransaction([]);
    const generated = generateContract(id);
    if (!generated.ok) throw new Error("expected generation to succeed");

    const afterSupplier = signContract(generated.contract.id, "SUPPLIER", "Rania Haddad", "Owner", true);
    expect(afterSupplier.ok).toBe(true);
    if (afterSupplier.ok) expect(afterSupplier.contract.status).toBe("PENDING_SIGNATURES");
    expect(findTransaction(id)!.state).not.toBe("CONTRACTED");

    const afterBank = signContract(generated.contract.id, "BANK", "Huda Salameh", "Maker", true);
    expect(afterBank.ok).toBe(true);
    if (afterBank.ok) {
      expect(afterBank.contract.status).toBe("FULLY_SIGNED");
      expect(afterBank.contract.fullySignedAt).toBeTruthy();
    }
    expect(findTransaction(id)!.state).toBe("CONTRACTED");
  });

  it("refuses a second signature from the same side", () => {
    const id = acceptedTransaction([]);
    const generated = generateContract(id);
    if (!generated.ok) throw new Error("expected generation to succeed");
    signContract(generated.contract.id, "SUPPLIER", "Rania Haddad", "Owner", true);
    const again = signContract(generated.contract.id, "SUPPLIER", "Omar Khalil", "Uploader", true);
    expect(again).toEqual({ ok: false, error: "ALREADY_SIGNED" });
  });

  it("does not record a signature when accepted is false", () => {
    const id = acceptedTransaction([]);
    const generated = generateContract(id);
    if (!generated.ok) throw new Error("expected generation to succeed");
    const declined = signContract(generated.contract.id, "SUPPLIER", "Rania Haddad", "Owner", false);
    expect(declined).toEqual({ ok: false, error: "DECLINED" });
    expect(findContractById(generated.contract.id)!.signatures).toHaveLength(0);
  });
});

describe("fulfilCondition", () => {
  it("marks the condition fulfilled and records evidence", () => {
    const id = acceptedTransaction([{ conditionType: "REQUIRED_DOCUMENT", title: "Guarantee", isMandatory: true }]);
    const [condition] = conditionsForTransaction(id);
    expect(fulfilCondition(condition.id, ["doc-9"], "attached the guarantee")).toEqual({ ok: true });
    const [updated] = conditionsForTransaction(id);
    expect(updated.fulfilment).toBe("FULFILLED");
    expect(updated.evidenceDocumentIds).toEqual(["doc-9"]);
  });

  it("returns NOT_FOUND for an unknown condition id", () => {
    expect(fulfilCondition("no-such-condition", [], undefined)).toEqual({ ok: false, error: "NOT_FOUND" });
  });
});

describe("findContractForTransaction", () => {
  it("is undefined before generation", () => {
    const id = submittedTransaction(ORG.alnoor);
    expect(findContractForTransaction(id)).toBeUndefined();
  });
});
