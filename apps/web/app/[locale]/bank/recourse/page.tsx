"use client";

import { useParams } from "next/navigation";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { SkeletonText } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/StatePanels";
import { CaseList } from "@/components/payments/CaseList";
import { useSession } from "@/lib/session/SessionProvider";
import { useCases } from "@/lib/payments/usePayments";

/**
 * The bank's recourse desk — the platform case desk's read, pre-filtered.
 *
 * Same endpoint (`GET /cases?type=RECOURSE`), scoped server-side to cases on
 * transactions this bank funded; a bank never sees another bank's recourse
 * or any fraud review (case-list.service owns that rule, `CaseList` mirrors
 * it). No type selector here on purpose: recourse is the only case type a
 * bank *initiates*, so this screen answers one question — "where are my
 * claims?" — and the rest of the case types stay where they are worked,
 * on the platform desk.
 */
export default function BankRecoursePage() {
  const t = useTranslations();
  const params = useParams<{ locale: string }>();
  const locale = params?.locale === "ar" ? "ar" : "en";
  const { activeMembership } = useSession();

  const cases = useCases({ type: "RECOURSE" });

  return (
    <div className="max-w-3xl">
      <h1 className="mb-1 text-lg font-semibold">{t("nav.recourse")}</h1>
      <p className="mb-4 text-sm text-(--color-muted)">{t("payments.cases.recourseIntro")}</p>

      {cases.loading && <SkeletonText lines={5} />}
      {cases.error && (
        <ErrorState title={cases.error} onRetry={cases.reload} retryLabel={t("common.retry")} />
      )}
      {cases.data && (
        <CaseList
          cases={cases.data}
          organizationType={activeMembership?.organizationType}
          locale={locale}
        />
      )}
    </div>
  );
}
