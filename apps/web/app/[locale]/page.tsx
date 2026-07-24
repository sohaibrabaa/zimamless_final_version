"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { useSession } from "@/lib/session/SessionProvider";
import { SkeletonText } from "@/components/ui/Skeleton";
import { portalForOrgType } from "@/components/layout/portal-nav";

/** Routes a signed-in user to their active organization's portal; sends everyone else to /login. */
export default function RootDispatcherPage() {
  const router = useRouter();
  const { locale } = useParams<{ locale: string }>();
  const { me, activeMembership, loading } = useSession();

  useEffect(() => {
    if (loading) return;
    if (!me) {
      router.replace(`/${locale}/login`);
      return;
    }
    const portal = portalForOrgType(activeMembership?.organizationType);
    // No membership yet = a fresh registrant: their next step is creating
    // their organization in the onboarding wizard, not a portal dashboard
    // (and certainly not /login/dashboard, which does not exist).
    router.replace(
      portal ? `/${locale}/${portal}/dashboard` : `/${locale}/supplier/onboarding`
    );
  }, [loading, me, activeMembership, locale, router]);

  return (
    <div className="flex min-h-screen items-center justify-center p-8">
      <div className="w-full max-w-sm">
        <SkeletonText lines={3} />
      </div>
    </div>
  );
}
