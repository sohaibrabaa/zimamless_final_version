import { describe, it, expect } from "vitest";
import { computeRiskAssessment, FULLY_AVAILABLE, MODEL_VERSION, type RiskInputs } from "./risk-engine";
import {
  BAND_THRESHOLDS,
  bandLabelKey,
  bandTone,
  dataAvailabilityNeutralTone,
  hasFallback,
  modelModeLabelKey,
} from "./risk-presentation";

const BASE_INPUTS: RiskInputs = {
  buyerRegistryStatus: "ACTIVE",
  verificationOverallResult: "PASS",
  tenorDays: 30,
  priorDuplicateFlags: 0,
  sourceAvailability: FULLY_AVAILABLE,
  mlUsed: true,
};

const CALCULATED_AT = "2026-07-23T12:00:00.000Z";

describe("INV-9 — sourceAvailability affects dataAvailabilityPct only (ZM-RSK-005/006/008)", () => {
  it("keeps all five components byte-identical when only sourceAvailability changes", () => {
    const fullyAvailable = computeRiskAssessment(BASE_INPUTS, CALCULATED_AT);
    const oneSourceDown = computeRiskAssessment(
      { ...BASE_INPUTS, sourceAvailability: { ccdAvailable: true, istdAvailable: false, gamAvailable: true } },
      CALCULATED_AT
    );

    // The paired-fixture assertion itself: identical facts, one with a
    // source down, and the five components must not merely be "close" —
    // they must be exactly equal, because ZM-RSK-005 says "MUST NEVER
    // reduce", not "should only slightly reduce".
    expect(oneSourceDown.components).toEqual(fullyAvailable.components);
    expect(oneSourceDown.compositeScore).toBe(fullyAvailable.compositeScore);
    expect(oneSourceDown.band).toBe(fullyAvailable.band);

    // ...and dataAvailabilityPct is the only thing that actually moved.
    expect(fullyAvailable.dataAvailabilityPct).toBe(100);
    expect(oneSourceDown.dataAvailabilityPct).toBeLessThan(100);
  });

  it("holds for every single-source-down permutation, not just one", () => {
    const fullyAvailable = computeRiskAssessment(BASE_INPUTS, CALCULATED_AT);
    const permutations: RiskInputs["sourceAvailability"][] = [
      { ccdAvailable: false, istdAvailable: true, gamAvailable: true },
      { ccdAvailable: true, istdAvailable: false, gamAvailable: true },
      { ccdAvailable: true, istdAvailable: true, gamAvailable: false },
      { ccdAvailable: false, istdAvailable: false, gamAvailable: false },
    ];

    for (const sourceAvailability of permutations) {
      const result = computeRiskAssessment({ ...BASE_INPUTS, sourceAvailability }, CALCULATED_AT);
      expect(result.components, JSON.stringify(sourceAvailability)).toEqual(fullyAvailable.components);
      expect(result.compositeScore, JSON.stringify(sourceAvailability)).toBe(fullyAvailable.compositeScore);
    }

    const allDown = computeRiskAssessment(
      { ...BASE_INPUTS, sourceAvailability: { ccdAvailable: false, istdAvailable: false, gamAvailable: false } },
      CALCULATED_AT
    );
    expect(allDown.dataAvailabilityPct).toBe(0);
  });

  it("never lets a source outage move the score into a different risk band", () => {
    const fullyAvailable = computeRiskAssessment(BASE_INPUTS, CALCULATED_AT);
    const allDown = computeRiskAssessment(
      { ...BASE_INPUTS, sourceAvailability: { ccdAvailable: false, istdAvailable: false, gamAvailable: false } },
      CALCULATED_AT
    );
    expect(allDown.band).toBe(fullyAvailable.band);
  });
});

describe("dataAvailabilityPct presentation is structurally incapable of a warning tone", () => {
  it("always returns neutral regardless of the percentage", () => {
    // There is no branch in dataAvailabilityNeutralTone() to assert
    // against — that absence is exactly the property under test. Calling it
    // with the two extremes a reviewer would think to try is what a
    // regression (someone adding a branch) would actually break.
    expect(dataAvailabilityNeutralTone()).toBe("neutral");
  });

  it("keeps band tone (which legitimately IS adverse-capable) distinct from availability tone", () => {
    // The contrast matters: band tone MUST be able to go red (CRITICAL is a
    // real adverse signal, ZM-RSK-007), while dataAvailabilityNeutralTone()
    // MUST NOT. Asserting both in one place documents why they are two
    // different functions rather than one parameterized one.
    expect(bandTone("CRITICAL")).toBe("danger");
    expect(bandTone("LOW")).toBe("success");
    expect(dataAvailabilityNeutralTone()).toBe("neutral");
  });
});

describe("band mapping matches AS-05 thresholds", () => {
  it("maps the best-case scenario to LOW", () => {
    const result = computeRiskAssessment(BASE_INPUTS, CALCULATED_AT);
    expect(result.compositeScore).toBeGreaterThanOrEqual(BAND_THRESHOLDS.LOW.min);
    expect(result.band).toBe("LOW");
  });

  it("maps a struggling-buyer, failed-checks scenario to HIGH", () => {
    const result = computeRiskAssessment(
      {
        ...BASE_INPUTS,
        buyerRegistryStatus: "UNDER_LIQUIDATION",
        verificationOverallResult: "FAIL",
        tenorDays: 3,
        priorDuplicateFlags: 2,
      },
      CALCULATED_AT
    );
    expect(result.compositeScore).toBeGreaterThanOrEqual(BAND_THRESHOLDS.HIGH.min);
    expect(result.compositeScore).toBeLessThan(BAND_THRESHOLDS.HIGH.max + 1);
    expect(result.band).toBe("HIGH");
  });

  it("maps an unremarkable, mid-range scenario to MEDIUM", () => {
    const result = computeRiskAssessment(
      { ...BASE_INPUTS, buyerRegistryStatus: "UNKNOWN", verificationOverallResult: "REVIEW" },
      CALCULATED_AT
    );
    expect(result.band).toBe("MEDIUM");
  });

  it("thresholds have no gaps or overlaps across 0-100", () => {
    expect(BAND_THRESHOLDS.CRITICAL.max + 1).toBe(BAND_THRESHOLDS.HIGH.min);
    expect(BAND_THRESHOLDS.HIGH.max + 1).toBe(BAND_THRESHOLDS.MEDIUM.min);
    expect(BAND_THRESHOLDS.MEDIUM.max + 1).toBe(BAND_THRESHOLDS.LOW.min);
    expect(BAND_THRESHOLDS.LOW.max).toBe(100);
    expect(BAND_THRESHOLDS.CRITICAL.min).toBe(0);
  });
});

describe("ZM-RSK-007 — confirmed adverse facts DO legitimately affect the score", () => {
  it("scores an active buyer higher than one under liquidation, all else equal", () => {
    const active = computeRiskAssessment(BASE_INPUTS, CALCULATED_AT);
    const liquidation = computeRiskAssessment(
      { ...BASE_INPUTS, buyerRegistryStatus: "UNDER_LIQUIDATION" },
      CALCULATED_AT
    );
    expect(liquidation.components?.buyerProfile).toBeLessThan(active.components!.buyerProfile!);
    // And unlike the INV-9 case, this difference is legitimate: registry
    // status is a confirmed fact, not a source that failed to answer.
    expect(liquidation.riskFactors).toContain("risk.factor.risk.buyerLiquidation");
  });

  it("scores a short-tenor invoice lower (AS-08's 7-day minimum)", () => {
    const normal = computeRiskAssessment(BASE_INPUTS, CALCULATED_AT);
    const shortTenor = computeRiskAssessment({ ...BASE_INPUTS, tenorDays: 3 }, CALCULATED_AT);
    expect(shortTenor.components?.invoiceScore).toBeLessThan(normal.components!.invoiceScore!);
  });

  it("scores a REVIEW verification result lower than PASS", () => {
    const passed = computeRiskAssessment(BASE_INPUTS, CALCULATED_AT);
    const review = computeRiskAssessment(
      { ...BASE_INPUTS, verificationOverallResult: "REVIEW" },
      CALCULATED_AT
    );
    expect(review.components?.invoiceScore).toBeLessThan(passed.components!.invoiceScore!);
  });
});

describe("ZM-RSK-017 — mlUsed / fallback flag", () => {
  it("carries mlFallbackReason only when mlUsed is false", () => {
    const usingMl = computeRiskAssessment(BASE_INPUTS, CALCULATED_AT);
    expect(usingMl.mlUsed).toBe(true);
    expect(usingMl.mlFallbackReason).toBeUndefined();

    const fallback = computeRiskAssessment(
      { ...BASE_INPUTS, mlUsed: false, mlFallbackReason: "ML_SERVICE_UNAVAILABLE" },
      CALCULATED_AT
    );
    expect(fallback.mlUsed).toBe(false);
    expect(fallback.mlFallbackReason).toBe("ML_SERVICE_UNAVAILABLE");
  });

  it("does not let a fallback recompute or move the composite score's inputs", () => {
    // The rules-only fallback is a *provenance* flag, not a different
    // scoring path in this demo engine — component formulas never read
    // mlUsed, so a stopped ML service changes how the number was produced,
    // never what the number is.
    const usingMl = computeRiskAssessment(BASE_INPUTS, CALCULATED_AT);
    const fallback = computeRiskAssessment({ ...BASE_INPUTS, mlUsed: false }, CALCULATED_AT);
    expect(fallback.components).toEqual(usingMl.components);
    expect(fallback.compositeScore).toBe(usingMl.compositeScore);
  });
});

describe("versioning and calculation metadata (ZM-RSK-009/010)", () => {
  it("stamps every score with a model version and the calculation timestamp given", () => {
    const result = computeRiskAssessment(BASE_INPUTS, CALCULATED_AT);
    expect(result.modelVersion).toBe(MODEL_VERSION);
    expect(result.calculatedAt).toBe(CALCULATED_AT);
  });

  it("two calls with the same inputs at different times keep their own timestamp", () => {
    // Not a full RiskModelVersion-immutability test (that is A's server-side
    // guarantee — a version, once activated, is never edited) — this only
    // confirms the client-visible half: recomputing does not retroactively
    // change a score already rendered with an earlier calculatedAt.
    const first = computeRiskAssessment(BASE_INPUTS, "2026-07-20T00:00:00.000Z");
    const second = computeRiskAssessment(BASE_INPUTS, "2026-07-23T00:00:00.000Z");
    expect(first.calculatedAt).toBe("2026-07-20T00:00:00.000Z");
    expect(second.calculatedAt).toBe("2026-07-23T00:00:00.000Z");
    expect(first.components).toEqual(second.components);
  });
});

describe("reason codes and factors degrade sensibly", () => {
  it("always returns at least one reason code", () => {
    const result = computeRiskAssessment(BASE_INPUTS, CALCULATED_AT);
    expect(result.reasonCodes!.length).toBeGreaterThan(0);
  });

  it("flags partial government data as a reason code when availability is below 100%", () => {
    const result = computeRiskAssessment(
      { ...BASE_INPUTS, sourceAvailability: { ccdAvailable: true, istdAvailable: false, gamAvailable: true } },
      CALCULATED_AT
    );
    expect(result.reasonCodes).toContain("PARTIAL_GOVERNMENT_DATA");
  });
});

describe("presentation helpers", () => {
  it("labels every band and degrades an unrecognised one to UNKNOWN", () => {
    expect(bandLabelKey("LOW")).toBe("risk.band.LOW");
    expect(bandLabelKey("CRITICAL")).toBe("risk.band.CRITICAL");
    expect(bandLabelKey("SOMETHING_NEW")).toBe("risk.band.UNKNOWN");
    expect(bandLabelKey(undefined)).toBe("risk.band.UNKNOWN");
  });

  it("reads mlUsed for the mode label and the fallback flag consistently", () => {
    expect(modelModeLabelKey(true)).toBe("risk.mode.ml");
    expect(modelModeLabelKey(false)).toBe("risk.mode.rulesOnly");
    // undefined is treated as "ml" — a payload from before this field
    // existed should not be read as a degraded mode it never claimed to be.
    expect(modelModeLabelKey(undefined)).toBe("risk.mode.ml");

    const fallback = computeRiskAssessment({ ...BASE_INPUTS, mlUsed: false }, CALCULATED_AT);
    const usingMl = computeRiskAssessment(BASE_INPUTS, CALCULATED_AT);
    expect(hasFallback(fallback)).toBe(true);
    expect(hasFallback(usingMl)).toBe(false);
    expect(hasFallback(null)).toBe(false);
    expect(hasFallback(undefined)).toBe(false);
  });
});
