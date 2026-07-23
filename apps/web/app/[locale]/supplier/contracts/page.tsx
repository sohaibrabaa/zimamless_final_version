"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { FinancingGate } from "@/components/onboarding/FinancingGate";
import { Badge } from "@/components/ui/Badge";
import { SkeletonText } from "@/components/ui/Skeleton";
import { ErrorState, EmptyState } from "@/components/ui/StatePanels";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { useTransactionList } from "@/lib/invoices/useTransactions";
import { transactionStateLabelKey, transactionStateTone } from "@/lib/invoices/transaction-status";

const POST_ACCEPTANCE_STATES = new Set(["OFFER_ACCEPTED", "CONDITIONS_PENDING", "CONTRACTED"]);

/** Financing action — gated by ZM-SON-011 (see components/onboarding/FinancingGate.tsx). */
export default function Page() {
  return (
    <FinancingGate>
      <ContractsList />
    </FinancingGate>
  );
}

/**
 * Every transaction that has reached at least `OFFER_ACCEPTED` — the point
 * a contract can exist for it. No dedicated "list my contracts" endpoint
 * exists in the contract, so this reads the supplier's own transaction
 * list (already scoped server-side) and filters client-side rather than
 * inventing a second endpoint for one screen.
 */
function ContractsList() {
  const t = useTranslations();
  const params = useParams<{ locale: string }>();
  const locale = params?.locale === "ar" ? "ar" : "en";
  const { data, loading, error, reload } = useTransactionList(1, 100);

  if (loading) return <SkeletonText lines={4} />;
  if (error) return <ErrorState title={error} onRetry={reload} retryLabel={t("common.retry")} />;

  const items = (data?.items ?? []).filter((tx) => tx.state && POST_ACCEPTANCE_STATES.has(tx.state));

  return (
    <div>
      <h1 className="mb-4 text-lg font-semibold">{t("nav.contracts")}</h1>
      {items.length === 0 && <EmptyState title={t("marketplace.contract.listEmpty")} />}
      <div className="flex flex-col gap-2">
        {items.map((tx) => (
          <Link
            key={tx.id}
            href={`/${locale}/supplier/invoices/${tx.id}/contract`}
            className="flex items-center justify-between gap-3 rounded-lg border border-(--color-border) p-4 hover:bg-(--color-neutral-bg)"
          >
            <span className="zm-ltr-embed text-sm">{tx.referenceNumber ?? tx.id}</span>
            {tx.state && <Badge tone={transactionStateTone(tx.state)}>{t(transactionStateLabelKey(tx.state))}</Badge>}
          </Link>
        ))}
      </div>
    </div>
  );
}
