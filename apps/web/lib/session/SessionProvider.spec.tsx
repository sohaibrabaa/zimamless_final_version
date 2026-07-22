import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { render, screen, waitFor, act, cleanup } from "@testing-library/react";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";

/**
 * The active organization is client-side state, and that is the whole point
 * of these tests.
 *
 * The API keeps no per-session context: GET /auth/me only echoes an
 * X-Organization-Id the request already carried, and POST /auth/context
 * validates a choice without storing it. So if the client derives the header
 * from me.activeOrganizationId, the derivation is circular — no header is
 * ever sent, activeOrganizationId comes back absent, and every non-exempt
 * endpoint 403s. That bug is invisible against mocks that hardcode an active
 * org, which is exactly how it survived Phase 1.
 */

const API_BASE = "http://localhost:3000/v1";

const ORG_A = "0e000000-0000-4000-8000-000000000001";
const ORG_B = "0e000000-0000-4000-8000-000000000003";

const ME = {
  user: {
    id: "0e100000-0000-4000-8000-00000000000f",
    fullName: "Sara Yaseen",
    email: "multi@platform.zimmamless.test",
    preferredLanguage: "EN",
    status: "ACTIVE",
  },
  memberships: [
    {
      organizationId: ORG_A,
      organizationName: "Zimmamless Platform",
      organizationType: "PLATFORM",
      roles: ["PLATFORM_SUPPORT"],
    },
    {
      organizationId: ORG_B,
      organizationName: "Petra Industrial Supplies",
      organizationType: "SUPPLIER",
      roles: ["SUPPLIER_VIEWER"],
    },
  ],
};

/** Every X-Organization-Id the client sent, in order. */
let sentOrgHeaders: (string | null)[] = [];

const server = setupServer(
  http.get(`${API_BASE}/auth/me`, ({ request }) => {
    sentOrgHeaders.push(request.headers.get("X-Organization-Id"));
    // Faithful to the live API: echo the header back only when it names a
    // real membership, never invent an active organization.
    const supplied = request.headers.get("X-Organization-Id");
    const valid = ME.memberships.some((m) => m.organizationId === supplied);
    return HttpResponse.json({ ...ME, activeOrganizationId: valid ? supplied : undefined });
  }),
  http.post(`${API_BASE}/auth/context`, async ({ request }) => {
    const body = (await request.json()) as { organizationId: string };
    const isMember = ME.memberships.some((m) => m.organizationId === body.organizationId);
    if (!isMember) {
      return HttpResponse.json(
        { code: "ORGANIZATION_CONTEXT_INVALID", message: "Not a member.", correlationId: "c1" },
        { status: 403 }
      );
    }
    return new HttpResponse(null, { status: 200 });
  })
);

vi.mock("@/lib/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      signOut: async () => ({ error: null }),
    },
  },
}));

vi.mock("@/lib/mocks/persona-store", () => ({ getStoredPersona: () => null }));

// Start intercepting BEFORE the client module is loaded: openapi-fetch
// captures globalThis.fetch when createClient() runs at import time, so a
// listen() that happens later patches a reference nothing will ever call.
server.listen({ onUnhandledRequest: "error" });

beforeEach(() => {
  sentOrgHeaders = [];
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

// Imported after the mocks above are registered and the server is listening.
const { SessionProvider, useSession } = await import("./SessionProvider");

function Probe() {
  const { activeOrganizationId, activeMembership, switchOrganization, loading } = useSession();
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="active-org">{activeOrganizationId ?? "none"}</span>
      <span data-testid="active-org-name">{activeMembership?.organizationName ?? "none"}</span>
      <button onClick={() => void switchOrganization(ORG_B).catch(() => {})}>switch</button>
      <button onClick={() => void switchOrganization("0e000000-0000-4000-8000-0000000000ff").catch(() => {})}>
        switch-invalid
      </button>
    </div>
  );
}

function renderProvider() {
  return render(
    <SessionProvider locale="en">
      <Probe />
    </SessionProvider>
  );
}

describe("SessionProvider active organization", () => {
  it("adopts the first membership when nothing is stored", async () => {
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"));
    expect(screen.getByTestId("active-org").textContent).toBe(ORG_A);
  });

  it("sends X-Organization-Id on requests after the first load", async () => {
    // The regression under test: without locally held state the header is
    // never sent at all, so every non-exempt endpoint would 403.
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("active-org").textContent).toBe(ORG_A));

    await act(async () => {
      screen.getByText("switch").click();
    });

    await waitFor(() => expect(screen.getByTestId("active-org").textContent).toBe(ORG_B));
    // The /auth/me refetch that follows the switch must carry the NEW org.
    expect(sentOrgHeaders.at(-1)).toBe(ORG_B);
  });

  it("persists the choice across a remount", async () => {
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("active-org").textContent).toBe(ORG_A));
    await act(async () => {
      screen.getByText("switch").click();
    });
    await waitFor(() => expect(screen.getByTestId("active-org").textContent).toBe(ORG_B));

    cleanupAndRemount();
    await waitFor(() => expect(screen.getByTestId("active-org").textContent).toBe(ORG_B));
  });

  it("keeps the previous organization when the switch is refused", async () => {
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("active-org").textContent).toBe(ORG_A));

    await act(async () => {
      screen.getByText("switch-invalid").click();
    });

    // A 403 must not leave the client pointing at an org the API refuses.
    await waitFor(() => expect(screen.getByTestId("active-org").textContent).toBe(ORG_A));
  });

  it("resolves the active membership from the locally held id", async () => {
    renderProvider();
    await waitFor(() =>
      expect(screen.getByTestId("active-org-name").textContent).toBe("Zimmamless Platform")
    );
  });
});

function cleanupAndRemount() {
  // Unmount first, then mount fresh against the same localStorage — a page
  // reload, in effect.
  cleanup();
  renderProvider();
}
