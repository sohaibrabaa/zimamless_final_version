"use client";

import { useId, useState } from "react";
import type { ReactNode } from "react";
import { clsx } from "@/lib/clsx";

export interface TabItem {
  id: string;
  label: string;
  content: ReactNode;
}

export function Tabs({ items, defaultTabId }: { items: TabItem[]; defaultTabId?: string }) {
  const [activeId, setActiveId] = useState(defaultTabId ?? items[0]?.id);
  const baseId = useId();
  const active = items.find((i) => i.id === activeId) ?? items[0];

  function onKeyDown(e: React.KeyboardEvent, index: number) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    // Logical, not physical: ArrowRight advances in reading order in both
    // LTR and RTL because the browser's key events are the same, but the
    // *visual* direction mirrors automatically via `dir` on <html> — we
    // only need to advance the index, not swap the arrows ourselves.
    const delta = e.key === "ArrowRight" ? 1 : -1;
    const next = (index + delta + items.length) % items.length;
    setActiveId(items[next].id);
    document.getElementById(`${baseId}-tab-${items[next].id}`)?.focus();
  }

  return (
    <div>
      <div role="tablist" className="flex gap-1 border-b border-(--color-border)">
        {items.map((item, index) => {
          const selected = item.id === active?.id;
          return (
            <button
              key={item.id}
              id={`${baseId}-tab-${item.id}`}
              role="tab"
              type="button"
              aria-selected={selected}
              aria-controls={`${baseId}-panel-${item.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActiveId(item.id)}
              onKeyDown={(e) => onKeyDown(e, index)}
              className={clsx(
                "px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
                selected
                  ? "border-(--color-primary) text-(--color-primary)"
                  : "border-transparent text-(--color-muted) hover:text-(--color-fg)"
              )}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      {items.map((item) => (
        <div
          key={item.id}
          id={`${baseId}-panel-${item.id}`}
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-${item.id}`}
          hidden={item.id !== active?.id}
          className="pt-4"
        >
          {item.id === active?.id ? item.content : null}
        </div>
      ))}
    </div>
  );
}
