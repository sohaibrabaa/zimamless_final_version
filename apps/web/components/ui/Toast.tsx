"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { clsx } from "@/lib/clsx";

export type ToastTone = "neutral" | "success" | "danger" | "warning";

export interface Toast {
  id: string;
  title: string;
  description?: string;
  tone?: ToastTone;
}

interface ToastContextValue {
  show: (toast: Omit<Toast, "id">) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const toneClasses: Record<ToastTone, string> = {
  neutral: "border-(--color-border) bg-(--color-bg)",
  success: "border-(--color-success) bg-(--color-success-bg)",
  danger: "border-(--color-danger) bg-(--color-danger-bg)",
  warning: "border-(--color-warning) bg-(--color-warning-bg)",
};

let idCounter = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const show = useCallback((toast: Omit<Toast, "id">) => {
    const id = `toast-${++idCounter}`;
    setToasts((prev) => [...prev, { ...toast, id }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 6000);
  }, []);

  const value = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 end-4 z-50 flex w-full max-w-sm flex-col gap-2"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={clsx(
              "pointer-events-auto rounded-lg border px-4 py-3 shadow-md",
              toneClasses[toast.tone ?? "neutral"]
            )}
          >
            <p className="text-sm font-medium text-(--color-fg)">{toast.title}</p>
            {toast.description && (
              <p className="mt-0.5 text-xs text-(--color-muted)">{toast.description}</p>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}
