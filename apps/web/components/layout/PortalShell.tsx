"use client";

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { useSession } from "@/lib/session/SessionProvider";
import { portalNav, type Portal } from "./portal-nav";
import { OrgSwitcher } from "./OrgSwitcher";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { clsx } from "@/lib/clsx";

export function PortalShell({ portal, children }: { portal: Portal; children: React.ReactNode }) {
  const t = useTranslations();
  const pathname = usePathname();
  const { locale } = useParams<{ locale: string }>();
  const { me, activeMembership, signOut } = useSession();

  const basePath = `/${locale}/${portal}`;

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 border-e border-(--color-border) bg-(--color-surface) sm:flex sm:flex-col">
        <div className="px-4 py-4 text-sm font-semibold">
          {t("common.appName")} · {t(`portal.${portal}`)}
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 px-2" aria-label={t(`portal.${portal}`)}>
          {portalNav[portal].map((item) => {
            const href = `${basePath}/${item.href}`;
            const active = pathname === href || pathname.startsWith(`${href}/`);
            return (
              <Link
                key={item.href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={clsx(
                  "rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  active
                    ? "bg-(--color-primary) text-(--color-primary-fg)"
                    : "text-(--color-fg) hover:bg-(--color-neutral-bg)"
                )}
              >
                {t(item.labelKey)}
              </Link>
            );
          })}
        </nav>
      </aside>

      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-(--color-border) px-6 py-3">
          <div className="flex items-center gap-3">
            <OrgSwitcher />
            {activeMembership && (
              <span className="hidden text-sm text-(--color-muted) sm:inline">
                {activeMembership.organizationName}
              </span>
            )}
            {me?.demo?.timeMachineEnabled && <Badge tone="info">{t("portal.demoModeLabel")}</Badge>}
          </div>
          <div className="flex items-center gap-3">
            <LanguageSwitcher />
            <Button variant="ghost" size="sm" onClick={() => signOut()}>
              {t("nav.signOut")}
            </Button>
          </div>
        </header>
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
