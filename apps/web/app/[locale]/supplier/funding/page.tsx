"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Badge } from "@/components/ui/Badge";
import { SkeletonText } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/StatePanels";
import { MoneyDisplay } from "@/components/money/MoneyDisplay";
import { ConfirmFundingForm } from "@/components/funding/ConfirmFundingForm";
import { SettlementPanel } from "@/components/funding/SettlementPanel";
import { FinancingGate } from "@/components/onboarding/FinancingGate";
import { useSession } from "@/lib/session/SessionProvider";
import { supplierActions } from "@/lib/funding/funding-domain";
import { useFundingQueue, useSettlement, type TransactionSummary } from "@/lib/funding/useFunding";

/**
 * The supplier's funding screen — the other half of INV-10.
 *
 * A supplier arrives here holding a six-digit code the bank gave them by
 * phone. Entering it correctly, *and only if the bank has recorded settlement
 * evidence*, is what makes the transaction `FUNDED`. Both halves are required
 * and the server enforces it; this screen exists to make the supplier's half
 * possible and to explain what is being waited on the rest of the time.
 *
 * Financing actions stay behind `FinancingGate` (ZM-SON-011) exactly as the
 * placeholder this replaces did — a conditionally-approved supplier must not
 * reach a funding action, and that gate is a client-side courtesy in front of
 * the server's own refusal, never a replacement for it.
 */
export default function SupplierFundingPage() {
  return (
    <FinancingGate>
      <SupplierFundingView />
    </FinancingGate>
  );
}

function SupplierFundingView() {
  const t = useTranslations();
  const params = useParams<{ locale: string }>();
  const locale = params?.locale === "ar" ? "ar" : "en";

  const queue = useFundingQueue(["CONTRACTED", "FUNDING_CONFIRMATION_PENDING", "FUNDED"]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (queue.loading) return <SkeletonText lines={6} />;
  if (queue.error) {
    return <ErrorState title={queue.error} onRetry={queue.reload} retryLabel={t("common.retry")} />;
  }

  const items = queue.data ?? [];
  const selected = items.find((i) => i.id === selectedId) ?? items[0];

  return (
    <div className="max-w-4xl">
      <h1 className="mb-1 text-lg font-semibold">{t("funding.supplier.title")}</h1>
      <p className="mb-5 text-sm text-(--color-muted)">{t("funding.supplier.subtitle")}</p>

      {items.length === 0 ? (
        <EmptyState title={t("funding.supplier.empty")} />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[18rem_1fr]">
          <nav aria-label={t("funding.supplier.queueLabel")} className="flex flex-col gap-2">
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
                <span className="zm-ltr-embed block text-sm font-medium">{item.referenceNumber}</span>
                <span className="mt-2 flex items-center justify-between gap-2">
                  <Badge tone={item.state === "FUNDED" ? "success" : "info"}>
                    {t(`invoices.state.${item.state}`)}
                  </Badge>
                  {item.outstandingAmount && (
                    <MoneyDisplay value={item.outstandingAmount} locale={locale} withCurrency={false} />
                  )}
                </span>
              </button>
            ))}
          </nav>

          {selected?.id && (
            <SupplierFundingDetail
              key={selected.id}
              transaction={selected}
              locale={locale}
              onConfirmed={queue.reload}
            />
          )}
        </div>
      )}
    </div>
  );
}

function SupplierFundingDetail({
  transaction,
  locale,
  onConfirmed,
}: {
  transaction: TransactionSummary;
  locale: "en" | "ar";
  onConfirmed: () => void;
}) {
  const t = useTranslations();
  const { activeMembership } = useSession();
  const settlement = useSettlement(transaction.id);
  const actions = supplierActions(transaction.state ?? "");

  return (
    <div className="flex flex-col gap-4">
      {actions.awaitingBank && (
        <section className="rounded-lg border border-(--color-border) p-4">
          <h2 className="text-sm font-semibold">{t("funding.supplier.awaitingBankTitle")}</h2>
          <p className="mt-1 text-sm text-(--color-muted)">{t("funding.supplier.awaitingBank")}</p>
        </section>
      )}

      {actions.canConfirm && transaction.id && (
        <section className="rounded-lg border border-(--color-border) p-4">
          <h2 className="mb-3 text-sm font-semibold">{t("funding.supplier.confirmTitle")}</h2>
          <ConfirmFundingForm transactionId={transaction.id} onConfirmed={() => onConfirmed()} />
        </section>
      )}

      {actions.isFunded && (
        <p className="rounded-lg border border-(--color-success) bg-(--color-success-bg) p-4 text-sm text-(--color-success)">
          {t("funding.supplier.funded")}
        </p>
      )}

      {settlement.loading && <SkeletonText lines={4} />}
      {settlement.data && (
        <SettlementPanel
          settlement={settlement.data}
          locale={locale}
          // A supplier is never offered a retry: it is their money, but not
          // their payout rail. `canRetryPayout` refuses supplier roles anyway;
          // omitting `onRetry` means the button cannot render at all.
          roles={activeMembership?.roles ?? []}
        />
      )}
    </div>
  );
}
