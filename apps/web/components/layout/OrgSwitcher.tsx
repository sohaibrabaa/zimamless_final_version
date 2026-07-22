"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useSession } from "@/lib/session/SessionProvider";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { useToast } from "@/components/ui/Toast";
import { ApiError } from "@/lib/api/client";
import { Select } from "@/components/ui/Select";
import { portalForOrgType } from "./portal-nav";

/** Every permission/query/data access is scoped to this active context (ZM-ROL-006/007) — switching re-fetches everything downstream via SessionProvider.refetch(). */
export function OrgSwitcher() {
  const t = useTranslations();
  const router = useRouter();
  const { locale } = useParams<{ locale: string }>();
  const { me, activeOrganizationId, switchOrganization } = useSession();
  const { show } = useToast();
  const [switching, setSwitching] = useState(false);

  if (!me || me.memberships.length < 2) return null;

  async function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const orgId = e.target.value;
    setSwitching(true);
    try {
      await switchOrganization(orgId);
      const membership = me!.memberships.find((m) => m.organizationId === orgId);
      const portal = portalForOrgType(membership?.organizationType);
      router.push(`/${locale}/${portal ?? "login"}/dashboard`);
    } catch (err) {
      // The API answers one identical 403 (ORGANIZATION_CONTEXT_INVALID)
      // whether the org does not exist or the user is simply not a member —
      // deliberately, so the pair cannot be used to enumerate organizations.
      // There is nothing to branch on and nothing more specific to say.
      show({
        tone: "danger",
        title: t("auth.orgSwitchFailed"),
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setSwitching(false);
    }
  }

  return (
    <Select
      aria-label={t("auth.orgSwitcherLabel")}
      value={activeOrganizationId ?? ""}
      onChange={onChange}
      disabled={switching}
      options={me.memberships.map((m) => ({
        value: m.organizationId ?? "",
        label: m.organizationName ?? "",
      }))}
      className="min-w-48"
    />
  );
}
