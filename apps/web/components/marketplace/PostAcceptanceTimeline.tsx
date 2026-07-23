"use client";

import Link from "next/link";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Badge } from "@/components/ui/Badge";

const STEPS = ["OFFER_ACCEPTED", "CONDITIONS_PENDING", "CONTRACTED"] as const;
type Step = (typeof STEPS)[number];

/**
 * OFFER_ACCEPTED → CONDITIONS_PENDING → CONTRACTED, per the phase file's
 * "post-acceptance transaction timeline" screen. `CONDITIONS_PENDING` is
 * skipped in the rendered order when the accepted offer carried no
 * mandatory conditions (the mock's `acceptOffer` never sets that state in
 * that case) — the timeline reflects the transaction's real path, not a
 * fixed four-step diagram every transaction is forced through.
 */
export function PostAcceptanceTimeline({
  state,
  locale,
  transactionId,
}: {
  state: string;
  locale: "en" | "ar";
  transactionId: string;
}) {
  const t = useTranslations();
  if (!STEPS.includes(state as Step) && state !== "OFFER_ACCEPTED") return null;

  const currentIndex = STEPS.indexOf(state as Step);

  return (
    <section className="mt-4 rounded-lg border border-(--color-border) p-4">
      <h2 className="text-sm font-semibold">{t("marketplace.timeline.title")}</h2>
      <ol className="mt-3 flex flex-col gap-2">
        {STEPS.map((step, index) => {
          const reached = index <= currentIndex;
          return (
            <li key={step} className="flex items-center gap-3 text-sm">
              <Badge tone={reached ? "success" : "neutral"}>{index + 1}</Badge>
              <span className={reached ? "" : "text-(--color-muted)"}>
                {t(`marketplace.timeline.step.${step}`)}
              </span>
            </li>
          );
        })}
      </ol>
      <div className="mt-4 flex flex-wrap gap-3">
        <Link
          href={`/${locale}/supplier/invoices/${transactionId}/conditions`}
          className="text-sm underline underline-offset-2"
        >
          {t("marketplace.timeline.viewConditions")}
        </Link>
        <Link
          href={`/${locale}/supplier/invoices/${transactionId}/contract`}
          className="text-sm underline underline-offset-2"
        >
          {t("marketplace.timeline.viewContract")}
        </Link>
      </div>
    </section>
  );
}
