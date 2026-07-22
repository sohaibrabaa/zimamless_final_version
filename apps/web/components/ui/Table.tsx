import type { ReactNode } from "react";
import { clsx } from "@/lib/clsx";

export interface TableColumn<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  align?: "start" | "end";
}

export interface TableProps<T> {
  columns: TableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  emptyMessage?: string;
  loading?: boolean;
}

/**
 * Column order follows document order, which the browser mirrors
 * automatically under `dir="rtl"` — never hardcode a reversed column array
 * per locale (brief §6).
 */
export function Table<T>({ columns, rows, rowKey, emptyMessage, loading }: TableProps<T>) {
  return (
    <div className="overflow-x-auto rounded-lg border border-(--color-border)">
      <table className="w-full text-start text-sm">
        <thead className="bg-(--color-surface)">
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                className={clsx(
                  "px-4 py-2 font-medium text-(--color-muted)",
                  col.align === "end" ? "text-end" : "text-start"
                )}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading &&
            Array.from({ length: 3 }).map((_, i) => (
              <tr key={`skeleton-${i}`} className="border-t border-(--color-border)">
                {columns.map((col) => (
                  <td key={col.key} className="px-4 py-3">
                    <div className="h-3 w-full animate-pulse rounded bg-(--color-neutral-bg)" />
                  </td>
                ))}
              </tr>
            ))}
          {!loading && rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="px-4 py-8 text-center text-(--color-muted)">
                {emptyMessage ?? "No results found."}
              </td>
            </tr>
          )}
          {!loading &&
            rows.map((row) => (
              <tr key={rowKey(row)} className="border-t border-(--color-border)">
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={clsx("px-4 py-3", col.align === "end" ? "text-end" : "text-start")}
                  >
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}
