import { describe, it, expect } from "vitest";
import { evaluateEligibility, type ListingFacts, type PolicyFilterRecord } from "./policy-filters";

const BASE_FACTS: ListingFacts = {
  outstandingAmount: "10000.000",
  tenorDays: 30,
  compositeScore: 68,
  band: "MEDIUM",
  buyerNationalEstablishmentNumber: "30000201",
  supplierNationalEstablishmentNumber: "20000101",
  buyerGovernorate: "Amman",
  documentTypes: ["EINVOICE"],
};

function filter(overrides: Partial<PolicyFilterRecord> = {}): PolicyFilterRecord {
  return { id: "f1", bankOrganizationId: "b1", name: "Test filter", isActive: true, ...overrides };
}

describe("evaluateEligibility", () => {
  it("ZM-MKT-002: a bank with no active filter is not eligible for anything", () => {
    expect(evaluateEligibility(undefined, BASE_FACTS).eligible).toBe(false);
    expect(evaluateEligibility(filter({ isActive: false }), BASE_FACTS).eligible).toBe(false);
  });

  it("a filter with no configured rules is eligible for everything", () => {
    expect(evaluateEligibility(filter(), BASE_FACTS).eligible).toBe(true);
  });

  it("rejects below minAmount and accepts at or above it", () => {
    expect(evaluateEligibility(filter({ minAmount: "10001.000" }), BASE_FACTS).eligible).toBe(false);
    expect(evaluateEligibility(filter({ minAmount: "10000.000" }), BASE_FACTS).eligible).toBe(true);
  });

  it("rejects above maxAmount and accepts at or below it", () => {
    expect(evaluateEligibility(filter({ maxAmount: "9999.000" }), BASE_FACTS).eligible).toBe(false);
    expect(evaluateEligibility(filter({ maxAmount: "10000.000" }), BASE_FACTS).eligible).toBe(true);
  });

  it("evaluates tenor range", () => {
    expect(evaluateEligibility(filter({ minTenorDays: 31 }), BASE_FACTS).eligible).toBe(false);
    expect(evaluateEligibility(filter({ maxTenorDays: 29 }), BASE_FACTS).eligible).toBe(false);
    expect(evaluateEligibility(filter({ minTenorDays: 30, maxTenorDays: 30 }), BASE_FACTS).eligible).toBe(true);
  });

  it("evaluates minTrustScore", () => {
    expect(evaluateEligibility(filter({ minTrustScore: 69 }), BASE_FACTS).eligible).toBe(false);
    expect(evaluateEligibility(filter({ minTrustScore: 68 }), BASE_FACTS).eligible).toBe(true);
  });

  it("evaluates maxRiskBand as a ceiling, not an exact match — HIGH facts fail a MEDIUM ceiling", () => {
    const highFacts: ListingFacts = { ...BASE_FACTS, band: "HIGH" };
    expect(evaluateEligibility(filter({ maxRiskBand: "MEDIUM" }), highFacts).eligible).toBe(false);
    expect(evaluateEligibility(filter({ maxRiskBand: "HIGH" }), highFacts).eligible).toBe(true);
    expect(evaluateEligibility(filter({ maxRiskBand: "CRITICAL" }), highFacts).eligible).toBe(true);
  });

  it("buyer/supplier/geography include-exclude lists", () => {
    expect(evaluateEligibility(filter({ buyersExclude: ["30000201"] }), BASE_FACTS).eligible).toBe(false);
    expect(evaluateEligibility(filter({ buyersInclude: ["30000999"] }), BASE_FACTS).eligible).toBe(false);
    expect(evaluateEligibility(filter({ buyersInclude: ["30000201"] }), BASE_FACTS).eligible).toBe(true);
    expect(evaluateEligibility(filter({ governoratesExclude: ["Amman"] }), BASE_FACTS).eligible).toBe(false);
  });

  it("requiredDocumentTypes must all be present", () => {
    expect(evaluateEligibility(filter({ requiredDocumentTypes: ["EINVOICE", "DELIVERY_NOTE"] }), BASE_FACTS).eligible).toBe(
      false
    );
    expect(evaluateEligibility(filter({ requiredDocumentTypes: ["EINVOICE"] }), BASE_FACTS).eligible).toBe(true);
  });

  it("ZM-MKT-003: records which rules were applied, not just the outcome", () => {
    const result = evaluateEligibility(filter({ minAmount: "1.000", maxRiskBand: "HIGH" }), BASE_FACTS);
    expect(result.rulesApplied).toEqual(expect.arrayContaining([expect.stringContaining("minAmount"), expect.stringContaining("maxRiskBand")]));
  });
});
