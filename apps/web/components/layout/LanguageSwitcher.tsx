"use client";

import { useRouter, usePathname } from "next/navigation";
import { useI18n, useTranslations } from "@/lib/i18n/dictionary-context";
import { locales, persistLocaleCookie, type Locale } from "@/lib/i18n/locales";
import { apiClient } from "@/lib/api/client";
import { clsx } from "@/lib/clsx";

/**
 * The only place a locale change may originate (ZM-I18N-003 / brief §5) —
 * never triggered by browser Accept-Language. Persists both client-side
 * (cookie, read by proxy.ts on the next navigation) and server-side
 * (PATCH /auth/language, per-user) so the choice survives across devices
 * once the user is authenticated.
 */
export function LanguageSwitcher() {
  const { locale } = useI18n();
  const t = useTranslations();
  const router = useRouter();
  const pathname = usePathname();

  function switchTo(next: Locale) {
    if (next === locale) return;
    persistLocaleCookie(next);
    const segments = pathname.split("/");
    segments[1] = next;
    router.push(segments.join("/") || `/${next}`);
    apiClient
      .PATCH("/auth/language", { body: { language: next === "ar" ? "AR" : "EN" } })
      .catch(() => {
        // Best-effort: the cookie + navigation already switched the UI: a
        // failed persist just means it won't survive a different device.
      });
  }

  return (
    <div role="group" aria-label={t("language.switcherLabel")} className="flex gap-1">
      {locales.map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => switchTo(l)}
          aria-pressed={l === locale}
          className={clsx(
            "rounded-md px-2 py-1 text-xs font-medium transition-colors",
            l === locale
              ? "bg-(--color-primary) text-(--color-primary-fg)"
              : "text-(--color-muted) hover:bg-(--color-neutral-bg)"
          )}
        >
          {t(`language.${l}`)}
        </button>
      ))}
    </div>
  );
}
