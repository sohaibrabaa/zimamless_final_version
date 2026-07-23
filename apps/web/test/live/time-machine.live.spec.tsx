import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { TimeMachineControl } from "@/components/dev/TimeMachineControl";
import { apiFetch, renderLive, signIn, useSessionForApi, type Session } from "./harness";

/**
 * `POST /demo/time-travel` through the real platform-settings control.
 *
 * What the screen test proves is the wiring: the control speaks to the real
 * endpoint as a real platform admin, surfaces the disarmed 404 honestly, and
 * renders the armed response's offset and effective date. What it must NOT do
 * is actually move the shared clock: the demo population staged by
 * scenario-demo.mjs lives in this same database, its OPEN listing's offer
 * window follows the platform's real deadline settings, and a jump of even
 * one day here would let the deadline sweep close it mid-test. The armed
 * exercise therefore travels **zero days** — a real 2xx through the whole
 * stack that changes nothing. Proving a forward jump drives the maturity
 * sweep is phase9-demo.integration's job, with fixtures of its own.
 */

async function setArmed(platform: Session, on: boolean): Promise<void> {
  const res = await apiFetch(platform, "/admin/settings", {
    method: "PATCH",
    body: JSON.stringify({ demo_time_machine_enabled: on }),
  });
  if (!res.ok) throw new Error(`arming(${on}) failed: ${res.status} ${await res.text()}`);
}

describe("the demo time machine control against the live API", () => {
  let platform: Session;

  beforeAll(async () => {
    platform = await signIn("platformOps");
  });

  afterAll(async () => {
    // Never leave the machine armed behind a test run.
    await setArmed(platform, false).catch(() => undefined);
  });

  it("surfaces the disarmed state as 'not armed', not as success", async () => {
    await setArmed(platform, false);
    useSessionForApi(platform);

    renderLive(<TimeMachineControl />);
    fireEvent.click(screen.getByRole("button", { name: /advance clock/i }));

    await waitFor(
      () => {
        expect(screen.getByText(/not armed/i)).toBeTruthy();
      },
      { timeout: 30_000 }
    );
  });

  it("renders the armed response's offset and effective date on a zero-day jump", async () => {
    await setArmed(platform, true);
    useSessionForApi(platform);

    try {
      renderLive(<TimeMachineControl />);
      fireEvent.click(screen.getByRole("button", { name: /back to real time/i }));

      await waitFor(
        () => {
          // The state line comes from the server's response body, not local
          // assumption: offsetDays 0 and today's effective date.
          expect(screen.getByText(/clock is at real time \(\d{4}-\d{2}-\d{2}\)/i)).toBeTruthy();
        },
        { timeout: 30_000 }
      );
      expect(screen.queryByText(/not armed|could not move/i)).toBeNull();
    } finally {
      await setArmed(platform, false);
    }
  });
});
