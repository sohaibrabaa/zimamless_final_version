import Decimal from "decimal.js";

/**
 * Money handling for Zimmamless. The API sends every monetary value as a
 * decimal string matching ^-?\d+\.\d{3}$ (JOD, 3 decimal places — see
 * Master Plan 5.5 and brief §5). Never use `parseFloat`/`Number()` on these —
 * both lose precision and are banned by eslint.config.mjs.
 *
 * The server's figure always wins: client-side computation here is
 * presentational only (live previews) and must be re-verified against the
 * API response, never trusted on its own.
 */

export const CURRENCY = "JOD" as const;
const DECIMAL_PLACES = 3;

Decimal.set({ precision: 30, rounding: Decimal.ROUND_HALF_UP });

export type MoneyString = string;

export function parseMoney(value: MoneyString): Decimal {
  if (!/^-?\d+(\.\d{1,3})?$/.test(value.trim())) {
    throw new Error(`Invalid money string: "${value}"`);
  }
  return new Decimal(value);
}

export function isValidMoneyString(value: string): boolean {
  try {
    parseMoney(value);
    return true;
  } catch {
    return false;
  }
}

/** Formats a Decimal (or money string) to the canonical "1250.000" shape. */
export function formatMoneyValue(value: Decimal | MoneyString): MoneyString {
  const d = value instanceof Decimal ? value : parseMoney(value);
  return d.toFixed(DECIMAL_PLACES);
}

interface FormatOptions {
  locale?: "en" | "ar";
  withCurrency?: boolean;
}

/** Formats a money string for display, e.g. "1,250.000 JOD". */
export function formatMoneyDisplay(
  value: MoneyString,
  { locale = "en", withCurrency = true }: FormatOptions = {}
): string {
  const d = parseMoney(value);
  const negative = d.isNegative();
  const abs = d.abs().toFixed(DECIMAL_PLACES);
  const [whole, frac] = abs.split(".");
  const numeralLocale = locale === "ar" ? "ar-JO" : "en-US";
  const groupedWhole = new Intl.NumberFormat(numeralLocale === "ar-JO" ? "en-US" : "en-US").format(
    BigInt(whole)
  );
  const sign = negative ? "-" : "";
  const amount = `${sign}${groupedWhole}.${frac}`;
  if (!withCurrency) return amount;
  return locale === "ar" ? `${amount} د.أ` : `${amount} ${CURRENCY}`;
}

export function addMoney(a: MoneyString, b: MoneyString): MoneyString {
  return formatMoneyValue(parseMoney(a).plus(parseMoney(b)));
}

export function subtractMoney(a: MoneyString, b: MoneyString): MoneyString {
  return formatMoneyValue(parseMoney(a).minus(parseMoney(b)));
}

export function compareMoney(a: MoneyString, b: MoneyString): number {
  return parseMoney(a).comparedTo(parseMoney(b));
}

export function isPositiveMoney(value: MoneyString): boolean {
  return parseMoney(value).isPositive();
}
