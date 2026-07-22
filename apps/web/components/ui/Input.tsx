import { forwardRef, useId } from "react";
import type { InputHTMLAttributes } from "react";
import { clsx } from "@/lib/clsx";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, hint, error, className, id, required, ...props }, ref) => {
    const generatedId = useId();
    const inputId = id ?? generatedId;
    const hintId = hint ? `${inputId}-hint` : undefined;
    const errorId = error ? `${inputId}-error` : undefined;

    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label htmlFor={inputId} className="text-sm font-medium text-(--color-fg)">
            {label}
            {required && <span aria-hidden className="text-(--color-danger) ms-1">*</span>}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          required={required}
          aria-invalid={!!error || undefined}
          aria-describedby={clsx(hintId, errorId).trim() || undefined}
          className={clsx(
            "rounded-md border bg-(--color-bg) px-3 py-2 text-sm text-(--color-fg)",
            "placeholder:text-(--color-muted)",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-primary)",
            error ? "border-(--color-danger)" : "border-(--color-border)",
            className
          )}
          {...props}
        />
        {hint && !error && (
          <p id={hintId} className="text-xs text-(--color-muted)">
            {hint}
          </p>
        )}
        {error && (
          <p id={errorId} role="alert" className="text-xs text-(--color-danger)">
            {error}
          </p>
        )}
      </div>
    );
  }
);
Input.displayName = "Input";
