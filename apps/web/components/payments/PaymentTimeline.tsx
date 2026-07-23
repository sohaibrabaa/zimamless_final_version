"use client";

import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Badge } from "@/components/ui/Badge";
import { MoneyDisplay } from "@/components/money/MoneyDisplay";
import { EmptyState } from "@/components/ui/StatePanels";
import {
  isAutomationPaused,
  isAwaitingBankConfirmation,
  stateTone,
} from "@/lib/payments/payments-domain";
import type { PaymentHistory } from "@/lib/payments/usePayments";

/**
 * The payment history and the derived outstanding balance.
 *
 * Two explanatory panels appear here rather than a bare status chip, because
 * the two states they cover are the ones a supplier is most likely to
 * misread:
 *
 *   - `OVERDUE_UNCONFIRMED` gets a plain sentence saying the platform is
 *     waiting on the bank and that this is **not a record of non-payment**.
 *     The state is neutral-toned for the same reason: colouring it amber would
 *     say in design what the copy is careful not to say in words.
 *   - A paused transaction says so, so a supplier who stops receiving
 *     reminders knows why rather than assuming the platform forgot them.
 */
export function PaymentTimeline({
  history,
  state,
  locale,
}: {
  history: PaymentHistory;
  state: string;
  locale: "en" | "ar";
}) {
  const t = useTranslations();

  return (
    <section className="rounded-lg border border-(--color-border) p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-semibold">{t("payments.timeline.title")}</h2>
          <Badge tone={stateTone(state)}>{t(`payments.state.${state}`)}</Badge>
        </div>
        <div className="text-end">
          <p className="text-xs text-(--color-muted)">{t("payments.timeline.outstanding")}</p>
          <MoneyDisplay value={history.outstandingAmount} locale={locale} emphasis="strong" />
        </div>
      </div>

      {isAwaitingBankConfirmation(state) && (
        <p className="mt-3 rounded-md bg-(--color-neutral-bg) p-3 text-sm text-(--color-fg)">
          {t("payments.timeline.awaitingExplainer")}
        </p>
      )}

      {isAutomationPaused(state) && (
        <p className="mt-3 rounded-md bg-(--color-neutral-bg) p-3 text-sm text-(--color-fg)">
          {t("payments.timeline.pausedExplainer")}
        </p>
      )}

      {/* Shown only once a bank has confirmed. Counting days publicly against
          an unconfirmed overdue would be the same accusation by arithmetic. */}
      {state === "OVERDUE" && history.overdueDays > 0 && (
        <p className="mt-3 text-sm text-(--color-warning)">
          {t("payments.timeline.overdueDays", { count: String(history.overdueDays) })}
        </p>
      )}

      {history.payments.length === 0 ? (
        <div className="mt-4">
          <EmptyState title={t("payments.timeline.empty")} />
        </div>
      ) : (
        <ol className="mt-4 flex flex-col gap-3">
          {history.payments.map((payment) => (
            <li
              key={payment.id}
              className="flex flex-wrap items-baseline justify-between gap-2 border-t border-(--color-border) pt-3 first:border-0 first:pt-0"
            >
              <div>
                <MoneyDisplay value={payment.amount ?? "0.000"} locale={locale} />
                <p className="mt-0.5 text-xs text-(--color-muted)">
                  {t("payments.timeline.reportedOn", { date: payment.paymentDate ?? "" })}
                </p>
              </div>
              {payment.bankReference && (
                <p className="zm-ltr-embed text-xs text-(--color-muted)">
                  {t("payments.timeline.reference", { reference: payment.bankReference })}
                </p>
              )}
              {/* bankInternalNotes is absent from the supplier payload by
                  construction (ZM-PMT-018); rendering it when present is
                  correct for a bank and impossible for a supplier. */}
              {payment.bankInternalNotes && (
                <p className="w-full text-xs text-(--color-muted) italic">
                  {payment.bankInternalNotes}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
