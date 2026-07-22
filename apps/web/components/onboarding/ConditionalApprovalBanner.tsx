"use client";

import { useTranslations } from "@/lib/i18n/dictionary-context";
import { findReasonCode } from "@/lib/onboarding/reason-codes";
import type { ApplicationView } from "@/lib/onboarding/useApplication";

/**
 * ZM-SON-011: under APPROVED_CONDITIONAL the supplier can log in, look around,
 * and complete outstanding items — but cannot create invoice submissions or
 * listings.
 *
 * The banner explains *what is still open* and *what is blocked*, in that
 * order. Tone is informational, not punitive: the account is approved, with a
 * condition outstanding.
 */
export function ConditionalApprovalBanner({ application }: { application: ApplicationView }) {
  const t = useTranslations();
  if (application.status !== "APPROVED_CONDITIONAL") return null;

  const reason = findReasonCode(application.decisionReasonCode);

  return (
    <div
      role="status"
      className="mb-4 rounded-lg border border-(--color-border) bg-(--color-surface) px-4 py-3"
    >
      <p className="text-sm font-medium text-(--color-fg)">
        {t("onboarding.conditional.title")}
      </p>
      <p className="mt-1 text-sm text-(--color-muted)">{t("onboarding.conditional.body")}</p>
      {reason && (
        <p className="mt-1 text-sm text-(--color-muted)">{t(reason.supplierMessageKey)}</p>
      )}
      {application.decisionNotes && (
        <p className="mt-1 text-sm text-(--color-muted)">{application.decisionNotes}</p>
      )}
    </div>
  );
}
