"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { SkeletonText } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/StatePanels";
import { MoneyDisplay } from "@/components/money/MoneyDisplay";
import { PaymentTimeline } from "@/components/payments/PaymentTimeline";
import { ApiError } from "@/lib/api/client";
import { bankPostFundingActions, stateTone } from "@/lib/payments/payments-domain";
import {
  confirmStatus,
  initiateRecourse,
  usePayments,
  useReportPayment,
} from "@/lib/payments/usePayments";
import { useFundingQueue, type TransactionSummary } from "@/lib/funding/useFunding";

/**
 * The bank's post-funding desk.
 *
 * The important control here is `confirm-status`, and the screen says why it
 * exists: only the bank can see whether the buyer paid, so until it says so
 * the platform records the invoice as awaiting confirmation and makes no claim
 * about anybody. An operator who understands that is far more likely to
 * actually confirm.
 *
 * Recourse is offered only on a **confirmed** overdue. Offering it on an
 * unconfirmed one would both invite a 409 and imply the platform thinks
 * silence is grounds for a claim against a supplier.
 */

const POST_FUNDING_STATES = [
  "FUNDED",
  "PARTIALLY_PAID",
  "PAID",
  "OVERDUE_UNCONFIRMED",
  "OVERDUE",
  "RECOURSE_ACTIVE",
  "DISPUTED",
] as const;

export default function BankPaymentsPage() {
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
                <span className="mt-1 block text-xs text-(--color-muted)">{item.buyerName}</span>
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
            <BankPaymentDetail
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

function BankPaymentDetail({
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
  const { report } = useReportPayment();
  const state = transaction.state ?? "";
  const actions = bankPostFundingActions(state);

  const [amount, setAmount] = useState("");
  const [paymentDate, setPaymentDate] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState<"PAID" | "PARTIALLY_PAID" | "OVERDUE">("OVERDUE");
  const [claimAmount, setClaimAmount] = useState("");
  const [reason, setReason] = useState("NON_PAYMENT");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    history.reload();
    onChanged();
  };

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      refresh();
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

      {actions.canReportPayment && (
        <section className="rounded-lg border border-(--color-border) p-4">
          <h2 className="text-sm font-semibold">{t("payments.report.title")}</h2>
          <form
            className="mt-3 flex max-w-sm flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!transaction.id) return;
              void run(async () => {
                await report(transaction.id!, {
                  amount,
                  paymentDate,
                  bankReference: reference || undefined,
                  bankInternalNotes: notes || undefined,
                });
                setAmount("");
                setNotes("");
              });
            }}
          >
            <Input
              label={t("payments.report.amount")}
              inputMode="decimal"
              placeholder="0.000"
              className="zm-ltr-embed tabular-nums"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
            />
            <Input
              label={t("payments.report.date")}
              type="date"
              value={paymentDate}
              onChange={(e) => setPaymentDate(e.target.value)}
              required
            />
            <Input
              label={t("payments.report.reference")}
              className="zm-ltr-embed"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
            <Input
              label={t("payments.report.notes")}
              hint={t("payments.report.notesHint")}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
            <Button type="submit" loading={busy} disabled={!amount || !paymentDate}>
              {t("payments.report.submit")}
            </Button>
          </form>
        </section>
      )}

      {actions.canConfirmStatus && (
        <section className="rounded-lg border border-(--color-border) p-4">
          <h2 className="text-sm font-semibold">{t("payments.confirm.title")}</h2>
          {/* Said plainly: an operator who understands why this matters is far
              more likely to actually confirm. */}
          <p className="mt-1 text-xs text-(--color-muted)">{t("payments.confirm.explainer")}</p>

          <form
            className="mt-3 flex max-w-sm flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!transaction.id) return;
              void run(() => confirmStatus(transaction.id!, { status }));
            }}
          >
            <Select
              label={t("payments.confirm.statusLabel")}
              value={status}
              onChange={(e) => setStatus(e.target.value as typeof status)}
              options={[
                { value: "PAID", label: t("payments.confirm.PAID") },
                { value: "PARTIALLY_PAID", label: t("payments.confirm.PARTIALLY_PAID") },
                { value: "OVERDUE", label: t("payments.confirm.OVERDUE") },
              ]}
            />
            <Button type="submit" loading={busy}>
              {t("payments.confirm.submit")}
            </Button>
          </form>
        </section>
      )}

      {actions.canInitiateRecourse && (
        <section className="rounded-lg border border-(--color-border) p-4">
          <h2 className="text-sm font-semibold">{t("payments.recourse.initiate")}</h2>
          <form
            className="mt-3 flex max-w-sm flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!transaction.id) return;
              void run(() =>
                initiateRecourse(transaction.id!, {
                  reason,
                  requestedAmount: claimAmount,
                }).then(() => undefined)
              );
            }}
          >
            <Select
              label={t("payments.recourse.reasonLabel")}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              options={[
                "INVALID_INVOICE",
                "HIDDEN_DISPUTE_OR_RETURN",
                "DOUBLE_FINANCING",
                "NON_DELIVERY",
                "NON_PAYMENT",
                "OTHER",
              ].map((value) => ({ value, label: t(`payments.recourse.reason.${value}`) }))}
            />
            <Input
              label={t("payments.recourse.amountLabel")}
              hint={t("payments.recourse.amountHint")}
              inputMode="decimal"
              placeholder="0.000"
              className="zm-ltr-embed tabular-nums"
              value={claimAmount}
              onChange={(e) => setClaimAmount(e.target.value)}
              required
            />
            <Button type="submit" variant="danger" loading={busy} disabled={!claimAmount}>
              {t("payments.recourse.submit")}
            </Button>
          </form>
        </section>
      )}

      {error && <p className="text-sm text-(--color-danger)">{error}</p>}
    </div>
  );
}
