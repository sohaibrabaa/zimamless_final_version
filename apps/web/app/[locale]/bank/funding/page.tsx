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
import { OneTimeCode } from "@/components/funding/OneTimeCode";
import { SettlementPanel } from "@/components/funding/SettlementPanel";
import { ApiError } from "@/lib/api/client";
import { useSession } from "@/lib/session/SessionProvider";
import { bankActions } from "@/lib/funding/funding-domain";
import {
  generateOtp,
  useFundingQueue,
  useMarkSent,
  useRetryPayout,
  useSettlement,
  type GeneratedOtp,
  type TransactionSummary,
} from "@/lib/funding/useFunding";

/**
 * The bank's funding desk.
 *
 * Two actions live here and there is deliberately no third. The bank records
 * that it executed the transfer, and it issues the one-time code the supplier
 * needs. Neither reaches `FUNDED` — that requires the supplier's confirmation
 * as well (INV-10), and the screen says so in as many words, because an
 * operator who believes "marked sent" finished the job will not chase the
 * confirmation that actually does.
 */
export default function BankFundingPage() {
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
      <h1 className="mb-1 text-lg font-semibold">{t("funding.bank.title")}</h1>
      <p className="mb-5 text-sm text-(--color-muted)">{t("funding.bank.subtitle")}</p>

      {items.length === 0 ? (
        <EmptyState title={t("funding.bank.empty")} />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[18rem_1fr]">
          <nav aria-label={t("funding.bank.queueLabel")} className="flex flex-col gap-2">
            {items.map((item) => (
              <QueueRow
                key={item.id}
                item={item}
                locale={locale}
                selected={item.id === selected?.id}
                onSelect={() => setSelectedId(item.id ?? null)}
              />
            ))}
          </nav>

          {selected?.id && (
            <FundingDetail
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

function QueueRow({
  item,
  locale,
  selected,
  onSelect,
}: {
  item: TransactionSummary;
  locale: "en" | "ar";
  selected: boolean;
  onSelect: () => void;
}) {
  const t = useTranslations();
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected || undefined}
      className={
        "rounded-lg border p-3 text-start transition-colors " +
        (selected
          ? "border-(--color-primary) bg-(--color-neutral-bg)"
          : "border-(--color-border) hover:bg-(--color-neutral-bg)")
      }
    >
      <span className="zm-ltr-embed block text-sm font-medium">{item.referenceNumber}</span>
      <span className="mt-1 block text-xs text-(--color-muted)">{item.buyerName}</span>
      <span className="mt-2 flex items-center justify-between gap-2">
        <Badge tone={item.state === "FUNDED" ? "success" : "info"}>
          {t(`invoices.state.${item.state}`)}
        </Badge>
        {item.outstandingAmount && (
          <MoneyDisplay value={item.outstandingAmount} locale={locale} withCurrency={false} />
        )}
      </span>
    </button>
  );
}

function FundingDetail({
  transaction,
  locale,
  onChanged,
}: {
  transaction: TransactionSummary;
  locale: "en" | "ar";
  onChanged: () => void;
}) {
  const t = useTranslations();
  const { activeMembership } = useSession();
  const roles = activeMembership?.roles ?? [];

  const transactionId = transaction.id ?? "";
  const settlement = useSettlement(transactionId);
  const { markSent } = useMarkSent();
  const { retry } = useRetryPayout();

  const [providerReference, setProviderReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // The plaintext code lives here and only here — component memory, cleared
  // on dismiss and gone when this component unmounts.
  const [issued, setIssued] = useState<GeneratedOtp | null>(null);

  const actions = bankActions(transaction.state ?? "", !!settlement.data);

  async function doMarkSent(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setActionError(null);
    try {
      await markSent(transactionId, { providerReference: providerReference || undefined });
      settlement.reload();
      onChanged();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t("common.unknownError"));
    } finally {
      setBusy(false);
    }
  }

  async function doGenerateOtp() {
    setBusy(true);
    setActionError(null);
    try {
      setIssued(await generateOtp(transactionId));
    } catch (err) {
      setActionError(
        err instanceof ApiError && err.status === 429
          ? t("funding.otp.noResendsLeft")
          : err instanceof ApiError
            ? err.message
            : t("common.unknownError")
      );
    } finally {
      setBusy(false);
    }
  }

  async function doRetry() {
    if (!settlement.data?.id) return;
    setRetrying(true);
    setActionError(null);
    try {
      await retry(settlement.data.id);
      settlement.reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t("common.unknownError"));
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {actions.canMarkSent && (
        <section className="rounded-lg border border-(--color-border) p-4">
          <h2 className="text-sm font-semibold">{t("funding.bank.markSentTitle")}</h2>
          {/* Said plainly, because an operator who thinks this finished the
              job will not chase the confirmation that actually does. */}
          <p className="mt-1 text-xs text-(--color-muted)">{t("funding.bank.markSentNotFunded")}</p>

          <form onSubmit={doMarkSent} className="mt-3 max-w-sm">
            <Input
              label={t("funding.bank.providerReference")}
              hint={t("funding.bank.providerReferenceHint")}
              className="zm-ltr-embed"
              value={providerReference}
              onChange={(e) => setProviderReference(e.target.value)}
            />
            <Button type="submit" className="mt-3" loading={busy}>
              {t("funding.bank.markSentAction")}
            </Button>
          </form>
        </section>
      )}

      {actions.canGenerateOtp && (
        <section className="rounded-lg border border-(--color-border) p-4">
          <h2 className="text-sm font-semibold">{t("funding.bank.otpTitle")}</h2>
          <p className="mt-1 text-xs text-(--color-muted)">{t("funding.bank.otpOutOfBand")}</p>

          <Button
            type="button"
            variant="secondary"
            className="mt-3"
            loading={busy}
            onClick={doGenerateOtp}
          >
            {issued ? t("funding.bank.otpRegenerate") : t("funding.bank.otpGenerate")}
          </Button>

          {issued && (
            <OneTimeCode
              code={issued.otp}
              expiresAt={issued.expiresAt}
              resendsRemaining={issued.resendsRemaining}
              onDismiss={() => setIssued(null)}
            />
          )}
        </section>
      )}

      {transaction.state === "FUNDING_CONFIRMATION_PENDING" && (
        <p className="text-sm text-(--color-muted)">{t("funding.bank.awaitingSupplier")}</p>
      )}

      {settlement.loading && <SkeletonText lines={4} />}
      {settlement.data && (
        <SettlementPanel
          settlement={settlement.data}
          locale={locale}
          roles={roles}
          onRetry={doRetry}
          retrying={retrying}
        />
      )}

      {actionError && <p className="text-sm text-(--color-danger)">{actionError}</p>}
    </div>
  );
}
