"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { SkeletonText } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/StatePanels";
import { MoneyDisplay } from "@/components/money/MoneyDisplay";
import { PaymentTimeline } from "@/components/payments/PaymentTimeline";
import { FinancingGate } from "@/components/onboarding/FinancingGate";
import { ApiError } from "@/lib/api/client";
import { stateTone, supplierPostFundingActions } from "@/lib/payments/payments-domain";
import { openDispute, usePayments } from "@/lib/payments/usePayments";
import { useFundingQueue, type TransactionSummary } from "@/lib/funding/useFunding";

/**
 * The supplier's view of what happened after the money arrived.
 *
 * A supplier reports nothing here — they cannot see the buyer's bank account
 * any more than the platform can. What they get is a legible record: what was
 * paid, what remains, and, where the invoice has passed its due date, a plain
 * statement that the platform is waiting on the bank rather than recording a
 * failure to pay.
 *
 * The one action is raising a dispute, and it is available from every live
 * state: a supplier who believes something is wrong must be able to stop the
 * machinery without waiting for anyone to agree with them first.
 */
export default function SupplierPaymentsPage() {
  return (
    <FinancingGate>
      <SupplierPaymentsView />
    </FinancingGate>
  );
}

const POST_FUNDING_STATES = [
  "FUNDED",
  "PARTIALLY_PAID",
  "PAID",
  "OVERDUE_UNCONFIRMED",
  "OVERDUE",
  "RECOURSE_ACTIVE",
  "DISPUTED",
] as const;

function SupplierPaymentsView() {
  const t = useTranslations();
  const params = useParams<{ locale: string }>();
  const locale = params?.locale === "ar" ? "ar" : "en";

  const queue = useFundingQueue(POST_FUNDING_STATES);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (queue.loading) return <SkeletonText lines={6} />;
  if (queue.error) {
    return <ErrorState title={queue.error} onRetry={queue.reload} retryLabel={t("common.retry")} />;
  }

  const items = queue.data ?? [];
  const selected = items.find((i) => i.id === selectedId) ?? items[0];

  return (
    <div className="max-w-4xl">
      <h1 className="mb-1 text-lg font-semibold">{t("payments.timeline.title")}</h1>

      {items.length === 0 ? (
        <EmptyState title={t("payments.timeline.empty")} />
      ) : (
        <div className="mt-4 grid gap-5 lg:grid-cols-[18rem_1fr]">
          <nav className="flex flex-col gap-2">
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setSelectedId(item.id ?? null)}
                aria-current={item.id === selected?.id || undefined}
                className={
                  "rounded-lg border p-3 text-start transition-colors " +
                  (item.id === selected?.id
                    ? "border-(--color-primary) bg-(--color-neutral-bg)"
                    : "border-(--color-border) hover:bg-(--color-neutral-bg)")
                }
              >
                <span className="zm-ltr-embed block text-sm font-medium">
                  {item.referenceNumber}
                </span>
                <span className="mt-2 flex items-center justify-between gap-2">
                  <Badge tone={stateTone(item.state ?? "")}>
                    {t(`payments.state.${item.state}`)}
                  </Badge>
                  {item.outstandingAmount && (
                    <MoneyDisplay
                      value={item.outstandingAmount}
                      locale={locale}
                      withCurrency={false}
                    />
                  )}
                </span>
              </button>
            ))}
          </nav>

          {selected?.id && (
            <SupplierPaymentDetail
              key={selected.id}
              transaction={selected}
              locale={locale}
              onChanged={queue.reload}
            />
          )}
        </div>
      )}
    </div>
  );
}

function SupplierPaymentDetail({
  transaction,
  locale,
  onChanged,
}: {
  transaction: TransactionSummary;
  locale: "en" | "ar";
  onChanged: () => void;
}) {
  const t = useTranslations();
  const history = usePayments(transaction.id);
  const state = transaction.state ?? "";
  const actions = supplierPostFundingActions(state);

  const [disputing, setDisputing] = useState(false);
  const [disputeType, setDisputeType] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submitDispute(event: React.FormEvent) {
    event.preventDefault();
    if (!transaction.id || !description.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await openDispute(transaction.id, {
        disputeType: disputeType.trim() || "OTHER",
        description: description.trim(),
      });
      setDisputing(false);
      setDescription("");
      onChanged();
      history.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("common.unknownError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {history.loading && <SkeletonText lines={4} />}
      {history.data && <PaymentTimeline history={history.data} state={state} locale={locale} />}

      {actions.canDispute && !disputing && (
        <div>
          <Button type="button" variant="secondary" onClick={() => setDisputing(true)}>
            {t("payments.dispute.open")}
          </Button>
        </div>
      )}

      {disputing && (
        <section className="rounded-lg border border-(--color-border) p-4">
          <h2 className="text-sm font-semibold">{t("payments.dispute.title")}</h2>
          <p className="mt-1 text-xs text-(--color-muted)">{t("payments.dispute.explainer")}</p>

          <form onSubmit={submitDispute} className="mt-3 flex max-w-sm flex-col gap-3">
            <Input
              label={t("payments.dispute.typeLabel")}
              value={disputeType}
              onChange={(e) => setDisputeType(e.target.value)}
            />
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">{t("payments.dispute.descriptionLabel")}</span>
              <textarea
                required
                rows={4}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="rounded-md border border-(--color-border) bg-(--color-bg) px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-primary)"
              />
            </label>
            <div className="flex gap-2">
              <Button type="submit" loading={busy} disabled={!description.trim()}>
                {t("payments.dispute.submit")}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setDisputing(false)}>
                {t("common.cancel")}
              </Button>
            </div>
          </form>
        </section>
      )}

      {error && <p className="text-sm text-(--color-danger)">{error}</p>}
    </div>
  );
}
