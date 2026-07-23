import { describe, it, expect, beforeAll } from "vitest";
import { waitFor } from "@testing-library/react";
import { NotificationInbox } from "@/components/payments/NotificationInbox";
import { CaseList } from "@/components/payments/CaseList";
import type { CaseSummary } from "@/lib/payments/usePayments";
import { apiFetch, renderLive, signIn, useSessionForApi, type Session } from "./harness";

/**
 * The Arabic pass, at screen level (9.5, ZM-I18N).
 *
 * Key parity (802 keys EN/AR) is proved hermetically; what it cannot prove
 * is that real screens over real data render Arabic — that no code path
 * falls back to a raw dictionary key, and no component hardcodes English
 * around live payloads. So the same components the earlier live specs
 * proved in English render here under the Arabic dictionary, over the same
 * live API, and the assertions are the leak patterns: key-shaped tokens
 * (`a.b.c`) in visible text, and Arabic actually present rather than the
 * page silently staying English.
 *
 * What this deliberately does NOT assert: prose quality and bidi layout.
 * Those need eyes (the runbook's manual walkthrough); a regex cannot tell
 * good Arabic from bad, only absent Arabic from present.
 */

const KEY_SHAPED = /\b[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*\.[a-zA-Z.]+\b/;
const ARABIC = /[؀-ۿ]/;

describe("the demo screens under the Arabic dictionary, live", () => {
  let supplier: Session;
  let platform: Session;

  beforeAll(async () => {
    supplier = await signIn("supplier");
    platform = await signIn("platformOps");
  });

  it("renders the real inbox in Arabic with no raw keys", async () => {
    useSessionForApi(supplier, "ar");

    renderLive(<NotificationInbox />, "ar");
    await waitFor(
      () => {
        expect(document.body.textContent?.length ?? 0).toBeGreaterThan(20);
      },
      { timeout: 30_000 }
    );
    // Give the fetch a beat to settle rows.
    await waitFor(
      () => {
        const text = document.body.textContent ?? "";
        expect(ARABIC.test(text), "no Arabic rendered at all").toBe(true);
      },
      { timeout: 30_000 }
    );

    const text = document.body.textContent ?? "";
    const leak = text.match(KEY_SHAPED);
    expect(leak, `raw dictionary key leaked: ${leak?.[0]}`).toBeNull();
  });

  it("renders the platform case desk in Arabic with no raw keys", async () => {
    useSessionForApi(platform, "ar");
    const body = (await (await apiFetch(platform, "/cases")).json()) as { items: CaseSummary[] };

    renderLive(<CaseList cases={body.items} organizationType="PLATFORM" locale="ar" />, "ar");

    const text = document.body.textContent ?? "";
    expect(ARABIC.test(text), "no Arabic rendered at all").toBe(true);
    const leak = text.match(KEY_SHAPED);
    expect(leak, `raw dictionary key leaked: ${leak?.[0]}`).toBeNull();
  });
});
