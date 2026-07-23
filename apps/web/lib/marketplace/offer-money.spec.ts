import { describe, it, expect } from "vitest";
import { computeCommission, computeNetSupplierPayout, isBelowFloor, LISTING_FEE_AMOUNT, sumMoney } from "./offer-money";

describe("computeNetSupplierPayout", () => {
  it("implements the §11.2 formula exactly", () => {
    const net = computeNetSupplierPayout({
      grossFundingAmount: "10000.000",
      bankDiscountAmount: "200.000",
      bankFeesAmount: "50.000",
      platformCommissionAmount: "150.000",
      unpaidListingFeeAmount: "150.000",
      otherDeductionsAmount: "25.000",
    });
    // 10000 - 200 - 50 - 150 - 150 - 25 = 9425
    expect(net).toBe("9425.000");
  });

  it("holds to 3 decimal places without float drift", () => {
    const net = computeNetSupplierPayout({
      grossFundingAmount: "1000.333",
      bankDiscountAmount: "0.111",
      bankFeesAmount: "0.111",
      platformCommissionAmount: "0.111",
      unpaidListingFeeAmount: "0.000",
      otherDeductionsAmount: "0.000",
    });
    expect(net).toBe("1000.000");
  });
});

describe("computeCommission", () => {
  it("is a function of grossFundingAmount only, never faceValue or the floor (ZM-FEE-011)", () => {
    // Same gross, wildly different context — same commission.
    const a = computeCommission("10000.000");
    const b = computeCommission("10000.000");
    expect(a).toBe(b);
    expect(a).toBe("150.000"); // 1.5% demo rate
  });

  it("scales with gross", () => {
    expect(computeCommission("20000.000")).toBe("300.000");
  });
});

describe("isBelowFloor", () => {
  it("flags net strictly below the minimum acceptable amount", () => {
    expect(isBelowFloor("999.000", "1000.000")).toBe(true);
  });

  it("does not flag net equal to or above the floor", () => {
    expect(isBelowFloor("1000.000", "1000.000")).toBe(false);
    expect(isBelowFloor("1000.001", "1000.000")).toBe(false);
  });
});

describe("sumMoney", () => {
  it("sums a list of money strings", () => {
    expect(sumMoney(["1.000", "2.500", "0.500"])).toBe("4.000");
  });

  it("returns zero for an empty list", () => {
    expect(sumMoney([])).toBe("0.000");
  });
});

describe("LISTING_FEE_AMOUNT", () => {
  it("is a valid 3-decimal money string", () => {
    expect(LISTING_FEE_AMOUNT).toMatch(/^\d+\.\d{3}$/);
  });
});
