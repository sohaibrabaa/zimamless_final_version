import { describe, it, expect, beforeEach } from "vitest";
import {
  acceptOffer,
  activateListing,
  approveOffer,
  bankListingView,
  createOffer,
  currentListingForTransaction,
  findOffer,
  findSnapshotForTransaction,
  listEligibleListingsForBank,
  listOffersForBank,
  listOffersForListing,
  rejectAllOffers,
  resetMarketplaceMocks,
  reviseOffer,
  supplierListingView,
  withdrawOffer,
} from "./marketplace-store";
import { resetPolicyFilterMocks, updateFilter } from "./policy-filter-store";
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

const JNB_FILTER_ID = "0ef90000-0000-4000-8000-000000000001";

function submittedTransaction(orgId: string, minimumAmount = "5000.000") {
  const transaction = createTransaction(orgId);
  const id = transaction.id!;
  linkBuyer(id, mockBuyers[0].id);
  createDocument({
    documentType: "EINVOICE",
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

beforeEach(() => {
  resetTransactionMocks();
  resetMarketplaceMocks();
  resetPolicyFilterMocks();
});

describe("activateListing", () => {
  it("refuses a transaction that has not reached ELIGIBLE", () => {
    const draft = createTransaction(ORG.alnoor);
    const result = activateListing(draft.id!);
    expect(result).toEqual({ ok: false, error: "NOT_ELIGIBLE" });
  });

  it("refuses an id that does not exist", () => {
    expect(activateListing("no-such-id")).toEqual({ ok: false, error: "NOT_FOUND" });
  });

  it("activates an ELIGIBLE transaction, moving it to OPEN_FOR_OFFERS (ZM-MKT-004/006)", () => {
    const id = submittedTransaction(ORG.alnoor);
    const result = activateListing(id);
    expect(result.ok).toBe(true);
    expect(findTransaction(id)!.state).toBe("OPEN_FOR_OFFERS");
  });

  it("refuses a second activation while a listing is already open", () => {
    const id = submittedTransaction(ORG.alnoor);
    activateListing(id);
    expect(activateListing(id)).toEqual({ ok: false, error: "ALREADY_LISTED" });
  });

  it("ZM-MKT-003: persists an eligibility outcome and the rules applied for every active bank", () => {
    const id = submittedTransaction(ORG.alnoor);
    const result = activateListing(id);
    if (!result.ok) throw new Error("expected activation to succeed");
    expect(result.listing.eligibility[ORG.jnb]).toBeDefined();
    expect(result.listing.eligibility[ORG.lcb]).toBeDefined();
    expect(result.listing.eligibility[ORG.lcb].rulesApplied.length).toBeGreaterThan(0);
  });
});

describe("bank eligibility (ZM-MKT-001/002)", () => {
  it("a bank whose filter's minAmount exceeds the invoice is not eligible", () => {
    updateFilter(JNB_FILTER_ID, ORG.jnb, { minAmount: "999999.000" });
    const id = submittedTransaction(ORG.alnoor);
    activateListing(id);
    const listing = currentListingForTransaction(id)!;
    expect(bankListingView(listing.id, ORG.jnb)).toEqual({ ok: false, error: "NOT_ELIGIBLE" });
  });

  it("an eligible bank sees the listing in its feed and via direct lookup", () => {
    const id = submittedTransaction(ORG.alnoor);
    activateListing(id);
    const listing = currentListingForTransaction(id)!;

    const view = bankListingView(listing.id, ORG.lcb);
    expect(view.ok).toBe(true);

    const feed = listEligibleListingsForBank(ORG.lcb);
    expect(feed.some((l) => l.listingId === listing.id)).toBe(true);
  });

  it("BankListingView never carries the supplier's floor or the supplier-only offerCount", () => {
    const id = submittedTransaction(ORG.alnoor);
    activateListing(id);
    const listing = currentListingForTransaction(id)!;
    const result = bankListingView(listing.id, ORG.lcb);
    if (!result.ok) throw new Error("expected eligible");
    expect(result.view).not.toHaveProperty("minimumAcceptableAmount");
    expect(result.view).not.toHaveProperty("offerCount");
  });
});

describe("offer creation and the floor (ZM-MKT-012 / ZM-OFR-004..006)", () => {
  it("creates a PENDING_INTERNAL_APPROVAL offer when the net payout meets the floor", () => {
    const id = submittedTransaction(ORG.alnoor, "500.000");
    activateListing(id);
    const listing = currentListingForTransaction(id)!;

    const result = createOffer(listing.id, ORG.lcb, "user-maker-1", "Maker One", {
      transactionType: "INVOICE_FINANCING",
      recourseType: "FULL_RECOURSE",
      grossFundingAmount: "1000.000",
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.offer.status).toBe("PENDING_INTERNAL_APPROVAL");
  });

  it("rejects generically when net falls below the floor, revealing no number", () => {
    const id = submittedTransaction(ORG.alnoor, "10000.000");
    activateListing(id);
    const listing = currentListingForTransaction(id)!;

    // gross 1000 - ~15 commission - 150 listing fee ≈ net 835, well below a 10000 floor.
    const result = createOffer(listing.id, ORG.lcb, "user-maker-1", "Maker One", {
      transactionType: "INVOICE_FINANCING",
      recourseType: "FULL_RECOURSE",
      grossFundingAmount: "1000.000",
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(result).toEqual({ ok: false, error: "BELOW_FLOOR" });
    // The rejection carries nothing beyond the error code — no floor, no
    // shortfall, exactly the design note under ZM-MKT-012.
    expect(Object.keys(result)).toEqual(["ok", "error"]);
  });

  it("a bank may not create a second offer while a current one exists", () => {
    const id = submittedTransaction(ORG.alnoor, "500.000");
    activateListing(id);
    const listing = currentListingForTransaction(id)!;
    const input = {
      transactionType: "INVOICE_FINANCING" as const,
      recourseType: "FULL_RECOURSE" as const,
      grossFundingAmount: "1000.000",
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    };
    createOffer(listing.id, ORG.lcb, "user-maker-1", "Maker One", input);
    expect(createOffer(listing.id, ORG.lcb, "user-maker-1", "Maker One", input)).toEqual({
      ok: false,
      error: "ALREADY_HAS_OFFER",
    });
  });
});

describe("approval (ZM-ROL-002 / ZM-OFR-016)", () => {
  function createdOffer(orgId = ORG.lcb) {
    const id = submittedTransaction(ORG.alnoor, "500.000");
    activateListing(id);
    const listing = currentListingForTransaction(id)!;
    const result = createOffer(listing.id, orgId, "user-maker-1", "Maker One", {
      transactionType: "INVOICE_FINANCING",
      recourseType: "FULL_RECOURSE",
      grossFundingAmount: "1000.000",
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    });
    if (!result.ok) throw new Error("expected offer creation to succeed");
    return result.offer;
  }

  it("rejects self-approval", () => {
    const offer = createdOffer();
    expect(approveOffer(offer.id, ORG.lcb, "user-maker-1")).toEqual({
      ok: false,
      error: "SELF_APPROVAL_FORBIDDEN",
    });
    expect(findOffer(offer.id)!.status).toBe("PENDING_INTERNAL_APPROVAL");
  });

  it("approves when a different user acts", () => {
    const offer = createdOffer();
    const result = approveOffer(offer.id, ORG.lcb, "user-approver-1");
    expect(result).toEqual({ ok: true });
    expect(findOffer(offer.id)!.status).toBe("ACTIVE");
    expect(findOffer(offer.id)!.approvedByUserId).toBe("user-approver-1");
  });

  it("withdraws an offer with no penalty, pre-acceptance", () => {
    const offer = createdOffer();
    expect(withdrawOffer(offer.id, ORG.lcb)).toEqual({ ok: true });
    expect(findOffer(offer.id)!.status).toBe("WITHDRAWN");
  });

  it("revising an ACTIVE offer creates a new version and resets to pending approval, retaining the prior version's data immutably", () => {
    const offer = createdOffer();
    approveOffer(offer.id, ORG.lcb, "user-approver-1");

    const revised = reviseOffer(offer.id, ORG.lcb, "user-maker-1", "Maker One", {
      transactionType: "INVOICE_FINANCING",
      recourseType: "FULL_RECOURSE",
      grossFundingAmount: "1200.000",
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(revised.ok).toBe(true);
    if (!revised.ok) return;
    expect(revised.offer.versionNumber).toBe(2);
    expect(revised.offer.previousOfferId).toBe(offer.id);
    expect(revised.offer.status).toBe("PENDING_INTERNAL_APPROVAL");
    // The old id no longer resolves as a *current* offer — findOffer only
    // looks at current offers, and the old record moved to history.
    expect(findOffer(offer.id)).toBeUndefined();
  });
});

describe("confidentiality (ZM-MKT-011/013, ZM-OFR-013)", () => {
  it("a bank sees only its own offer on a listing, never another bank's", () => {
    const id = submittedTransaction(ORG.alnoor, "500.000");
    activateListing(id);
    const listing = currentListingForTransaction(id)!;
    const input = {
      transactionType: "INVOICE_FINANCING" as const,
      recourseType: "FULL_RECOURSE" as const,
      grossFundingAmount: "1000.000",
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    };
    createOffer(listing.id, ORG.lcb, "user-maker-lcb", "LCB Maker", input);
    createOffer(listing.id, ORG.jnb, "user-maker-jnb", "JNB Maker", input);

    const lcbView = listOffersForListing(listing.id, ORG.lcb, true);
    expect(lcbView).toHaveLength(1);
    expect(lcbView.every((o) => o.bankName === "Levant Commercial Bank")).toBe(true);

    const jnbView = listOffersForListing(listing.id, ORG.jnb, true);
    expect(jnbView).toHaveLength(1);
    expect(jnbView.every((o) => o.bankName === "Jordan National Bank")).toBe(true);
  });

  it("the supplier sees every ACTIVE offer in full, but never a PENDING one", () => {
    const id = submittedTransaction(ORG.alnoor, "500.000");
    activateListing(id);
    const listing = currentListingForTransaction(id)!;
    const input = {
      transactionType: "INVOICE_FINANCING" as const,
      recourseType: "FULL_RECOURSE" as const,
      grossFundingAmount: "1000.000",
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    };
    const lcbOffer = createOffer(listing.id, ORG.lcb, "user-maker-lcb", "LCB Maker", input);
    createOffer(listing.id, ORG.jnb, "user-maker-jnb", "JNB Maker", input); // left PENDING

    if (lcbOffer.ok) approveOffer(lcbOffer.offer.id, ORG.lcb, "user-approver-lcb");

    const supplierView = listOffersForListing(listing.id, ORG.alnoor, false);
    expect(supplierView).toHaveLength(1);
    expect(supplierView[0].bankName).toBe("Levant Commercial Bank");
  });

  it("listOffersForBank never includes another bank's offers", () => {
    const id = submittedTransaction(ORG.alnoor, "500.000");
    activateListing(id);
    const listing = currentListingForTransaction(id)!;
    const input = {
      transactionType: "INVOICE_FINANCING" as const,
      recourseType: "FULL_RECOURSE" as const,
      grossFundingAmount: "1000.000",
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    };
    createOffer(listing.id, ORG.lcb, "user-maker-lcb", "LCB Maker", input);
    createOffer(listing.id, ORG.jnb, "user-maker-jnb", "JNB Maker", input);

    const lcbOffers = listOffersForBank(ORG.lcb);
    expect(lcbOffers).toHaveLength(1);
    expect(lcbOffers[0].bankName).toBe("Levant Commercial Bank");
  });

  it("supplierListingView carries offerCount, which a bank's view never does", () => {
    const id = submittedTransaction(ORG.alnoor, "500.000");
    activateListing(id);
    const listing = currentListingForTransaction(id)!;
    createOffer(listing.id, ORG.lcb, "user-maker-lcb", "LCB Maker", {
      transactionType: "INVOICE_FINANCING",
      recourseType: "FULL_RECOURSE",
      grossFundingAmount: "1000.000",
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(supplierListingView(listing).offerCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Acceptance (§12.1 / ZM-SEL-001..008)
// ---------------------------------------------------------------------------

function activeOfferOn(listingId: string, orgId: string = ORG.lcb, gross = "1000.000") {
  const created = createOffer(listingId, orgId, "user-maker-1", "Maker One", {
    transactionType: "INVOICE_FINANCING",
    recourseType: "FULL_RECOURSE",
    grossFundingAmount: gross,
    validUntil: new Date(Date.now() + 3_600_000).toISOString(),
  });
  if (!created.ok) throw new Error("expected offer creation to succeed");
  const approved = approveOffer(created.offer.id, orgId, "user-approver-1");
  if (!approved.ok) throw new Error("expected approval to succeed");
  return created.offer;
}

describe("acceptOffer", () => {
  it("locks the transaction, selects the offer, and writes a snapshot", () => {
    const id = submittedTransaction(ORG.alnoor, "500.000");
    activateListing(id);
    const listing = currentListingForTransaction(id)!;
    const offer = activeOfferOn(listing.id);

    const result = acceptOffer(offer.id, ORG.alnoor, "user-owner-1", "key-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(findTransaction(id)!.lockedAt).toBeTruthy();
    expect(findOffer(offer.id)!.status).toBe("SELECTED");
    expect(result.snapshot.transactionId).toBe(id);
    expect(result.snapshot.netSupplierPayout).toBe(offer.netSupplierPayout);
    expect(findSnapshotForTransaction(id)).toEqual(result.snapshot);
  });

  it("ZM-SEL-002 step 6: every other active/pending offer on the listing loses in the same call", () => {
    const id = submittedTransaction(ORG.alnoor, "500.000");
    activateListing(id);
    const listing = currentListingForTransaction(id)!;
    const winner = activeOfferOn(listing.id, ORG.lcb);
    const loserCreated = createOffer(listing.id, ORG.jnb, "user-maker-jnb", "JNB Maker", {
      transactionType: "INVOICE_FINANCING",
      recourseType: "FULL_RECOURSE",
      grossFundingAmount: "900.000",
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    });
    if (!loserCreated.ok) throw new Error("expected the second offer to be created");

    acceptOffer(winner.id, ORG.alnoor, "user-owner-1", "key-2");

    expect(findOffer(winner.id)!.status).toBe("SELECTED");
    // The losing offer was PENDING_INTERNAL_APPROVAL (never approved) and
    // still loses — "every other active/pending offer," not just ACTIVE.
    expect(findOffer(loserCreated.offer.id)!.status).toBe("NOT_SELECTED");
  });

  it("ZM-SEL-004: a second acceptance attempt is impossible once the transaction is locked", () => {
    const id = submittedTransaction(ORG.alnoor, "500.000");
    activateListing(id);
    const listing = currentListingForTransaction(id)!;
    const offer = activeOfferOn(listing.id, ORG.lcb);
    const other = activeOfferOn(listing.id, ORG.jnb);

    acceptOffer(offer.id, ORG.alnoor, "user-owner-1", "key-a");
    const second = acceptOffer(other.id, ORG.alnoor, "user-owner-1", "key-b");
    expect(second).toEqual({ ok: false, error: "ALREADY_LOCKED" });
  });

  it("idempotency-key replay returns the original result without re-executing", () => {
    const id = submittedTransaction(ORG.alnoor, "500.000");
    activateListing(id);
    const listing = currentListingForTransaction(id)!;
    const offer = activeOfferOn(listing.id);

    const first = acceptOffer(offer.id, ORG.alnoor, "user-owner-1", "same-key");
    const replay = acceptOffer(offer.id, ORG.alnoor, "user-owner-1", "same-key");
    expect(replay).toEqual(first);
    // Exactly one snapshot exists — the replay did not create a second one.
    expect(findSnapshotForTransaction(id)).toEqual((first as { snapshot: unknown }).snapshot);
  });

  it("refuses to accept an offer that is not ACTIVE", () => {
    const id = submittedTransaction(ORG.alnoor, "500.000");
    activateListing(id);
    const listing = currentListingForTransaction(id)!;
    const created = createOffer(listing.id, ORG.lcb, "user-maker-1", "Maker One", {
      transactionType: "INVOICE_FINANCING",
      recourseType: "FULL_RECOURSE",
      grossFundingAmount: "1000.000",
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    });
    if (!created.ok) throw new Error("expected offer creation to succeed");
    // Never approved — still PENDING_INTERNAL_APPROVAL.
    const result = acceptOffer(created.offer.id, ORG.alnoor, "user-owner-1", "key-pending");
    expect(result).toEqual({ ok: false, error: "OFFER_NOT_ACTIVE" });
  });

  it("only the listing's own supplier organization may accept", () => {
    const id = submittedTransaction(ORG.alnoor, "500.000");
    activateListing(id);
    const listing = currentListingForTransaction(id)!;
    const offer = activeOfferOn(listing.id);
    const result = acceptOffer(offer.id, ORG.petra, "user-owner-1", "key-wrong-org");
    expect(result).toEqual({ ok: false, error: "NOT_FOUND" });
  });
});

describe("rejectAllOffers", () => {
  it("moves every active/pending offer to NOT_SELECTED and returns the transaction to ELIGIBLE", () => {
    const id = submittedTransaction(ORG.alnoor, "500.000");
    activateListing(id);
    const listing = currentListingForTransaction(id)!;
    const offer = activeOfferOn(listing.id);

    const result = rejectAllOffers(listing.id, ORG.alnoor);
    expect(result).toEqual({ ok: true });
    expect(findOffer(offer.id)!.status).toBe("NOT_SELECTED");
    expect(findTransaction(id)!.state).toBe("ELIGIBLE");
    expect(findTransaction(id)!.lockedAt).toBeFalsy();
  });

  it("refuses a supplier organization that does not own the listing", () => {
    const id = submittedTransaction(ORG.alnoor, "500.000");
    activateListing(id);
    const listing = currentListingForTransaction(id)!;
    expect(rejectAllOffers(listing.id, ORG.petra)).toEqual({ ok: false, error: "NOT_FOUND" });
  });
});
