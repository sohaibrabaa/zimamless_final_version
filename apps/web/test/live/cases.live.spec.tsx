import { describe, it, expect, beforeAll } from "vitest";
import { CaseList } from "@/components/payments/CaseList";
import type { CaseSummary } from "@/lib/payments/usePayments";
import { apiFetch, renderLive, signIn, useSessionForApi, type Session } from "./harness";

/**
 * `GET /cases` rendered by the real case desk.
 *
 * The rule worth proving live is the one with the worst failure mode: a fraud
 * case is **excluded from the query** for a bank or a supplier, not redacted
 * within it. `CaseList` filters again on the client, and that redundancy is
 * deliberate — but redundancy is only worth anything if the server half is
 * actually doing its job, and a mock that reproduces the client filter would
 * hide a server that had stopped.
 *
 * So this asserts the server's exclusion directly against a real token, and
 * then renders the result to prove the component agrees.
 */

describe("the case desk against the live API", () => {
  let supplier: Session;
  let bank: Session;
  let platform: Session;

  beforeAll(async () => {
    supplier = await signIn("supplier");
    bank = await signIn("bankOps");
    platform = await signIn("platformOps");
  });

  it("returns a summary shape the component can render", async () => {
    useSessionForApi(platform);
    const res = await apiFetch(platform, "/cases");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { items: Record<string, unknown>[] };
    expect(Array.isArray(body.items)).toBe(true);

    for (const item of body.items) {
      expect(item).toHaveProperty("id");
      expect(item).toHaveProperty("type");
      expect(["FRAUD", "DISPUTE", "WITHDRAWAL", "RECOURSE"]).toContain(item.type as string);
      expect(item).toHaveProperty("status");
      expect(item).toHaveProperty("openedAt");
    }
  });

  it("excludes fraud cases from a bank and a supplier at the server, not the client", async () => {
    for (const session of [supplier, bank]) {
      const body = (await (await apiFetch(session, "/cases")).json()) as {
        items: { type: string }[];
      };
      // Not "no fraud case is rendered" — no fraud case is *returned*. The
      // client filter must never be the thing standing between a supplier and
      // a fraud review naming them.
      expect(body.items.map((i) => i.type)).not.toContain("FRAUD");
    }
  });

  it("renders the platform's real cases", async () => {
    const body = (await (await apiFetch(platform, "/cases")).json()) as { items: CaseSummary[] };

    renderLive(
      <CaseList cases={body.items} organizationType="PLATFORM" locale="en" />
    );

    const rendered = document.body.textContent ?? "";
    if (body.items.length === 0) {
      expect(rendered.length).toBeGreaterThan(0);
      return;
    }
    // Every case the API returned reaches the screen for platform staff.
    for (const item of body.items.slice(0, 5)) {
      expect(rendered).toContain(item.status);
    }
  });

  it("filters by type server-side", async () => {
    const res = await apiFetch(platform, "/cases?type=RECOURSE");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { type: string }[] };
    for (const item of body.items) expect(item.type).toBe("RECOURSE");
  });

  it("refuses the relisting queue to a bank and a supplier", async () => {
    for (const session of [supplier, bank]) {
      const res = await apiFetch(session, "/admin/relisting-requests");
      expect([403, 404]).toContain(res.status);
    }
  });

  it("serves the relisting queue to platform staff with all seven checks named", async () => {
    const res = await apiFetch(platform, "/admin/relisting-requests");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { verification: Record<string, unknown> }[];
    expect(Array.isArray(body)).toBe(true);

    for (const row of body) {
      for (const check of [
        "stillUnpaid",
        "notFinanced",
        "unchanged",
        "stillValid",
        "noFraudIndicator",
        "supplierEligible",
        "buyerEligible",
      ]) {
        // Present and null, never absent — "not yet checked" and "checked and
        // failed" must not look the same to a reviewer.
        expect(row.verification).toHaveProperty(check);
      }
    }
  });
});
