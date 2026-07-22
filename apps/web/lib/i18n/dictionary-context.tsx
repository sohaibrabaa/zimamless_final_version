"use client";

import { createContext, useContext, useMemo } from "react";
import type { Dictionary } from "./dictionaries";
import { type Locale, directionFor } from "./locales";

interface I18nContextValue {
  locale: Locale;
  dir: "ltr" | "rtl";
  dictionary: Dictionary;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({
  locale,
  dictionary,
  children,
}: {
  locale: Locale;
  dictionary: Dictionary;
  children: React.ReactNode;
}) {
  const value = useMemo(
    () => ({ locale, dictionary, dir: directionFor(locale) }),
    [locale, dictionary]
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within an I18nProvider");
  return ctx;
}

/** Reads a dotted-path key, e.g. t("nav.dashboard"). Falls back to the key itself. */
export function useTranslations() {
  const { dictionary } = useI18n();
  return function t(key: string, vars?: Record<string, string | number>): string {
    const parts = key.split(".");
    let value: unknown = dictionary;
    for (const part of parts) {
      if (typeof value !== "object" || value === null) {
        value = undefined;
        break;
      }
      value = (value as Record<string, unknown>)[part];
    }
    let result = typeof value === "string" ? value : key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        result = result.replace(`{${k}}`, String(v));
      }
    }
    return result;
  };
}
