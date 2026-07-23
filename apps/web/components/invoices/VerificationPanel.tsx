"use client";

import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Badge } from "@/components/ui/Badge";
import { SkeletonText } from "@/components/ui/Skeleton";
import {
  checkLabelKey,
  checkResultLabelKey,
  checkResultTone,
  orderedChecks,
  overallResultLabelKey,
  overallResultTone,
  type VerificationRun,
} from "@/lib/invoices/verification";

/**
 * The verification results panel — the eight automated checks of §8.5 with
 * their recorded outcomes.
 *
 * The framing rule is ZM-VER-002: a failed check is not proven fraud, it
 * routes to review. So the panel presents results, not a verdict, and the
 * explanatory line under a REVIEW outcome says a person will look at it rather
 * than implying something has been concluded. `MISSING` and `UNPARSED` are
 * neutral for the same reason they are in Phase 2's government panel — the
 * platform not having something is not a finding against the supplier.
 */
export function VerificationPanel({
  run,
  loading,
}: {
  run: VerificationRun | null | undefined;
  loading?: boolean;
}) {
  const t = useTranslations();

  if (loading) return <SkeletonText lines={4} />;

  if (!run) {
    return (
      <div className="rounded-lg border border-(--color-border) px-4 py-3">
        <p className="text-sm text-(--color-muted)">{t("invoices.verification.notRunYet")}</p>
      </div>
    );
  }

  const checks = orderedChecks(run);

  return (
    <div className="rounded-lg border border-(--color-border) p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t("invoices.verification.title")}</h3>
        <Badge tone={overallResultTone(run.overallResult)}>
          {t(overallResultLabelKey(run.overallResult))}
        </Badge>
      </div>

      {run.overallResult === "REVIEW" && (
        <p className="mt-2 text-sm text-(--color-muted)">
          {t("invoices.verification.reviewExplanation")}
        </p>
      )}

      <ul className="mt-4 flex flex-col divide-y divide-(--color-border)">
        {checks.map((check, index) => (
          <li
            key={`${check.checkType}-${index}`}
            className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0"
          >
            <span className="text-sm">{t(checkLabelKey(check.checkType))}</span>
            <Badge tone={checkResultTone(check.result)}>
              {t(checkResultLabelKey(check.result))}
            </Badge>
          </li>
        ))}
      </ul>

      {checks.length === 0 && (
        <p className="mt-3 text-sm text-(--color-muted)">{t("invoices.verification.noChecks")}</p>
      )}
    </div>
  );
}
