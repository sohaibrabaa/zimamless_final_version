"use client";

import Link from "next/link";
import { clsx } from "@/lib/clsx";

/**
 * Dashboard stat cards — a number, what it counts, and where to act on it.
 *
 * Numbers arrive as already-computed counts (never money — money renders
 * through MoneyDisplay wherever it appears). A card with an href is a real
 * destination, not decoration: every count shown must be actionable one
 * click away, or it is trivia.
 */
export interface Stat {
  label: string;
  value: number | string;
  href?: string;
  tone?: "default" | "attention";
}

export function StatCards({ stats }: { stats: Stat[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {stats.map((stat) => {
        const body = (
          <div
            className={clsx(
              "rounded-lg border p-4 transition-colors",
              stat.tone === "attention"
                ? "border-(--color-warning) bg-(--color-warning-bg)"
                : "border-(--color-border) bg-(--color-surface)",
              stat.href && "hover:border-(--color-primary)"
            )}
          >
            <div className="text-2xl font-semibold tabular-nums">{stat.value}</div>
            <div className="mt-1 text-xs text-(--color-muted)">{stat.label}</div>
          </div>
        );
        return stat.href ? (
          <Link key={stat.label} href={stat.href}>
            {body}
          </Link>
        ) : (
          <div key={stat.label}>{body}</div>
        );
      })}
    </div>
  );
}
