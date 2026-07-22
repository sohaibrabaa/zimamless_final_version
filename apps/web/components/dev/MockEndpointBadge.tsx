"use client";

import { useState } from "react";
import { endpointStatus } from "@/lib/api/endpoint-status";
import { clsx } from "@/lib/clsx";

const MOCKING_ENABLED = process.env.NEXT_PUBLIC_API_MOCKING !== "disabled";

/** Dev-only: surfaces which endpoints are currently mocked vs live so a demo-critical screen is never shown on mocks by accident. */
export function MockEndpointBadge() {
  const [open, setOpen] = useState(false);
  if (process.env.NODE_ENV === "production" || !MOCKING_ENABLED) return null;

  const mocked = endpointStatus.filter((e) => e.status === "mock");
  const live = endpointStatus.length - mocked.length;

  return (
    <div className="fixed bottom-4 start-4 z-50 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded-full border border-(--color-warning) bg-(--color-warning-bg) px-3 py-1 font-medium text-(--color-warning) shadow"
      >
        {mocked.length} mocked · {live} live
      </button>
      {open && (
        <div className="mt-2 max-h-80 w-80 overflow-y-auto rounded-lg border border-(--color-border) bg-(--color-bg) p-3 shadow-lg">
          <ul className="flex flex-col gap-1">
            {endpointStatus.map((e) => (
              <li key={`${e.method} ${e.path}`} className="flex items-center justify-between gap-2">
                <span className="truncate font-mono">
                  {e.method} {e.path}
                </span>
                <span
                  className={clsx(
                    "shrink-0 rounded px-1.5 py-0.5",
                    e.status === "live"
                      ? "bg-(--color-success-bg) text-(--color-success)"
                      : "bg-(--color-neutral-bg) text-(--color-neutral-fg)"
                  )}
                >
                  {e.status}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
