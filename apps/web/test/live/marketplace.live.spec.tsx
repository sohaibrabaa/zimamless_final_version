import { describe, it, expect, beforeAll, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import en from "@/messages/en.json";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { I18nProvider } from "@/lib/i18n/dictionary-context";
import { apiFetch, signIn, type Session } from "./harness";

/**
 * The bank marketplace feed, through the real hook and the real session.
 *
 * `GET /marketplace/eligible` is the one read in the product whose *contents*
 * are an authorization decision rather than a filter: a listing appears only
 * if this bank's own policy filters made it eligible (ZM-MKT-002), and that is
 * computed by a join, not by fetching everything and hiding some. A mock
 * returning a fixed feed cannot tell the difference between those two, and the
 * difference is whether a bank sees deals it was excluded from.
 *
 * As in the transactions spec, only the Supabase browser SDK is substituted,
 * and it is handed a real token.
 */

let liveToken = "";

vi.mock("@/lib/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: async () => ({
        data: { session: { access_token: liveToken, user: { id: "live" } } },
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      signOut: async () => ({ error: null }),
    },
  },
}));

vi.mock("@/lib/mocks/persona-store", () => ({ getStoredPersona: () => null }));

describe("the bank marketplace against the live API", () => {
  let bankMaker: Session;

  beforeAll(async () => {
    bankMaker = await signIn("bankMaker");
    liveToken = bankMaker.token;
  });

  it("returns an eligible-listings envelope the feed can render", async () => {
    const res = await apiFetch(bankMaker, "/marketplace/eligible?page=1&pageSize=20");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      items: Record<string, unknown>[];
      pagination: Record<string, unknown>;
    };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.pagination).toHaveProperty("total");

    for (const item of body.items) {
      // `listingId`, not `id` — the feed row is a listing-plus-context view,
      // not a listing entity, and it carries `transactionId` too. Worth
      // pinning: the first version of this test assumed `id`, and the render
      // below happily produced a list of `undefined` React keys without
      // failing, which is exactly the kind of quiet mismatch a mock hides.
      expect(typeof item.listingId).toBe("string");
      expect(item).toHaveProperty("transactionId");
      // Never a competitor count, and never the floor (INV-8, covered
      // exhaustively in floor.live.spec.tsx).
      expect(item).not.toHaveProperty("offerCount");
      expect(item).not.toHaveProperty("minimumAcceptableAmount");
      // INV-11: a bank sees its OWN offer or nothing — never a competitor's.
      const myOffer = item.myOffer as Record<string, unknown> | null;
      if (myOffer) expect(myOffer).not.toHaveProperty("bankOrgId");
    }
  });

  it("renders the real feed through useEligibleListings inside the real session", async () => {
    const { SessionProvider } = await import("@/lib/session/SessionProvider");
    const { useEligibleListings } = await import("@/lib/marketplace/useMarketplace");

    function Probe() {
      const feed = useEligibleListings(1, 20);
      if (feed.error) return <p>error: {feed.error}</p>;
      if (feed.loading || !feed.data) return <p>loading</p>;
      return (
        <div>
          <p data-testid="count">{feed.data.items.length}</p>
          <ul>
            {feed.data.items.map((l) => (
              <li key={l.listingId} data-testid="listing">
                {l.listingId}
              </li>
            ))}
          </ul>
        </div>
      );
    }

    render(
      <I18nProvider locale="en" dictionary={en as unknown as Dictionary}>
        <SessionProvider locale="en">
          <Probe />
        </SessionProvider>
      </I18nProvider>
    );

    // Waits for the resolved state, not for "loading" to clear — the hook is
    // disabled until the provider derives an active organization, and a
    // disabled resource is also not loading.
    await waitFor(
      () => {
        const errored = screen.queryByText(/^error:/);
        expect(errored, errored?.textContent ?? "").toBeNull();
        expect(screen.queryByTestId("count")).not.toBeNull();
      },
      { timeout: 40_000 }
    );

    // An empty feed is a legitimate outcome — it means this bank's policy
    // filters excluded everything currently open. Asserting a non-zero count
    // would make the test a hostage to seed drift and to a real eligibility
    // rule doing its job.
    //
    // Compared as text rather than coerced with Number(): the money lint rule
    // bans that coercion outright, and it is right to be blunt about it even
    // where the value is a row count. The rendered rows below are the numeric
    // check.
    expect(screen.getByTestId("count").textContent).toMatch(/^\d+$/);
    expect(screen.getByTestId("count").textContent).toBe(
      String(screen.queryAllByTestId("listing").length)
    );

    // Whatever did render carries a real id. Without this the test passes on a
    // list of blanks, which is how the `id`/`listingId` mismatch survived the
    // first run.
    for (const row of screen.queryAllByTestId("listing")) {
      expect(row.textContent).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("refuses the feed to a supplier", async () => {
    const supplier = await signIn("supplier");
    const res = await apiFetch(supplier, "/marketplace/eligible");
    expect([403, 404]).toContain(res.status);
  });
});
