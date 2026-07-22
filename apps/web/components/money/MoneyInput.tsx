"use client";

import { useId, useState } from "react";
import { clsx } from "@/lib/clsx";
import { CURRENCY, isValidMoneyString, type MoneyString } from "@/lib/money";

export interface MoneyInputProps {
  label?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  disabled?: boolean;
  /** Always a decimal string, e.g. "1250.000" — never a number. */
  value: MoneyString;
  onChange: (value: MoneyString) => void;
  id?: string;
}

// Allows partial input while typing ("1250.", "1250.0") without rejecting
// the keystroke; full validation runs against isValidMoneyString on blur/submit.
const PARTIAL_MONEY_PATTERN = /^\d*(\.\d{0,3})?$/;

export function MoneyInput({
  label,
  hint,
  error,
  required,
  disabled,
  value,
  onChange,
  id,
}: MoneyInputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const [touched, setTouched] = useState(false);

  const showError = error ?? (touched && value && !isValidMoneyString(value)
    ? "Enter an amount with up to 3 decimal places."
    : undefined);

  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={inputId} className="text-sm font-medium text-(--color-fg)">
          {label}
          {required && <span aria-hidden className="text-(--color-danger) ms-1">*</span>}
        </label>
      )}
      <div className="relative">
        <input
          id={inputId}
          type="text"
          inputMode="decimal"
          dir="ltr"
          required={required}
          disabled={disabled}
          value={value}
          onBlur={() => setTouched(true)}
          onChange={(e) => {
            const next = e.target.value;
            if (next === "" || PARTIAL_MONEY_PATTERN.test(next)) onChange(next);
          }}
          aria-invalid={!!showError || undefined}
          className={clsx(
            "w-full rounded-md border bg-(--color-bg) py-2 ps-3 pe-14 text-sm tabular-nums text-(--color-fg)",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-primary)",
            showError ? "border-(--color-danger)" : "border-(--color-border)"
          )}
        />
        <span className="pointer-events-none absolute inset-y-0 end-0 flex items-center pe-3 text-xs text-(--color-muted)">
          {CURRENCY}
        </span>
      </div>
      {hint && !showError && <p className="text-xs text-(--color-muted)">{hint}</p>}
      {showError && (
        <p role="alert" className="text-xs text-(--color-danger)">
          {showError}
        </p>
      )}
    </div>
  );
}
