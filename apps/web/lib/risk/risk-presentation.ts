import type { components } from "@/lib/api/generated/schema";
import type { BadgeTone } from "@/components/ui/Badge";

export type RiskAssessment = components["schemas"]["RiskAssessment"];
export type RiskBand = NonNullable<RiskAssessment["band"]>;
export type RiskComponents = NonNullable<RiskAssessment["components"]>;

/**
 * Presentation rules for the Trust Score (requirements §9, brief §"Phase 5 —
 * Bank portal" risk block, phase file B tasks).
 *
 * The one rule this whole module exists to protect is ZM-RSK-005/006/008:
 * a government outage or an unpublished field **never** reduces the score —
 * it reduces `dataAvailabilityPct`, which is a **separate measure** with its
 * own presentation. `dataAvailabilityPct` is intentionally never given a
 * "tone" function that returns `danger` or `warning` — there is no such
 * function in this file, and that absence is the point. A low number there
 * means "we don't know", not "this is bad", and the UI must not conflate the
 * two the way it conflates them for every other metric on the page.
 */

const BAND_ORDER: Record<RiskBand, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

/**
 * AS-05 thresholds, restated here only for a client-side sanity check in
 * tests — the server is the source of truth for the band, never recomputed
 * client-side and never used to override what the API sent.
 */
export const BAND_THRESHOLDS: Record<RiskBand, { min: number; max: number }> = {
  LOW: { min: 75, max: 100 },
  MEDIUM: { min: 50, max: 74 },
  HIGH: { min: 25, max: 49 },
  CRITICAL: { min: 0, max: 24 },
};

/**
 * Band tone. LOW risk reads positive, CRITICAL reads adverse — this is the
 * one place on this screen where an adverse tone is correct, because a risk
 * band is exactly what it says it is, unlike `dataAvailabilityPct`.
 */
export function bandTone(band: string | undefined): BadgeTone {
  switch (band) {
    case "LOW":
      return "success";
    case "MEDIUM":
      return "info";
    case "HIGH":
      return "warning";
    case "CRITICAL":
      return "danger";
    default:
      return "neutral";
  }
}

export function bandLabelKey(band: string | undefined): string {
  return band && band in BAND_ORDER ? `risk.band.${band}` : "risk.band.UNKNOWN";
}

/** The five §9.2 components, in the table's own order. */
export const COMPONENT_KEYS = [
  "supplierVerification",
  "dataConfidence",
  "buyerProfile",
  "invoiceScore",
  "platformBehavior",
] as const;

export type ComponentKey = (typeof COMPONENT_KEYS)[number];

export function componentLabelKey(key: ComponentKey): string {
  return `risk.component.${key}`;
}

/**
 * `dataAvailabilityPct` presentation. Deliberately the only export in this
 * module with "neutral" baked into its name and its return type — there is
 * no path through this function that returns a warning-shaped value,
 * regardless of how low the percentage is. §9.3 requires exactly this: the
 * measure exists so a bank can see when data is thin, not so the UI can
 * punish the supplier for a registry being down.
 */
export function dataAvailabilityNeutralTone(): "neutral" {
  return "neutral";
}

export function dataAvailabilityLabel(pct: number | undefined): string {
  return typeof pct === "number" ? `${Math.round(pct)}%` : "—";
}

/**
 * `mlUsed` / fallback presentation (ZM-RSK-017). A fallback to rules-only
 * scoring is a **visibly flagged degraded mode**, not a hidden implementation
 * detail and not an error — the score is still usable, just produced
 * differently, and the UI says so plainly rather than alarmingly.
 */
export function modelModeLabelKey(mlUsed: boolean | undefined): string {
  return mlUsed === false ? "risk.mode.rulesOnly" : "risk.mode.ml";
}

export function hasFallback(assessment: RiskAssessment | null | undefined): boolean {
  return assessment?.mlUsed === false;
}
