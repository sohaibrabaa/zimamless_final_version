"use client";

import { useEffect, useState } from "react";

const MOCKING_ENABLED = process.env.NEXT_PUBLIC_API_MOCKING !== "disabled";

/**
 * Starts the MSW browser worker before rendering children, so no request
 * races the mock setup. Set NEXT_PUBLIC_API_MOCKING=disabled once every
 * demo-path endpoint is live (Master Plan 3.4 exit criterion).
 */
export function MockingProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(!MOCKING_ENABLED);

  useEffect(() => {
    if (!MOCKING_ENABLED) return;
    let cancelled = false;
    import("@/lib/mocks/browser").then(({ worker }) =>
      worker.start({ onUnhandledRequest: "bypass" }).then(() => {
        if (!cancelled) setReady(true);
      })
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) return null;
  return <>{children}</>;
}
