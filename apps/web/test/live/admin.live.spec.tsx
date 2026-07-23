import { describe, it, expect, beforeAll } from "vitest";
import { screen, waitFor, renderHook } from "@testing-library/react";
import { renderLive, signIn, useSessionForApi, type Session } from "./harness";
import {
  patchPlatformSettings,
  useAuditLogs,
  useCommissionTiers,
  usePlatformSettings,
} from "@/lib/admin/useAdmin";

/**
 * The admin surface's screens, live (9.4's frontend half).
 *
 * The audit trail is the one worth a real body: every mutation this project
 * has recorded becomes visible here, so the probe asserts actual entries
 * with action types and timestamps, filtered by a real entity id from the
 * staged demo population. Settings prove the read→edit→read round trip the
 * settings screen performs (restored afterwards — the shared database is
 * the demo), and tiers prove money stays a 3-dp string into the table.
 */

const MATURING_TX = "0e990000-0000-4000-8000-000000001010";

describe("the admin surface against the live API", () => {
  let platform: Session;

  beforeAll(async () => {
    platform = await signIn("platformOps");
  });

  it("renders real audit entries and filters by entity id server-side", async () => {
    useSessionForApi(platform);

    let filtered: { items: { targetEntityId?: string }[] } | null = null;

    function Probe() {
      const logs = useAuditLogs(1, 10, MATURING_TX);
      if (logs.loading) return <p>loading</p>;
      if (logs.error) return <p>error: {logs.error}</p>;
      filtered = logs.data;
      return (
        <ul>
          {(logs.data?.items ?? []).map((row) => (
            <li key={row.id} data-testid="entry">
              {row.actionType} {row.occurredAt}
            </li>
          ))}
        </ul>
      );
    }

    renderLive(<Probe />);
    await waitFor(
      () => {
        const errored = screen.queryByText(/^error:/);
        expect(errored, errored?.textContent ?? "").toBeNull();
        expect(screen.getAllByTestId("entry").length).toBeGreaterThan(0);
      },
      { timeout: 30_000 }
    );

    // The staged fixture's audited walk is all here — and nothing else is:
    // the filter is the server's, not a client-side sieve.
    const items = filtered!.items;
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.targetEntityId).toBe(MATURING_TX);
    }
  });

  it("round-trips a settings edit and reads it back", async () => {
    useSessionForApi(platform);

    const before = renderHook(() => usePlatformSettings());
    await waitFor(() => expect(before.result.current.loading).toBe(false), { timeout: 30_000 });
    const original = before.result.current.data?.maturity_reminder_days;
    expect(Array.isArray(original)).toBe(true);

    try {
      await patchPlatformSettings({ maturity_reminder_days: [30, 14, 7, 2] });

      const after = renderHook(() => usePlatformSettings());
      await waitFor(() => expect(after.result.current.loading).toBe(false), { timeout: 30_000 });
      expect(after.result.current.data?.maturity_reminder_days).toEqual([30, 14, 7, 2]);
    } finally {
      // The shared database is the demo; leave the setting as found.
      await patchPlatformSettings({ maturity_reminder_days: original });
    }
  });

  it("renders the commission tiers with 3-dp money strings", async () => {
    useSessionForApi(platform);

    const { result } = renderHook(() => useCommissionTiers());
    await waitFor(() => expect(result.current.loading).toBe(false), { timeout: 30_000 });

    const tiers = result.current.data ?? [];
    expect(tiers.length).toBeGreaterThan(0);
    for (const tier of tiers) {
      expect(String(tier.minTransactionAmount)).toMatch(/^\d+\.\d{3}$/);
      expect(typeof tier.commissionPercentage).toBe("number");
    }
  });
});
