import { describe, it, expect } from "vitest";
import {
  bankActions,
  breakdownRows,
  canRetryPayout,
  isSettlementInFlight,
  isWellFormedOtp,
  normalizeOtpInput,
  settlementTone,
  supplierActions,
} from "./funding-domain";

describe("INV-10 — no bank action reaches FUNDED", () => {
  it("offers the bank exactly two actions, neither of which completes funding", () => {
    const contracted = bankActions("CONTRACTED", false);
    const pending = bankActions("FUNDING_CONFIRMATION_PENDING", true);

    // The whole surface. If a third key appears here, something on the bank's
    // screen can finish funding without the supplier.
    expect(Object.keys(contracted).sort()).toEqual(["canGenerateOtp", "canMarkSent"]);
    expect(contracted).toEqual({ canMarkSent: true, canGenerateOtp: false });
    expect(pending).toEqual({ canMarkSent: false, canGenerateOtp: true });
  });

  it("withdraws mark-sent once a settlement exists, rather than inviting a 409", () => {
    expect(bankActions("CONTRACTED", true).canMarkSent).toBe(false);
  });

  it("offers the bank nothing at all once the transaction is FUNDED", () => {
    expect(bankActions("FUNDED", true)).toEqual({ canMarkSent: false, canGenerateOtp: false });
  });

  it("lets the supplier confirm only while the confirmation is actually pending", () => {
    expect(supplierActions("FUNDING_CONFIRMATION_PENDING").canConfirm).toBe(true);
    expect(supplierActions("CONTRACTED").canConfirm).toBe(false);
    expect(supplierActions("FUNDED").canConfirm).toBe(false);
    expect(supplierActions("CONTRACTED").awaitingBank).toBe(true);
  });
});

describe("OTP entry (ZM-FND-009)", () => {
  it("accepts six digits and nothing else", () => {
    expect(isWellFormedOtp("012345")).toBe(true);
    expect(isWellFormedOtp("  012345 ")).toBe(true);
    expect(isWellFormedOtp("12345")).toBe(false);
    expect(isWellFormedOtp("1234567")).toBe(false);
    expect(isWellFormedOtp("12345a")).toBe(false);
    expect(isWellFormedOtp("")).toBe(false);
  });

  it("keeps a leading zero, which a numeric input would eat", () => {
    // Codes are zero-padded server-side, so "004321" is a real code and
    // parsing the entry as a number would turn it into 4321.
    expect(normalizeOtpInput("004321")).toBe("004321");
    expect(isWellFormedOtp("004321")).toBe(true);
  });

  it("strips what a user pastes around the digits", () => {
    expect(normalizeOtpInput("012-345")).toBe("012345");
    expect(normalizeOtpInput("012 345")).toBe("012345");
    expect(normalizeOtpInput("0123456789")).toBe("012345");
  });
});

describe("INV-13 / AS-03 — retry is offered only where it can succeed", () => {
  const bank = ["BANK_OPERATIONS"];
  const ops = ["PLATFORM_OPS_ADMIN"];
  const supplier = ["SUPPLIER_OWNER"];

  it("is never offered while an attempt is in flight", () => {
    expect(canRetryPayout("PAYOUT_INITIATED", ops)).toBe(false);
    expect(canRetryPayout("RETRYING", ops)).toBe(false);
    expect(isSettlementInFlight("RETRYING")).toBe(true);
  });

  it("is never offered on a completed payout", () => {
    expect(canRetryPayout("PAYOUT_COMPLETED", ops)).toBe(false);
    expect(canRetryPayout("PAYOUT_COMPLETED", bank)).toBe(false);
  });

  it("is offered to the bank on a failure", () => {
    expect(canRetryPayout("PAYOUT_FAILED", bank)).toBe(true);
  });

  it("is platform-only under manual review — the bank has spent its allowance", () => {
    expect(canRetryPayout("MANUAL_REVIEW", bank)).toBe(false);
    expect(canRetryPayout("MANUAL_REVIEW", ops)).toBe(true);
  });

  it("is never offered to a supplier, whose money it is but whose rail it is not", () => {
    expect(canRetryPayout("PAYOUT_FAILED", supplier)).toBe(false);
    expect(canRetryPayout("MANUAL_REVIEW", supplier)).toBe(false);
  });
});

describe("the settlement breakdown", () => {
  const settlement = {
    grossFundingAmount: "9000.000",
    platformCommissionAmount: "135.000",
    listingFeeDeducted: "25.000",
    netSupplierPayout: "8390.000",
  };

  it("shows every component, not only the net", () => {
    const rows = breakdownRows(settlement);
    expect(rows.map((r) => r.key)).toEqual(["gross", "commission", "listingFee", "net"]);
    expect(rows.filter((r) => r.deduction).map((r) => r.amount)).toEqual(["135.000", "25.000"]);
  });

  it("carries money through as the string it arrived as, never a number", () => {
    for (const row of breakdownRows(settlement)) {
      expect(typeof row.amount).toBe("string");
      expect(row.amount).toMatch(/^\d+\.\d{3}$/);
    }
  });

  it("has no field for the supplier's private floor, by construction", () => {
    expect(Object.keys(settlement)).not.toContain("minimumAcceptableAmount");
  });
});

describe("settlement status colour", () => {
  it("reserves danger for the states that need a human", () => {
    expect(settlementTone("MANUAL_REVIEW")).toBe("danger");
    expect(settlementTone("REVERSED")).toBe("danger");
    expect(settlementTone("PAYOUT_COMPLETED")).toBe("success");
    // A retryable failure is a warning, not a catastrophe.
    expect(settlementTone("PAYOUT_FAILED")).toBe("warning");
    // Waiting is not adverse (brief §5).
    expect(settlementTone("FUNDING_RECEIVED")).toBe("info");
  });
});
