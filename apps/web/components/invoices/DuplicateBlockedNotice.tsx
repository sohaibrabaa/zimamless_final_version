"use client";

import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Button } from "@/components/ui/Button";
import type { DuplicateBlock } from "@/lib/invoices/duplicate";

/**
 * The duplicate-fingerprint blocked screen (ZM-VER-001).
 *
 * Two things this must get right, and one it must not do.
 *
 * It must say the submission is **blocked**, not rejected: the transaction
 * stays a draft and everything the supplier entered is still there. And it
 * must show the review reference, because ZM-VER-001 opens a review record and
 * a blocked screen with no reference to quote is indistinguishable from a dead
 * end.
 *
 * What it must not do is accuse. A fingerprint collision means this invoice is
 * already on the platform — which is a fact about the invoice, and has several
 * innocent explanations (a resubmission, a duplicate upload, an invoice
 * genuinely assigned to two parties). ZM-VER-002 is explicit that a failed
 * check is not proven fraud; it routes to review. So the copy states the
 * finding and the next step, and says nothing about who did what.
 */
export function DuplicateBlockedNotice({
  block,
  onBack,
}: {
  block: DuplicateBlock;
  onBack?: () => void;
}) {
  const t = useTranslations();

  return (
    <section
      role="alert"
      aria-labelledby="duplicate-blocked-heading"
      className="rounded-lg border border-(--color-border) p-5"
    >
      <h2 id="duplicate-blocked-heading" className="text-base font-semibold">
        {t("invoices.duplicate.title")}
      </h2>
      <p className="mt-2 text-sm text-(--color-fg)">{t("invoices.duplicate.body")}</p>
      <p className="mt-2 text-sm text-(--color-muted)">{t("invoices.duplicate.nextSteps")}</p>

      <dl className="mt-4 grid gap-2 sm:grid-cols-2">
        <div>
          <dt className="text-xs text-(--color-muted)">{t("invoices.duplicate.reviewReference")}</dt>
          <dd className="zm-ltr-embed text-sm font-medium">
            {/* Never render an empty value as if a reference existed. If the
                server sent none, say so — the correlation id below is then
                what support has to work with. */}
            {block.reviewReference ?? t("invoices.duplicate.noReference")}
          </dd>
        </div>
        {block.correlationId && (
          <div>
            <dt className="text-xs text-(--color-muted)">{t("common.correlationId")}</dt>
            <dd className="zm-ltr-embed text-sm">{block.correlationId}</dd>
          </div>
        )}
      </dl>

      {onBack && (
        <Button type="button" variant="secondary" className="mt-5" onClick={onBack}>
          {t("invoices.duplicate.backToDraft")}
        </Button>
      )}
    </section>
  );
}
