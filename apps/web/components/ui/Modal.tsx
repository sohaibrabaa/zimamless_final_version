"use client";

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { clsx } from "@/lib/clsx";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}

/**
 * Built on native <dialog> for built-in focus trapping, ESC-to-close, and
 * top-layer stacking — avoids hand-rolling a11y-sensitive behavior.
 */
export function Modal({ open, onClose, title, children, footer }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
      aria-labelledby="modal-title"
      className={clsx(
        "m-auto w-full max-w-lg rounded-lg border border-(--color-border) bg-(--color-bg) p-0 text-(--color-fg)",
        "backdrop:bg-black/40"
      )}
    >
      {open && (
        <div className="flex flex-col">
          <header className="flex items-center justify-between border-b border-(--color-border) px-5 py-4">
            <h2 id="modal-title" className="text-base font-semibold">
              {title}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-md p-1 text-(--color-muted) hover:bg-(--color-neutral-bg) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-primary)"
            >
              ✕
            </button>
          </header>
          <div className="px-5 py-4">{children}</div>
          {footer && (
            <footer className="flex justify-end gap-2 border-t border-(--color-border) px-5 py-4">
              {footer}
            </footer>
          )}
        </div>
      )}
    </dialog>
  );
}
