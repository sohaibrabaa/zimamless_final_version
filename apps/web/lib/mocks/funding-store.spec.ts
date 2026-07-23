import { describe, it, expect, beforeEach } from "vitest";
import {
  confirmOtp,
  findSettlementByTransaction,
  forcePayoutFailure,
  generateOtp,
  markSent,
  resetFundingStore,
  retryPayout,
} from "./funding-store";

/**
 * These test the mock, which sounds redundant until you remember why the mock
 * exists: a screen is built against it and then promoted to the live API. Any
 * invariant the mock fails to reproduce is an invariant the screen was never
 * tested against, and promotion is where that surfaces.
 */

const TX = "tx-1";
const BREAKDOWN = {
  grossFundingAmount: "9000.000",
  platformCommissionAmount: "135.000",
  listingFeeDeducted: "25.000",
  netSupplierPayout: "8390.000",
};
const NOW = new Date("2026-07-23T10:00:00.000Z");

beforeEach(() => resetFundingStore());

function markSentOk() {
  const result = markSent(TX, BREAKDOWN, "WIRE-1", NOW);
  if (!result.ok) throw new Error("fixture: mark-sent should have succeeded");
  return result.settlement;
}

describe("INV-10 — mark-sent cannot fund", () => {
  it("leaves the settlement at FUNDING_RECEIVED, never paid out", () => {
    const settlement = markSentOk();
    expect(settlement.status).toBe("FUNDING_RECEIVED");
    expect(settlement.payoutCompletedAt).toBeNull();
  });

  it("refuses a second mark-sent instead of creating a second settlement", () => {
    markSentOk();
    const again = markSent(TX, BREAKDOWN, "WIRE-2", NOW);
    expect(again).toEqual({ ok: false, error: "ALREADY_SENT" });
  });

  it("does not fund on a correct code when the bank never marked the transfer sent", () => {
    const issued = generateOtp(TX, NOW);
    if (!issued.ok) throw new Error("fixture");
    const result = confirmOtp(TX, issued.otp, NOW);

    expect(result).toEqual({
      ok: true,
      fundedAt: null,
      transactionState: "FUNDING_CONFIRMATION_PENDING",
    });
  });

  it("funds only when both halves are present", () => {
    markSentOk();
    const issued = generateOtp(TX, NOW);
    if (!issued.ok) throw new Error("fixture");

    const result = confirmOtp(TX, issued.otp, NOW);
    expect(result).toMatchObject({ ok: true, transactionState: "FUNDED" });
  });
});

describe("ZM-FND-009 — wrong, expired and used are indistinguishable", () => {
  it("returns byte-identical failures for a wrong code and an expired one", () => {
    markSentOk();
    const issued = generateOtp(TX, NOW);
    if (!issued.ok) throw new Error("fixture");

    const wrong = confirmOtp(TX, "000000" === issued.otp ? "111111" : "000000", NOW);
    const expired = confirmOtp(TX, issued.otp, new Date(NOW.getTime() + 16 * 60 * 1000));

    // Same shape, same error, same keys. Only the counter differs, and it
    // differs only because an attempt was spent.
    expect(Object.keys(wrong).sort()).toEqual(Object.keys(expired).sort());
    expect({ ...wrong, attemptsRemaining: 0 }).toEqual({ ...expired, attemptsRemaining: 0 });
  });

  it("returns the same failure for a code already used successfully", () => {
    markSentOk();
    const issued = generateOtp(TX, NOW);
    if (!issued.ok) throw new Error("fixture");
    confirmOtp(TX, issued.otp, NOW);

    const reused = confirmOtp(TX, issued.otp, NOW);
    expect(reused).toMatchObject({ ok: false, error: "INVALID" });
  });

  it("spends an attempt on every failure and stops at zero", () => {
    markSentOk();
    generateOtp(TX, NOW);
    const counts = [1, 2, 3, 4, 5, 6].map(() => {
      const r = confirmOtp(TX, "999999", NOW);
      return r.ok ? -1 : r.attemptsRemaining;
    });
    expect(counts).toEqual([4, 3, 2, 1, 0, 0]);
  });

  it("bounds regeneration and restores attempts with each new code", () => {
    const first = generateOtp(TX, NOW);
    expect(first.ok && first.resendsRemaining).toBe(3);
    confirmOtp(TX, "999999", NOW);

    const second = generateOtp(TX, NOW);
    expect(second.ok && second.resendsRemaining).toBe(2);

    generateOtp(TX, NOW);
    generateOtp(TX, NOW);
    expect(generateOtp(TX, NOW)).toEqual({ ok: false, error: "NO_RESENDS" });
  });

  it("issues a different code each time, so a regeneration is a real replacement", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 4; i += 1) {
      const r = generateOtp(TX, NOW);
      if (r.ok) codes.add(r.otp);
    }
    // Not a strict inequality assertion — random six-digit codes can collide —
    // but four identical codes would mean regeneration does nothing.
    expect(codes.size).toBeGreaterThan(1);
  });
});

describe("INV-13 — a settlement never pays twice", () => {
  function fundedSettlement() {
    markSentOk();
    const issued = generateOtp(TX, NOW);
    if (!issued.ok) throw new Error("fixture");
    confirmOtp(TX, issued.otp, NOW);
    return findSettlementByTransaction(TX)!;
  }

  it("pays out once when funding completes", () => {
    const settlement = fundedSettlement();
    expect(settlement.status).toBe("PAYOUT_COMPLETED");
    expect(settlement.retryCount).toBe(0);
  });

  it("treats retrying a completed payout as a no-op, not an error", () => {
    const settlement = fundedSettlement();
    const completedAt = settlement.payoutCompletedAt;

    const retried = retryPayout(settlement.id, new Date(NOW.getTime() + 60_000));
    expect(retried?.status).toBe("PAYOUT_COMPLETED");
    // The same payout, not a second one: the completion timestamp did not move.
    expect(retried?.payoutCompletedAt).toBe(completedAt);
    expect(retried?.retryCount).toBe(0);
  });

  it("retries a failed payout and counts the attempt", () => {
    const settlement = fundedSettlement();
    forcePayoutFailure(TX);
    expect(findSettlementByTransaction(TX)?.status).toBe("PAYOUT_FAILED");

    const retried = retryPayout(settlement.id, NOW);
    expect(retried?.status).toBe("PAYOUT_COMPLETED");
    expect(retried?.retryCount).toBe(1);
  });

  it("returns undefined for a settlement that does not exist", () => {
    expect(retryPayout("nope", NOW)).toBeUndefined();
  });
});

describe("the settlement breakdown carries money as strings", () => {
  it("keeps three decimal places and never becomes a number", () => {
    const settlement = markSentOk();
    for (const value of [
      settlement.grossFundingAmount,
      settlement.platformCommissionAmount,
      settlement.listingFeeDeducted,
      settlement.netSupplierPayout,
    ]) {
      expect(typeof value).toBe("string");
      expect(value).toMatch(/^\d+\.\d{3}$/);
    }
  });
});
