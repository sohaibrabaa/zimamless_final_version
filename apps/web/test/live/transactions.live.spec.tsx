import { describe, it, expect, beforeAll, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { render } from "@testing-library/react";
import en from "@/messages/en.json";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { I18nProvider } from "@/lib/i18n/dictionary-context";
import { apiFetch, signIn, type Session } from "./harness";

/**
 * `GET /auth/me` and `GET /transactions` through the real session machinery.
 *
 * The list hook reads `useSession()`, so this renders inside the real
 * `SessionProvider` rather than configuring the api client by hand. That is
 * the point: the active organization is *client* state, and the list is
 * scoped server-side by the `X-Organization-Id` header the provider derives.
 * A Phase 1 bug lived exactly there — the client derived the header from
 * `me.activeOrganizationId`, which the API only echoes back if the header was
 * already sent, so no header was ever sent and every scoped endpoint 403'd.
 * Mocks hardcoding an active org cannot see that; this can.
 *
 * Only the **Supabase browser SDK** is substituted, and it is handed a real
 * access token obtained from a real password grant. Everything downstream —
 * the header derivation, the HTTP call, the API, the database — is real.
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

describe("the session and transaction list against the live API", () => {
  let supplier: Session;

  beforeAll(async () => {
    supplier = await signIn("supplier");
    liveToken = supplier.token;
  });

  it("returns memberships /auth/me in the shape SessionProvider reads", async () => {
    const res = await apiFetch(supplier, "/auth/me");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      user: Record<string, unknown>;
      memberships: Record<string, unknown>[];
    };
    expect(body.user).toHaveProperty("id");
    expect(body.user).toHaveProperty("preferredLanguage");
    expect(body.memberships.length).toBeGreaterThan(0);
    for (const m of body.memberships) {
      expect(m).toHaveProperty("organizationId");
      expect(m).toHaveProperty("organizationType");
      expect(Array.isArray(m.roles)).toBe(true);
    }
  });

  it("echoes the active organization only when the header names a real membership", async () => {
    // The circularity that bit Phase 1: no header in, no activeOrganizationId
    // out. The client must send what it chose, not read back what it sent.
    const withHeader = (await (await apiFetch(supplier, "/auth/me")).json()) as {
      activeOrganizationId?: string;
    };
    expect(withHeader.activeOrganizationId).toBe(supplier.organizationId);

    const bare = await fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3000/v1"}/auth/me`, {
      headers: { Authorization: `Bearer ${supplier.token}` },
    });
    const noHeader = (await bare.json()) as { activeOrganizationId?: string };
    expect(noHeader.activeOrganizationId).toBeUndefined();
  });

  it("scopes the transaction list to the active organization, server-side", async () => {
    const res = await apiFetch(supplier, "/transactions?page=1&pageSize=100");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      items: Record<string, unknown>[];
      pagination: Record<string, unknown>;
    };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.pagination).toHaveProperty("total");

    for (const item of body.items) {
      expect(item).toHaveProperty("id");
      expect(item).toHaveProperty("state");
      expect(item).toHaveProperty("referenceNumber");
    }
  });

  it("renders a real transaction list through the real hook and session provider", async () => {
    // Imported lazily so the supabase mock above is installed first.
    const { SessionProvider } = await import("@/lib/session/SessionProvider");
    const { useTransactionList } = await import("@/lib/invoices/useTransactions");

    function Probe() {
      const list = useTransactionList(1, 20);
      if (list.loading) return <p>loading</p>;
      if (list.error) return <p>error: {list.error}</p>;
      return (
        <ul>
          {(list.data?.items ?? []).map((t) => (
            <li key={t.id} data-testid="row">
              {t.referenceNumber} {t.state}
            </li>
          ))}
        </ul>
      );
    }

    render(
      <I18nProvider locale="en" dictionary={en as unknown as Dictionary}>
        <SessionProvider locale="en">
          <Probe />
        </SessionProvider>
      </I18nProvider>
    );

    // Waits for rows, not for "loading" to vanish. The hook is *disabled*
    // until the provider has derived an active organization, and a disabled
    // resource is also not loading — so waiting on the loading flag alone
    // resolves during the gap before the org exists and asserts against an
    // empty list. That is what the first version of this test did, and the
    // empty <ul> it produced looked exactly like a scoping bug.
    await waitFor(
      () => {
        const errored = screen.queryByText(/^error:/);
        expect(errored, errored?.textContent ?? "").toBeNull();
        expect(screen.queryAllByTestId("row").length).toBeGreaterThan(0);
      },
      { timeout: 40_000 }
    );
  });
});
