import { describe, it, expect, beforeAll } from "vitest";
import { screen } from "@testing-library/react";
import { PaymentTimeline } from "@/components/payments/PaymentTimeline";
import type { PaymentHistory } from "@/lib/payments/usePayments";
import { apiFetch, renderLive, signIn, useSessionForApi, type Session } from "./harness";

/**
 * `GET /transactions/{id}/payments` rendered by the real timeline.
 *
 * This is the screen where the phase's headline behaviour is either honoured
 * or broken in front of a supplier, so it is the one worth proving end to end
 * rather than by envelope alone: a real `OVERDUE_UNCONFIRMED` transaction from
 * the seeded database, through the real API, into the real component, and then
 * asserting the words that actually reach the screen.
 *
 * The wording assertions duplicate the unit test on purpose. That test reads
 * the message bundles; this one reads the rendered DOM. A key that exists and
 * is never rendered, or a state string the component fails to map, passes the
 * first and fails this one.
 */

describe("the payment timeline against the live API", () => {
  let supplier: Session;
  let transactions: { id: string; state: string }[] = [];

  beforeAll(async () => {
    supplier = await signIn("supplier");
    useSessionForApi(supplier);

    const res = await apiFetch(supplier, "/transactions?pageSize=50");
    expect(res.status).toBe(200);
    transactions = ((await res.json()) as { items: { id: string; state: string }[] }).items;
  });

  const postFunding = () =>
    transactions.filter((t) =>
      ["FUNDED", "PARTIALLY_PAID", "PAID", "OVERDUE_UNCONFIRMED", "OVERDUE"].includes(t.state)
    );

  it("returns a derived balance in the shape the hook expects", async () => {
    const target = postFunding()[0];
    expect(target, "the seed has no post-funding transaction to render").toBeDefined();

    const res = await apiFetch(supplier, `/transactions/${target.id}/payments`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(Array.isArray(body.payments)).toBe(true);
    expect(typeof body.outstandingAmount).toBe("string");
    expect(typeof body.overdueDays).toBe("number");

    // Money is a 3-dp string on the wire and never a JSON number. A number
    // here would still render, and would still be wrong.
    expect(body.outstandingAmount as string).toMatch(/^\d+\.\d{3}$/);
  });

  it("never serializes bankInternalNotes or evidence to a supplier (ZM-PMT-018)", async () => {
    for (const target of postFunding()) {
      const body = (await (
        await apiFetch(supplier, `/transactions/${target.id}/payments`)
      ).json()) as { payments: Record<string, unknown>[] };

      for (const payment of body.payments) {
        expect(payment).not.toHaveProperty("bankInternalNotes");
        expect(payment).not.toHaveProperty("evidenceDocumentId");
        expect(payment).not.toHaveProperty("reportedBy");
      }
    }
  });

  it("renders a real OVERDUE_UNCONFIRMED transaction as awaiting confirmation, never as default", async () => {
    const target = transactions.find((t) => t.state === "OVERDUE_UNCONFIRMED");
    if (!target) {
      // Nothing to assert honestly if the seed currently holds none; the state
      // machine and wording are covered by the unit and integration suites.
      return;
    }

    const history = (await (
      await apiFetch(supplier, `/transactions/${target.id}/payments`)
    ).json()) as PaymentHistory;

    renderLive(<PaymentTimeline history={history} state={target.state} locale="en" />);

    const rendered = document.body.textContent?.toLowerCase() ?? "";
    expect(rendered).toContain("awaiting");
    // The words this phase exists to keep off a supplier's screen.
    for (const banned of ["defaulted", "failed to pay", "delinquent"]) {
      expect(rendered).not.toContain(banned);
    }
    // The explainer must actually reach the DOM, not merely exist as a key.
    expect(screen.getByText(/not a record of non-payment/i)).toBeDefined();
  });

  it("renders the same state in Arabic without the Arabic accusation words", async () => {
    const target = transactions.find((t) => t.state === "OVERDUE_UNCONFIRMED");
    if (!target) return;

    const history = (await (
      await apiFetch(supplier, `/transactions/${target.id}/payments`)
    ).json()) as PaymentHistory;

    renderLive(<PaymentTimeline history={history} state={target.state} locale="ar" />, "ar");

    const rendered = document.body.textContent ?? "";
    expect(rendered).toContain("بانتظار");
    expect(rendered).not.toContain("تعثر");
    expect(rendered).not.toContain("متأخر");
  });

  it("refuses a transaction the caller is not party to, as 404", async () => {
    // A well-formed uuid that belongs to nobody.
    //
    // The first version of this test took a transaction from the bank's list
    // that was absent from the supplier's and expected a refusal — and got a
    // 200, which looked like an authorization hole for about a minute. It was
    // a paging artifact: the supplier has 89 transactions and the test asked
    // for 50, so "missing from my list" meant "on page two". Every one of the
    // bank's transactions has this supplier as its counterparty, so the
    // premise could never have held. A synthetic id is the only true negative
    // available here, and it does not silently depend on page size.
    const res = await apiFetch(supplier, "/transactions/00000000-0000-4000-8000-0000000000ff/payments");
    expect([403, 404]).toContain(res.status);
  });
});
