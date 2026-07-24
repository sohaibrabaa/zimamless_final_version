"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { useSession } from "@/lib/session/SessionProvider";
import { portalNav, portalForOrgType, type Portal } from "./portal-nav";
import { OrgSwitcher } from "./OrgSwitcher";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { clsx } from "@/lib/clsx";

const MOCKING_ENABLED = process.env.NEXT_PUBLIC_API_MOCKING !== "disabled";

export function PortalShell({ portal, children }: { portal: Portal; children: React.ReactNode }) {
  const t = useTranslations();
  const pathname = usePathname();
  const router = useRouter();
  const { locale } = useParams<{ locale: string }>();
  const { me, loading, activeMembership, signOut } = useSession();

  const basePath = `/${locale}/${portal}`;

  // Nobody signed in → the login screen, not a hollow portal shell. Mock
  // mode is exempt: it has no Supabase session by construction and the
  // persona picker on the login page is its only "auth".
  const signedOut = !MOCKING_ENABLED && !loading && !me;

  useEffect(() => {
    if (signedOut) router.replace(`/${locale}/login`);
  }, [signedOut, router, locale]);

  // A bank user must not browse the supplier portal, and vice versa. This is
  // navigation hygiene, not the security boundary: the API's org-context
  // guard and the database's RLS policies are what actually refuse the data,
  // independently of anything rendered here.
  const homePortal = portalForOrgType(activeMembership?.organizationType);
  const misrouted = !loading && !!activeMembership && homePortal !== undefined && homePortal !== portal;

  useEffect(() => {
    if (misrouted) router.replace(`/${locale}/${homePortal}/dashboard`);
  }, [misrouted, router, locale, homePortal]);

  if (misrouted || signedOut) return null;

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
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                // Sign out must LAND somewhere: without the push, live mode
                // left the user staring at the same page (the redirect
                // effect races the next render), and mock mode — where the
                // persona is instantly re-fetched — looked like the button
                // did nothing at all.
                await signOut();
                router.push(`/${locale}/login`);
              }}
            >
              {t("nav.signOut")}
            </Button>
          </div>
        </header>
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
