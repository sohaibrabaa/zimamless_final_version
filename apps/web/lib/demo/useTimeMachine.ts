"use client";

import { useState } from "react";
import { apiClient, ApiError } from "@/lib/api/client";

/**
 * The demo time machine (`POST /demo/time-travel`).
 *
 * A thin client over the one endpoint. There is deliberately no GET for the
 * current offset — the contract declares only the POST — so this tracks the
 * effective date from each response and starts "unknown" until the operator
 * acts. A 404 means the machine is not armed in this environment (the env flag
 * or the platform setting is off); the control surfaces that plainly rather
 * than pretending the jump worked.
 */
export interface TimeMachineState {
  offsetDays: number;
  effectiveDate: string;
}

export function useTimeMachine() {
  const [state, setState] = useState<TimeMachineState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function travel(offsetDays: number): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const { data, error: apiError } = await apiClient.POST("/demo/time-travel", {
        body: { offsetDays },
      });
      if (apiError) throw apiError;
      const body = data as unknown as TimeMachineState;
      setState({ offsetDays: body.offsetDays, effectiveDate: body.effectiveDate });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setError("The time machine is not armed in this environment.");
      } else {
        setError(err instanceof ApiError ? err.message : "Could not move the demo clock.");
      }
    } finally {
      setBusy(false);
    }
  }

  return { state, busy, error, travel, reset: () => travel(0) };
}
