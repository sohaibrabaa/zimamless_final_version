import { describe, it, expect } from "vitest";
import enMessages from "@/messages/en.json";
import arMessages from "@/messages/ar.json";
import {
  bankPostFundingActions,
  isAutomationPaused,
  isAwaitingBankConfirmation,
  isCaseTypeVisibleTo,
  overdueDaysFrom,
  stateTone,
  supplierPostFundingActions,
} from "./payments-domain";

/**
 * The headline test in this file reads the actual translation bundles.
 *
 * A domain function returning the *key* `payments.state.OVERDUE_UNCONFIRMED`
 * proves nothing about what a supplier reads. The words are the requirement
 * (ZM-PMT-008..011), so the words are what gets asserted — in both languages,
 * because an Arabic-speaking supplier is not less entitled to accurate wording.
 */

const en = enMessages as unknown as Record<string, Record<string, Record<string, string>>>;
const ar = arMessages as unknown as Record<string, Record<string, Record<string, string>>>;

describe("ZM-PMT-008..011 — OVERDUE_UNCONFIRMED never reads as default", () => {
  it("labels it as awaiting the bank, in English", () => {
    const label = en.payments.state.OVERDUE_UNCONFIRMED;
    expect(label).toBeDefined();

    const lower = label.toLowerCase();
    // The words that would turn a date passing into an accusation.
    for (const banned of ["default", "defaulted", "failed", "late", "overdue"]) {
      expect(lower).not.toContain(banned);
    }
    expect(lower).toContain("awaiting");
  });

  it("labels it as awaiting the bank, in Arabic", () => {
    const label = ar.payments.state.OVERDUE_UNCONFIRMED;
    expect(label).toBeDefined();
    // تعثر / متأخر / متأخرة — default and late.
    for (const banned of ["تعثر", "متأخر"]) {
      expect(label).not.toContain(banned);
    }
    expect(label).toContain("بانتظار");
  });

  it("does say overdue for the CONFIRMED state, where it is true", () => {
    // The distinction is the point. Once a bank has confirmed, the platform
    // has evidence and may say so plainly.
    expect(en.payments.state.OVERDUE.toLowerCase()).toContain("overdue");
  });

  it("colours it neutral, not warning", () => {
    // Brief §5 forbids presenting a non-adverse state with warning colours.
    // Amber would say in design what the copy is careful not to say in words.
    expect(stateTone("OVERDUE_UNCONFIRMED")).toBe("neutral");
    expect(stateTone("OVERDUE")).toBe("warning");
    expect(stateTone("PAID")).toBe("success");
  });

  it("knows the platform is waiting rather than asserting", () => {
    expect(isAwaitingBankConfirmation("OVERDUE_UNCONFIRMED")).toBe(true);
    expect(isAwaitingBankConfirmation("OVERDUE")).toBe(false);
  });
});

describe("ZM-REC-013 — a paused transaction is visibly paused", () => {
  it("treats DISPUTED and FRAUD_REVIEW as paused", () => {
    expect(isAutomationPaused("DISPUTED")).toBe(true);
    expect(isAutomationPaused("FRAUD_REVIEW")).toBe(true);
    expect(isAutomationPaused("FUNDED")).toBe(false);
  });

  it("offers no actions while paused", () => {
    for (const state of ["DISPUTED", "FRAUD_REVIEW"] as const) {
      expect(bankPostFundingActions(state).canDispute).toBe(false);
      expect(supplierPostFundingActions(state).canDispute).toBe(false);
    }
  });
});

describe("bank actions", () => {
  it("offers recourse only on a CONFIRMED overdue", () => {
    // Offering it on an unconfirmed one would suggest the platform thinks an
    // unconfirmed overdue is grounds for a claim against a supplier.
    expect(bankPostFundingActions("OVERDUE").canInitiateRecourse).toBe(true);
    expect(bankPostFundingActions("OVERDUE_UNCONFIRMED").canInitiateRecourse).toBe(false);
    expect(bankPostFundingActions("FUNDED").canInitiateRecourse).toBe(false);
  });

  it("offers confirm-status exactly where a confirmation is outstanding", () => {
    expect(bankPostFundingActions("OVERDUE_UNCONFIRMED").canConfirmStatus).toBe(true);
    expect(bankPostFundingActions("PAID").canConfirmStatus).toBe(false);
    expect(bankPostFundingActions("CLOSED").canConfirmStatus).toBe(false);
  });

  it("never offers a supplier the ability to report a buyer payment", () => {
    // A supplier does not see the bank's account either.
    expect(supplierPostFundingActions("FUNDED")).not.toHaveProperty("canReportPayment");
  });
});

describe("fraud cases are invisible to the parties", () => {
  it("hides FRAUD from a bank and a supplier, shows it to the platform", () => {
    for (const org of ["BANK", "SUPPLIER"] as const) {
      expect(isCaseTypeVisibleTo("FRAUD", org)).toBe(false);
      // The other three are ordinary shared business.
      expect(isCaseTypeVisibleTo("DISPUTE", org)).toBe(true);
      expect(isCaseTypeVisibleTo("RECOURSE", org)).toBe(true);
      expect(isCaseTypeVisibleTo("WITHDRAWAL", org)).toBe(true);
    }
    expect(isCaseTypeVisibleTo("FRAUD", "PLATFORM")).toBe(true);
  });

  it("hides fraud from an unknown organization type too", () => {
    expect(isCaseTypeVisibleTo("FRAUD", undefined)).toBe(false);
  });
});

describe("overdue days", () => {
  const now = new Date("2026-09-06T12:00:00.000Z");

  it("counts whole days past due", () => {
    expect(overdueDaysFrom("2026-08-30", now)).toBe(7);
  });

  it("is zero before and on the due date", () => {
    expect(overdueDaysFrom("2026-09-06", now)).toBe(0);
    expect(overdueDaysFrom("2026-10-01", now)).toBe(0);
  });

  it("survives a missing or malformed date", () => {
    expect(overdueDaysFrom(undefined, now)).toBe(0);
    expect(overdueDaysFrom("not-a-date", now)).toBe(0);
  });
});
