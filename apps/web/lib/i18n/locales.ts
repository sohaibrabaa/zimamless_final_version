export const locales = ["en", "ar"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";

// ZM-I18N-003 / brief §5: no locale auto-detection, ever. "en" is the
// default for every user regardless of browser Accept-Language; Arabic is
// reached only through the explicit switcher, then persisted per user.
export const LOCALE_COOKIE = "zm_locale";

export function isLocale(value: string): value is Locale {
  return (locales as readonly string[]).includes(value);
}

export function directionFor(locale: Locale): "ltr" | "rtl" {
  return locale === "ar" ? "rtl" : "ltr";
}

/** Plain module-scope helper (not a component/hook) so the React Compiler doesn't flag the document.cookie write as an in-render mutation. */
export function persistLocaleCookie(locale: Locale) {
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; samesite=lax`;
}
