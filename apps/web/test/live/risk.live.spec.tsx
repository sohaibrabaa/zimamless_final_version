import { describe, it, expect, beforeAll } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderLive, signIn, useSessionForApi, type Session } from "./harness";
import { useRiskAssessment } from "@/lib/risk/useRiskAssessment";

/**
 * `GET /transactions/{id}/risk` through the real hook, against the staged
 * MATURING fixture (funded due +8, scored 86 LOW at staging).
 *
 * Two rules are the ones worth reading off a live body. ZM-RSK-013: a bank
 * (or anyone) receives scores, bands and factor codes — never weights, never
 * coefficients, never the model's raw probability; the supplier body is
 * checked here for the same absence, since a field the allow-list leaks to
 * one audience is one refactor away from leaking to the other. And
 * ZM-RSK-005/006: `dataAvailabilityPct` is reported beside the score, not
 * inside it — the exact separation the government-downtime invariant
 * requires the screen to render.
 */

const MATURING_TX = "0e990000-0000-4000-8000-000000001010";

describe("the trust score against the live API", () => {
  let supplier: Session;

  beforeAll(async () => {
    supplier = await signIn("supplier");
  });

  it("renders the stored staging-time assessment with band, factors and availability", async () => {
    useSessionForApi(supplier);

    let raw: Record<string, unknown> | null = null;

    function Probe() {
      const risk = useRiskAssessment(MATURING_TX);
      if (risk.loading) return <p>loading</p>;
      if (risk.error) return <p>error: {risk.error}</p>;
      raw = risk.data as unknown as Record<string, unknown>;
      return (
        <div data-testid="risk">
          {String(raw.compositeScore)} {String(raw.band)} avail:{String(raw.dataAvailabilityPct)}
        </div>
      );
    }

    renderLive(<Probe />);
    await waitFor(
      () => {
        const errored = screen.queryByText(/^error:/);
        expect(errored, errored?.textContent ?? "").toBeNull();
        expect(screen.getByTestId("risk")).toBeTruthy();
      },
      { timeout: 30_000 }
    );

    const body = raw as unknown as Record<string, unknown>;
    expect(typeof body.compositeScore).toBe("number");
    expect(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).toContain(body.band as string);
    expect(Array.isArray(body.riskFactors)).toBe(true);
    // Availability is beside the score, never inside it (ZM-RSK-005/006).
    expect(typeof body.dataAvailabilityPct).toBe("number");

    // ZM-RSK-013 — model internals never serialize, to any audience.
    const flat = JSON.stringify(body).toLowerCase();
    for (const banned of ["weight", "coefficient", "probability"]) {
      expect(flat, `response leaks '${banned}'`).not.toContain(banned);
    }
  });
});
