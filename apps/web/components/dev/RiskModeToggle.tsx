"use client";

import { useEffect, useState } from "react";
import { getStoredRiskMode, setStoredRiskMode, type RiskMode } from "@/lib/mocks/risk-mode-store";
import { Button } from "@/components/ui/Button";

const MOCKING_ENABLED = process.env.NEXT_PUBLIC_API_MOCKING !== "disabled";

/**
 * Dev-only switch for the Phase 4 checkpoint's first drill: "stop the ML
 * container → recompute → rules-only score with visible degraded flag"
 * (ZM-RSK-017). There is no ML container to stop against MSW, so this
 * flips the mock's `mlUsed` flag directly. Hidden entirely once
 * NEXT_PUBLIC_API_MOCKING=disabled, same as DevPersonaPicker.
 */
export function RiskModeToggle({ onChange }: { onChange?: () => void }) {
  const [mode, setMode] = useState<RiskMode>("ml");

  useEffect(() => {
    // Hydration: localStorage is unavailable during SSR, so the first client
    // render starts at the "ml" default and adopts the persisted choice here
    // — same pattern as SessionProvider's org-id hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMode(getStoredRiskMode());
  }, []);

  if (!MOCKING_ENABLED) return null;

  function set(next: RiskMode) {
    setStoredRiskMode(next);
    setMode(next);
    onChange?.();
  }

  return (
    <div className="mb-4 flex items-center gap-2 rounded-lg border border-dashed border-(--color-warning) bg-(--color-warning-bg) px-3 py-2 text-xs">
      <span className="font-medium text-(--color-warning)">Dev only — ML service state</span>
      <Button type="button" size="sm" variant={mode === "ml" ? "primary" : "secondary"} onClick={() => set("ml")}>
        ML up
      </Button>
      <Button
        type="button"
        size="sm"
        variant={mode === "rules-only" ? "primary" : "secondary"}
        onClick={() => set("rules-only")}
      >
        ML down (rules-only)
      </Button>
    </div>
  );
}
