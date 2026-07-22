import { forwardRef, useId } from "react";
import type { SelectHTMLAttributes } from "react";
import { clsx } from "@/lib/clsx";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  hint?: string;
  error?: string;
  options: SelectOption[];
  placeholder?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, hint, error, options, placeholder, className, id, required, ...props }, ref) => {
    const generatedId = useId();
    const selectId = id ?? generatedId;

    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label htmlFor={selectId} className="text-sm font-medium text-(--color-fg)">
            {label}
            {required && <span aria-hidden className="text-(--color-danger) ms-1">*</span>}
          </label>
        )}
        <select
          ref={ref}
          id={selectId}
          required={required}
          aria-invalid={!!error || undefined}
          className={clsx(
            "rounded-md border bg-(--color-bg) px-3 py-2 text-sm text-(--color-fg)",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-primary)",
            error ? "border-(--color-danger)" : "border-(--color-border)",
            className
          )}
          {...props}
        >
          {placeholder && (
            <option value="" disabled>
              {placeholder}
            </option>
          )}
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        {hint && !error && <p className="text-xs text-(--color-muted)">{hint}</p>}
        {error && (
          <p role="alert" className="text-xs text-(--color-danger)">
            {error}
          </p>
        )}
      </div>
    );
  }
);
Select.displayName = "Select";
