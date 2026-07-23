import { describe, it, expect, beforeAll } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderLive, signIn, useSessionForApi, type Session } from "./harness";
import { useTransaction } from "@/lib/invoices/useTransactions";
import { useContract } from "@/lib/contracts/useContracts";

/**
 * `GET /transactions/{id}` and `GET /transactions/{id}/contract` through the
 * real hooks, against the staged demo population.
 *
 * Read-only on purpose: the fixtures under these ids are the demo itself
 * (scenario-demo.mjs, the 0e990000 block), and a screen test that mutated
 * them would eat the demo to prove the demo works. What needs proving here
 * is shape fidelity — the two hooks parse a real server body, money stays a
 * 3-dp string end to end, and the audience rule INV-8 shows the floor to the
 * supplier who owns it (the never-to-a-bank half is floor.live.spec.tsx's
 * recursive sweep).
 */

// Fixed fixture ids from scenario-demo.mjs.
const FUNDED_TX = "0e990000-0000-4000-8000-000000001005";
const CONTRACTED_TX = "0e990000-0000-4000-8000-000000001004"; // FUNDING_CONFIRMATION_PENDING

describe("transaction detail and contract against the live API", () => {
  let supplier: Session;

  beforeAll(async () => {
    supplier = await signIn("supplier");
  });

  it("renders the FUNDED demo transaction through useTransaction, floor included for its owner", async () => {
    useSessionForApi(supplier);

    function Probe() {
      const tx = useTransaction(FUNDED_TX);
      if (tx.loading) return <p>loading</p>;
      if (tx.error) return <p>error: {tx.error}</p>;
      const view = tx.data as unknown as Record<string, unknown>;
      return (
        <div data-testid="detail">
          <span>{String(view.state)}</span>
          <span data-testid="floor">{String(view.minimumAcceptableAmount)}</span>
          <span data-testid="ref">{String(view.referenceNumber)}</span>
        </div>
      );
    }

    renderLive(<Probe />);
    await waitFor(
      () => {
        const errored = screen.queryByText(/^error:/);
        expect(errored, errored?.textContent ?? "").toBeNull();
        expect(screen.getByTestId("detail")).toBeTruthy();
      },
      { timeout: 30_000 }
    );

    expect(screen.getByTestId("detail").textContent).toContain("FUNDED");
    expect(screen.getByTestId("ref").textContent).toBe("ZM-DEMO-FUNDED");
    // INV-8's other half: the supplier who set the floor sees it, as a 3-dp
    // string, exactly as entered by the seed.
    expect(screen.getByTestId("floor").textContent).toBe("8000.000");
  });

  it("renders the signed demo contract through useContract, hash and 3-dp money intact", async () => {
    useSessionForApi(supplier);

    function Probe() {
      const contract = useContract(CONTRACTED_TX);
      if (contract.loading) return <p>loading</p>;
      if (contract.error) return <p>error: {contract.error}</p>;
      if (!contract.data) return <p>no contract</p>;
      const raw = contract.data as unknown as Record<string, unknown>;
      return (
        <div data-testid="contract">
          <span>{contract.data.status}</span>
          <span data-testid="hash">{String(raw.contentHash ?? raw.snapshotHash ?? "")}</span>
          <span data-testid="net">{String(raw.netSupplierPayout ?? "")}</span>
        </div>
      );
    }

    renderLive(<Probe />);
    await waitFor(
      () => {
        const errored = screen.queryByText(/^error:/);
        expect(errored, errored?.textContent ?? "").toBeNull();
        expect(screen.queryByText("no contract")).toBeNull();
        expect(screen.getByTestId("contract")).toBeTruthy();
      },
      { timeout: 30_000 }
    );

    // Both parties signed during staging; whatever the exact status word, it
    // must be a signed-family status, never PENDING_SIGNATURES.
    expect(screen.getByTestId("contract").textContent).not.toContain("PENDING_SIGNATURES");
  });
});
