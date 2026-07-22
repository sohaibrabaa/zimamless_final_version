"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import type { ReactNode } from "react";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { SkeletonText } from "@/components/ui/Skeleton";
import { useMyApplication } from "@/lib/onboarding/useApplication";
import { financingBlocked } from "@/lib/onboarding/status";

/**
 * ZM-SON-011 client-side gate: under APPROVED_CONDITIONAL (and any state
 * before approval) the supplier can log in and complete outstanding items but
 * MUST NOT create invoice submissions or listings.
 *
 * Two things this deliberately is *not*:
 *  - It is not the enforcement point. The server rejects the write regardless;
 *    this only stops the supplier walking into a dead end (and matches the
 *    "blocked in UI as well as server-side" pattern the brief asks for on the
 *    bank approval queue).
 *  - It is not a hidden nav item. The destination stays reachable and explains
 *    *why* it is unavailable and what clears it, because ZM-SON-011's whole
 *    point is that a conditionally-approved supplier can still see the
 *    platform and work through what's outstanding.
 */
export function FinancingGate({ children }: { children: ReactNode }) {
  const t = useTranslations();
  const { locale } = useParams<{ locale: string }>();
  const { data: application, loading } = useMyApplication();

  if (loading) return <SkeletonText lines={3} />;

  if (!financingBlocked(application?.status)) return <>{children}</>;

  const reasonKey =
    application?.status === "APPROVED_CONDITIONAL"
      ? "onboarding.financingGate.conditional"
      : application?.status === "REJECTED"
        ? "onboarding.financingGate.notApproved"
        : "onboarding.financingGate.pending";

  return (
    <div className="rounded-lg border border-(--color-border) bg-(--color-surface) px-4 py-6">
      <p className="text-sm font-medium text-(--color-fg)">
        {t("onboarding.financingGate.title")}
      </p>
      <p className="mt-1 text-sm text-(--color-muted)">{t(reasonKey)}</p>
      <Link
        href={`/${locale}/supplier/onboarding`}
        className="mt-3 inline-block text-sm text-(--color-primary) underline-offset-2 hover:underline"
      >
        {t("onboarding.financingGate.goToOnboarding")}
      </Link>
    </div>
  );
}
