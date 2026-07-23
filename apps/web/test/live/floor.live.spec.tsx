import { describe, it, expect, beforeAll } from "vitest";
import { apiFetch, signIn, type Session } from "./harness";

/**
 * **INV-8 — `minimumAcceptableAmount` never reaches a bank.** Live, over a
 * real bank token, against every endpoint a bank can reach.
 *
 * This is the invariant with the worst consequence in the product. The floor
 * is the least a supplier will accept; a bank that learns it will offer
 * exactly that and never a dinar more, and the supplier loses the spread on
 * every deal it ever does on this platform. It is enforced in four places —
 * an explicit allow-list in the API, a column-level `REVOKE` on the RLS grant
 * (D-02), a redaction list in the logger and the audit writer — and none of
 * those is what a bank actually receives.
 *
 * What a bank actually receives is what this asserts: the whole response body,
 * recursively, from a real server, for a real bank user. A mock cannot leak
 * something it was never given, so no mock-based test can prove this at all.
 */

/** Recursive search — the floor could hide in a nested object or an array. */
function findFloorKeys(value: unknown, path = "$"): string[] {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => findFloorKeys(v, `${path}[${i}]`));
  }
  const found: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const lowered = key.toLowerCase();
    if (lowered.includes("minimumacceptable") || lowered.includes("minimum_acceptable")) {
      found.push(`${path}.${key}`);
    }
    found.push(...findFloorKeys(child, `${path}.${key}`));
  }
  return found;
}

describe("INV-8 — the floor never reaches a bank, live", () => {
  let bankMaker: Session;
  let bankOps: Session;
  let supplier: Session;

  beforeAll(async () => {
    bankMaker = await signIn("bankMaker");
    bankOps = await signIn("bankOps");
    supplier = await signIn("supplier");
  });

  it("keeps it out of the marketplace feed and every listing a bank can open", async () => {
    const feed = await apiFetch(bankMaker, "/marketplace/eligible?page=1&pageSize=50");
    expect(feed.status).toBe(200);
    const body = (await feed.json()) as { items: { id: string }[] };

    expect(findFloorKeys(body)).toEqual([]);

    // And then each listing the feed offered, opened individually.
    for (const item of body.items.slice(0, 5)) {
      const detail = await apiFetch(bankMaker, `/marketplace/listings/${item.id}`);
      if (detail.status !== 200) continue;
      expect(findFloorKeys(await detail.json())).toEqual([]);
    }
  });

  it("keeps it out of every transaction a bank can read", async () => {
    const list = await apiFetch(bankOps, "/transactions?page=1&pageSize=25");
    expect(list.status).toBe(200);
    const body = (await list.json()) as { items: { id: string }[] };

    expect(findFloorKeys(body)).toEqual([]);

    for (const item of body.items.slice(0, 5)) {
      const detail = await apiFetch(bankOps, `/transactions/${item.id}`);
      if (detail.status !== 200) continue;
      expect(findFloorKeys(await detail.json())).toEqual([]);
    }
  });

  it("keeps it out of the offers a bank can see", async () => {
    const offers = await apiFetch(bankMaker, "/offers");
    if (offers.status === 200) expect(findFloorKeys(await offers.json())).toEqual([]);
  });

  it("still shows it to the supplier that set it — the rule is directional", async () => {
    // The mirror assertion matters. A response that omitted the floor from
    // *everyone* would pass every test above while breaking the screen where
    // a supplier reviews the figure it chose.
    const listRes = await apiFetch(supplier, "/transactions?pageSize=25");
    expect(listRes.status, "the supplier transaction list must return 200").toBe(200);
    const list = (await listRes.json()) as { items: { id: string }[] };
    expect(Array.isArray(list.items)).toBe(true);

    let sawFloorSomewhere = false;
    for (const item of list.items.slice(0, 10)) {
      const detail = await apiFetch(supplier, `/transactions/${item.id}`);
      if (detail.status !== 200) continue;
      if (findFloorKeys(await detail.json()).length > 0) {
        sawFloorSomewhere = true;
        break;
      }
    }
    expect(sawFloorSomewhere).toBe(true);
  });
});
