import { describe, it, expect } from "vitest";
import {
  allMandatoryConditionsResolved,
  contentHash,
  isFullySigned,
  preContractCheckFailures,
} from "./contract-domain";

describe("allMandatoryConditionsResolved", () => {
  it("is true when there are no conditions at all", () => {
    expect(allMandatoryConditionsResolved([])).toBe(true);
  });

  it("ignores non-mandatory conditions regardless of their fulfilment", () => {
    expect(allMandatoryConditionsResolved([{ isMandatory: false, fulfilment: "PENDING" }])).toBe(true);
  });

  it("is false while a mandatory condition is PENDING or FAILED", () => {
    expect(allMandatoryConditionsResolved([{ isMandatory: true, fulfilment: "PENDING" }])).toBe(false);
    expect(allMandatoryConditionsResolved([{ isMandatory: true, fulfilment: "FAILED" }])).toBe(false);
  });

  it("is true once every mandatory condition is FULFILLED or WAIVED", () => {
    expect(
      allMandatoryConditionsResolved([
        { isMandatory: true, fulfilment: "FULFILLED" },
        { isMandatory: true, fulfilment: "WAIVED" },
        { isMandatory: false, fulfilment: "PENDING" },
      ])
    ).toBe(true);
  });
});

describe("preContractCheckFailures (ZM-CON-006)", () => {
  const resolved = { conditions: [], declarationTemplateVersion: "1.0", bankAccountVerified: true };

  it("passes with nothing to fail", () => {
    expect(preContractCheckFailures(resolved)).toEqual([]);
  });

  it("flags unresolved mandatory conditions", () => {
    expect(
      preContractCheckFailures({ ...resolved, conditions: [{ isMandatory: true, fulfilment: "PENDING" }] })
    ).toContain("CONDITIONS_UNFULFILLED");
  });

  it("flags missing declaration reconfirmation", () => {
    expect(preContractCheckFailures({ ...resolved, declarationTemplateVersion: undefined })).toContain(
      "DECLARATIONS_NOT_RECONFIRMED"
    );
  });

  it("flags an unverified bank account", () => {
    expect(preContractCheckFailures({ ...resolved, bankAccountVerified: false })).toContain(
      "BANK_ACCOUNT_UNVERIFIED"
    );
  });

  it("can report all three failures at once", () => {
    const failures = preContractCheckFailures({
      conditions: [{ isMandatory: true, fulfilment: "PENDING" }],
      declarationTemplateVersion: undefined,
      bankAccountVerified: false,
    });
    expect(failures).toHaveLength(3);
  });
});

describe("isFullySigned (ZM-CON-010/012)", () => {
  it("requires at least one signature from each side", () => {
    expect(isFullySigned([])).toBe(false);
    expect(isFullySigned([{ organizationType: "SUPPLIER" }])).toBe(false);
    expect(isFullySigned([{ organizationType: "BANK" }])).toBe(false);
    expect(isFullySigned([{ organizationType: "SUPPLIER" }, { organizationType: "BANK" }])).toBe(true);
  });

  it("does not require exactly one — extra signatories on one side still count", () => {
    expect(
      isFullySigned([
        { organizationType: "SUPPLIER" },
        { organizationType: "SUPPLIER" },
        { organizationType: "BANK" },
      ])
    ).toBe(true);
  });
});

describe("contentHash", () => {
  it("is deterministic for the same content", () => {
    expect(contentHash("hello")).toBe(contentHash("hello"));
  });

  it("differs for different content", () => {
    expect(contentHash("hello")).not.toBe(contentHash("hello!"));
  });

  it("looks like a hash, not the raw content", () => {
    expect(contentHash("hello")).toMatch(/^sha-mock-[0-9a-f]{8}$/);
  });
});
