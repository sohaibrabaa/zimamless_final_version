import { describe, it, expect, beforeAll } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { NotificationInbox } from "@/components/payments/NotificationInbox";
import { apiFetch, renderLive, signIn, useSessionForApi, type Session } from "./harness";

/**
 * `GET /notifications` and `POST /notifications/{id}/read`, rendered by the
 * real inbox component against the real API.
 *
 * The inbox is the right first screen to promote: it needs no fixture, every
 * seeded persona has one, and it exercises the three things most likely to
 * differ between a mock and an API — the envelope shape (`items` /
 * `unreadCount` / `pagination`), a query parameter that actually filters
 * server-side, and a mutation whose effect has to survive a refetch.
 *
 * What a mock could never have caught: the inbox is scoped by
 * `recipient_user_id` alone, with no organization filter, and the mock store
 * reproduces that from a `recipientUserId` field it assigns itself. Only a
 * real token proves the *server* scopes it the same way.
 */

describe("the notification inbox against the live API", () => {
  let supplier: Session;

  beforeAll(async () => {
    supplier = await signIn("supplier");
    useSessionForApi(supplier);
  });

  it("renders the supplier's real inbox", async () => {
    renderLive(<NotificationInbox />);

    // The heading only appears once loading resolves, so waiting for it is
    // waiting for a real 200 from a real API.
    await waitFor(
      () => expect(screen.getByRole("heading", { name: /notifications/i })).toBeDefined(),
      { timeout: 30_000 }
    );

    // Either real messages or the empty state — both are correct outcomes for
    // a live database, and asserting one specific count would make this test
    // a hostage to seed drift.
    const hasItems = screen.queryAllByRole("listitem").length > 0;
    const hasEmpty = !!screen.queryByText(/no notifications|nothing here|empty/i);
    expect(hasItems || hasEmpty).toBe(true);
  });

  it("returns the same envelope the component's types expect", async () => {
    const res = await apiFetch(supplier, "/notifications?unread=false&page=1&pageSize=20");
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    // The three fields NotificationInbox reads. A rename here is exactly the
    // class of break that both existing suites are blind to.
    expect(body).toHaveProperty("items");
    expect(body).toHaveProperty("unreadCount");
    expect(Array.isArray(body.items)).toBe(true);

    for (const item of body.items as Record<string, unknown>[]) {
      expect(item).toHaveProperty("id");
      expect(item).toHaveProperty("subject");
      expect(item).toHaveProperty("body");
      expect(item).toHaveProperty("read");
      expect(item).toHaveProperty("queuedAt");
      // The allow-list holds: an inbox is for reading messages, not auditing
      // the transport, and `destination` can carry a personal phone number.
      expect(item).not.toHaveProperty("destination");
      expect(item).not.toHaveProperty("providerReference");
      expect(item).not.toHaveProperty("manualCallNotes");
    }
  });

  it("filters unread server-side, not in the component", async () => {
    const all = await (await apiFetch(supplier, "/notifications?unread=false")).json();
    const unread = await (await apiFetch(supplier, "/notifications?unread=true")).json();

    const allItems = (all as { items: unknown[] }).items;
    const unreadItems = (unread as { items: { read: boolean }[] }).items;

    expect(unreadItems.length).toBeLessThanOrEqual(allItems.length);
    for (const item of unreadItems) expect(item.read).toBe(false);
  });

  it("marks read, and the change survives a fresh read", async () => {
    const before = (await (await apiFetch(supplier, "/notifications?unread=true")).json()) as {
      items: { id: string }[];
    };
    if (before.items.length === 0) {
      // Nothing unread is a legitimate state; there is no honest assertion to
      // make about a mutation that has no subject.
      return;
    }

    const target = before.items[0].id;
    const res = await apiFetch(supplier, `/notifications/${target}/read`, { method: "POST" });
    expect(res.status).toBe(200);

    const after = (await (await apiFetch(supplier, "/notifications?unread=true")).json()) as {
      items: { id: string }[];
    };
    expect(after.items.map((i) => i.id)).not.toContain(target);
  });

  it("refuses another user's notification with 404, not 403", async () => {
    const platform = await signIn("platformOps");
    const theirs = (await (await apiFetch(platform, "/notifications")).json()) as {
      items: { id: string }[];
    };
    if (theirs.items.length === 0) return;

    // The existence of a message addressed to someone else is not this
    // caller's business, so the refusal must not distinguish "not yours" from
    // "does not exist".
    const res = await apiFetch(supplier, `/notifications/${theirs.items[0].id}/read`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });
});
