import { formatMoneyDisplay, type MoneyString } from "@/lib/money";
import { clsx } from "@/lib/clsx";

export interface MoneyDisplayProps {
  value: MoneyString;
  locale?: "en" | "ar";
  withCurrency?: boolean;
  emphasis?: "normal" | "strong";
  className?: string;
}

/**
 * Always renders LTR-isolated, even inside an Arabic sentence — a bidi
 * amount must never visually reorder (brief §6).
 */
export function MoneyDisplay({
  value,
  locale = "en",
  withCurrency = true,
  emphasis = "normal",
  className,
}: MoneyDisplayProps) {
  const formatted = formatMoneyDisplay(value, { locale, withCurrency });
  return (
    <span
      className={clsx(
        "zm-ltr-embed tabular-nums",
        emphasis === "strong" && "text-lg font-semibold",
        className
      )}
    >
      {formatted}
    </span>
  );
}
