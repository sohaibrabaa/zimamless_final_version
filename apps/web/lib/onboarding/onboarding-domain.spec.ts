import { describe, it, expect } from "vitest";

import { financingBlocked, isDecided, slaClockState, statusTone } from "./status";
import { breakDownBusinessSeconds, pauseReasonFor, slaProgressFraction } from "./sla";
import { isSoleProprietorship, normalizeGovernmentData } from "./government";
import { validateIban } from "./iban";
import { allEssentialGranted, CONSENT_CATALOGUE } from "./consents";

describe("SLA clock semantics (§5.5)", () => {
  it("follows the state table", () => {
    expect(slaClockState("DRAFT", undefined)).toBe("NOT_STARTED");
    expect(slaClockState("UNDER_REVIEW", undefined)).toBe("RUNNING");
    expect(slaClockState("INFORMATION_REQUIRED", undefined)).toBe("PAUSED");
    expect(slaClockState("GOVERNMENT_SERVICE_UNAVAILABLE", undefined)).toBe("PAUSED");
    expect(slaClockState("APPROVED", undefined)).toBe("STOPPED");
    expect(slaClockState("REJECTED", undefined)).toBe("STOPPED");
  });

  it("lets the server's slaPaused flag override the status table while in progress", () => {
    expect(slaClockState("UNDER_REVIEW", true)).toBe("PAUSED");
    expect(slaClockState("INFORMATION_REQUIRED", false)).toBe("RUNNING");
  });

  it("never shows a decided or unsubmitted application as paused or running", () => {
    expect(slaClockState("APPROVED", true)).toBe("STOPPED");
    expect(slaClockState("DRAFT", true)).toBe("NOT_STARTED");
  });

  it("renders a clock for an unknown status rather than blanking the screen", () => {
    expect(slaClockState("SOME_FUTURE_STATE", undefined)).toBe("RUNNING");
  });

  it("breaks remaining business time down without floating-point drift", () => {
    expect(breakDownBusinessSeconds(86_400)).toEqual({ hours: 24, minutes: 0, overdue: false });
    expect(breakDownBusinessSeconds(3_661)).toEqual({ hours: 1, minutes: 1, overdue: false });
    expect(breakDownBusinessSeconds(0)).toEqual({ hours: 0, minutes: 0, overdue: true });
    expect(breakDownBusinessSeconds(undefined)).toBeNull();
  });

  it("clamps the progress fraction and omits it when unknown", () => {
    expect(slaProgressFraction(43_200)).toBe(0.5);
    expect(slaProgressFraction(999_999)).toBe(1);
    expect(slaProgressFraction(-50)).toBe(0);
    expect(slaProgressFraction(undefined)).toBeNull();
  });

  it("prefers the server's pause reason and falls back to status (Q-07)", () => {
    expect(pauseReasonFor("UNDER_REVIEW", "GOVERNMENT_SERVICE_UNAVAILABLE")).toBe(
      "GOVERNMENT_SERVICE_UNAVAILABLE"
    );
    expect(pauseReasonFor("INFORMATION_REQUIRED", undefined)).toBe("INFORMATION_REQUIRED");
    expect(pauseReasonFor("UNDER_REVIEW", undefined)).toBe("UNSPECIFIED");
  });
});

describe("neutral presentation of non-adverse states", () => {
  it("styles only a confirmed rejection as adverse (ZM-SON-010, ZM-GOV-003)", () => {
    // These two are the states most likely to be "improved" into a warning
    // colour by a later edit. An unanswered registry and an open information
    // request are process facts, not findings against the supplier.
    expect(statusTone("GOVERNMENT_SERVICE_UNAVAILABLE")).toBe("neutral");
    expect(statusTone("INFORMATION_REQUIRED")).toBe("neutral");
    expect(statusTone("REJECTED")).toBe("danger");
    expect(statusTone("APPROVED")).toBe("success");
  });
});

describe("ZM-SON-011 financing gate", () => {
  it("blocks financing in every state except full approval", () => {
    expect(financingBlocked("APPROVED")).toBe(false);
    expect(financingBlocked("APPROVED_CONDITIONAL")).toBe(true);
    expect(financingBlocked("UNDER_REVIEW")).toBe(true);
    expect(financingBlocked("REJECTED")).toBe(true);
    expect(financingBlocked(undefined)).toBe(true);
  });

  it("counts conditional approval as decided", () => {
    expect(isDecided("APPROVED_CONDITIONAL")).toBe(true);
    expect(isDecided("UNDER_REVIEW")).toBe(false);
  });
});

describe("government provenance normalization (the Q-05 adapter)", () => {
  it("reads source and retrieval date from a provenance-shaped entry", () => {
    const [field] = normalizeGovernmentData({
      legalCompanyName: {
        value: "Al-Noor Trading Company",
        source: "CCD",
        retrievedAt: "2026-07-20T09:14:00.000Z",
        verificationStatus: "GOVERNMENT_VERIFIED",
      },
    });
    expect(field.value).toBe("Al-Noor Trading Company");
    expect(field.source).toBe("CCD");
    expect(field.retrievedAt).toBe("2026-07-20T09:14:00.000Z");
  });

  it("degrades a bare value to a badge-less field rather than guessing a source", () => {
    const [field] = normalizeGovernmentData({ taxNumber: "TAX-20000101" });
    expect(field.value).toBe("TAX-20000101");
    expect(field.source).toBeNull();
  });

  it("treats an empty value as absent, so it renders 'not provided' and never as adverse", () => {
    const fields = normalizeGovernmentData({
      a: { value: null, source: "ISTD" },
      b: { value: "", source: "ISTD" },
      c: { value: "   ", source: "ISTD" },
    });
    expect(fields.map((f) => f.value)).toEqual([null, null, null]);
  });

  it("flattens array values instead of rendering [object Object]", () => {
    const [field] = normalizeGovernmentData({
      partners: { value: ["Rania Haddad", "Omar Khalil"], source: "CCD" },
    });
    expect(field.value).toBe("Rania Haddad · Omar Khalil");
  });

  it("never throws on unexpected payload shapes", () => {
    expect(() => normalizeGovernmentData({ x: 42, y: true, z: { nested: {} } })).not.toThrow();
    expect(normalizeGovernmentData(undefined)).toEqual([]);
  });

  it("detects sole proprietorship from the registry's own company type (ZM-SON-013)", () => {
    const sole = normalizeGovernmentData({
      companyType: { value: "SOLE_PROPRIETORSHIP", source: "CCD" },
    });
    const llc = normalizeGovernmentData({
      companyType: { value: "LIMITED_LIABILITY", source: "CCD" },
    });
    expect(isSoleProprietorship(sole)).toBe(true);
    expect(isSoleProprietorship(llc)).toBe(false);
    // An absent company type is not an ineligibility finding.
    expect(isSoleProprietorship(normalizeGovernmentData({}))).toBe(false);
  });
});

describe("IBAN input hygiene", () => {
  it("accepts a valid Jordanian IBAN in any spacing or case", () => {
    expect(validateIban("JO94CBJO0010000000000131000302")).toBeNull();
    expect(validateIban("jo94 cbjo 0010 0000 0000 0131 0003 02")).toBeNull();
  });

  it("distinguishes the failure modes so the message can be specific", () => {
    expect(validateIban("not-an-iban")).toBe("FORMAT");
    expect(validateIban("GB82WEST12345698765432")).toBe("COUNTRY");
    expect(validateIban("JO94CBJO00100000000001")).toBe("LENGTH");
    expect(validateIban("JO95CBJO0010000000000131000302")).toBe("CHECKSUM");
  });
});

describe("consents (ZM-SON-012)", () => {
  it("marks every catalogued consent essential, so a partial grant cannot submit", () => {
    expect(CONSENT_CATALOGUE.every((c) => c.essential)).toBe(true);

    const partial = Object.fromEntries(CONSENT_CATALOGUE.map((c, i) => [c.consentType, i === 0]));
    const all = Object.fromEntries(CONSENT_CATALOGUE.map((c) => [c.consentType, true]));

    expect(allEssentialGranted(partial)).toBe(false);
    expect(allEssentialGranted(all)).toBe(true);
    expect(allEssentialGranted({})).toBe(false);
  });
});
