import type { ReactNode } from "react";
import { clsx } from "@/lib/clsx";

// Neutral is the default on purpose: brief §5 forbids presenting missing
// government data (or any non-adverse state) with warning colors. Reach for
// "warning"/"danger" only for a genuinely confirmed adverse status.
export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";

const toneClasses: Record<BadgeTone, string> = {
  neutral: "bg-(--color-neutral-bg) text-(--color-neutral-fg)",
  success: "bg-(--color-success-bg) text-(--color-success)",
  warning: "bg-(--color-warning-bg) text-(--color-warning)",
  danger: "bg-(--color-danger-bg) text-(--color-danger)",
  info: "bg-(--color-surface) text-(--color-primary) border border-(--color-border)",
};

export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        toneClasses[tone]
      )}
    >
      {children}
    </span>
  );
}
