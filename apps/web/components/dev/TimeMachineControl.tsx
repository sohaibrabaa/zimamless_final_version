"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { useTimeMachine } from "@/lib/demo/useTimeMachine";

/**
 * Platform-only demo clock control (ZM-DEMO-003/004).
 *
 * Moves the *server* clock by whole days so a judge can watch an invoice
 * mature, a reminder fire, and a confirmation stall and escalate, without
 * waiting real days. It only appears on the platform settings screen, but the
 * appearance is not the protection — the endpoint is a 404 unless the server
 * env flag and the platform setting both arm it, so hiding this control was
 * never what kept it safe (that is the requirement: hiding the UI is not
 * sufficient).
 *
 * Whole days only: sub-day demos (a 15-minute OTP) are a unit-test concern,
 * not something a live clock steps through.
 */
export function TimeMachineControl() {
  const { state, busy, error, travel, reset } = useTimeMachine();
  const [days, setDays] = useState(45);

  return (
    <section className="rounded-lg border border-dashed border-(--color-warning) bg-(--color-warning-bg) p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-(--color-warning)">Demo time machine</h2>
        <span className="text-xs text-(--color-muted)">Platform only · never available in production</span>
      </div>

      <p className="mt-2 text-sm text-(--color-fg)">
        {state
          ? state.offsetDays === 0
            ? `Clock is at real time (${state.effectiveDate}).`
            : `Clock is ${state.offsetDays} day(s) ahead — effective date ${state.effectiveDate}.`
          : "Move the whole system clock forward to demonstrate maturity and escalation."}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm">
          <span>Jump</span>
          <input
            type="number"
            step={1}
            className="w-20 rounded-md border border-(--color-border) bg-(--color-bg) px-2 py-1 text-sm"
            value={days}
            // `valueAsNumber`, not Number()/parseInt — the money lint rule bans
            // those coercions outright and is right to, even for a day count.
            // Truncated to whole days; the endpoint rejects a fractional offset
            // anyway (offsetDays is IsInt), but the input should not offer one.
            onChange={(e) =>
              setDays(Number.isNaN(e.target.valueAsNumber) ? 0 : Math.trunc(e.target.valueAsNumber))
            }
          />
          <span>days</span>
        </label>
        <Button type="button" size="sm" loading={busy} onClick={() => travel(days)}>
          Advance clock
        </Button>
        <Button type="button" size="sm" variant="secondary" loading={busy} onClick={reset}>
          Back to real time
        </Button>
      </div>

      {error && <p className="mt-2 text-sm text-(--color-danger)">{error}</p>}
    </section>
  );
}
