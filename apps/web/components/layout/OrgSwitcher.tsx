"use client";

import { useParams, useRouter } from "next/navigation";
import { useSession } from "@/lib/session/SessionProvider";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Select } from "@/components/ui/Select";
import { portalForOrgType } from "./portal-nav";

/** Every permission/query/data access is scoped to this active context (ZM-ROL-006/007) — switching re-fetches everything downstream via SessionProvider.refetch(). */
export function OrgSwitcher() {
  const t = useTranslations();
  const router = useRouter();
  const { locale } = useParams<{ locale: string }>();
  const { me, switchOrganization } = useSession();

  if (!me || me.memberships.length < 2) return null;

  async function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const orgId = e.target.value;
    await switchOrganization(orgId);
    const membership = me!.memberships.find((m) => m.organizationId === orgId);
    const portal = portalForOrgType(membership?.organizationType);
    router.push(`/${locale}/${portal ?? "login"}/dashboard`);
  }

  return (
    <Select
      aria-label={t("auth.orgSwitcherLabel")}
      value={me.activeOrganizationId ?? ""}
      onChange={onChange}
      options={me.memberships.map((m) => ({
        value: m.organizationId ?? "",
        label: m.organizationName ?? "",
      }))}
      className="min-w-48"
    />
  );
}
