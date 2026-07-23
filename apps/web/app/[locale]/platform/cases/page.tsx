"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Select } from "@/components/ui/Select";
import { SkeletonText } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/StatePanels";
import { CaseList } from "@/components/payments/CaseList";
import { useSession } from "@/lib/session/SessionProvider";
import { useCases } from "@/lib/payments/usePayments";
import type { CaseType } from "@/lib/payments/payments-domain";

/**
 * The platform case desk — every case type in one list.
 *
 * Platform staff see all four; a bank or supplier reaching this route sees
 * only its own cases and never a fraud review, enforced by the API and
 * mirrored in `CaseList`. The redundancy is deliberate: the server rule is the
 * one that matters, and the client one exists so a future endpoint change
 * cannot quietly start rendering fraud cases to a party without also
 * contradicting a line that says in words that it must not.
 */
export default function PlatformCasesPage() {
  const t = useTranslations();
  const params = useParams<{ locale: string }>();
  const locale = params?.locale === "ar" ? "ar" : "en";
  const { activeMembership } = useSession();

  const [type, setType] = useState<CaseType | "">("");
  const cases = useCases(type ? { type } : {});

  return (
    <div className="max-w-3xl">
      <h1 className="mb-4 text-lg font-semibold">{t("payments.cases.title")}</h1>

      <div className="mb-4 max-w-xs">
        <Select
          label={t("payments.cases.filterAll")}
          value={type}
          onChange={(e) => setType(e.target.value as CaseType | "")}
          options={[
            { value: "", label: t("payments.cases.filterAll") },
            { value: "RECOURSE", label: t("payments.cases.type.RECOURSE") },
            { value: "DISPUTE", label: t("payments.cases.type.DISPUTE") },
            { value: "WITHDRAWAL", label: t("payments.cases.type.WITHDRAWAL") },
            { value: "FRAUD", label: t("payments.cases.type.FRAUD") },
          ]}
        />
      </div>

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
