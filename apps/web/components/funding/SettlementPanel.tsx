"use client";

import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { MoneyDisplay } from "@/components/money/MoneyDisplay";
import { breakdownRows, canRetryPayout, settlementTone } from "@/lib/funding/funding-domain";
import type { SettlementFull } from "@/lib/funding/useFunding";

/**
 * The settlement, shown to whichever party is looking at it.
 *
 * Every money component is displayed, not only the net. A supplier who
 * receives 8,390 against a 9,000 offer and cannot see the two deductions that
 * explain the difference will open a support ticket, and rightly — the
 * platform's charges have to be legible at the moment they are taken.
 *
 * The deductions shown are the platform's two (`ZM-FEE-018`: the platform is
 * an agent, not a principal). The bank's own discount and fees were netted off
 * when the offer was priced and are part of the gross the supplier accepted;
 * repeating them here would double-count them on screen.
 */
export function SettlementPanel({
  settlement,
  locale,
  roles,
  onRetry,
  retrying,
}: {
  settlement: SettlementFull;
  locale: "en" | "ar";
  roles: readonly string[];
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const t = useTranslations();
  const status = settlement.status ?? "PENDING";
  const showRetry = !!onRetry && canRetryPayout(status, roles);

  return (
    <section className="rounded-lg border border-(--color-border) p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold">{t("funding.settlement.title")}</h2>
        <Badge tone={settlementTone(status)}>{t(`funding.settlement.status.${status}`)}</Badge>
      </div>

      <dl className="mt-4 grid gap-2">
        {breakdownRows({
          grossFundingAmount: settlement.grossFundingAmount ?? "0.000",
          platformCommissionAmount: settlement.platformCommissionAmount ?? "0.000",
          listingFeeDeducted: settlement.listingFeeDeducted ?? "0.000",
          netSupplierPayout: settlement.netSupplierPayout ?? "0.000",
        }).map((row) => (
          <div
            key={row.key}
            className={
              row.key === "net"
                ? "flex items-baseline justify-between border-t border-(--color-border) pt-2"
                : "flex items-baseline justify-between"
            }
          >
            <dt className="text-sm text-(--color-muted)">{t(`funding.settlement.row.${row.key}`)}</dt>
            <dd>
              {/* A deduction is signed, so the arithmetic on screen adds up
                  rather than requiring the reader to know which lines subtract. */}
              {row.deduction && <span className="me-0.5 text-(--color-muted)">−</span>}
              <MoneyDisplay
                value={row.amount}
                locale={locale}
                emphasis={row.key === "net" ? "strong" : "normal"}
              />
            </dd>
          </div>
        ))}
      </dl>

      {settlement.providerReference && (
        <p className="zm-ltr-embed mt-4 text-xs text-(--color-muted)">
          {t("funding.settlement.providerReference", { reference: settlement.providerReference })}
        </p>
      )}

      {status === "MANUAL_REVIEW" && (
        <p className="mt-3 text-sm text-(--color-danger)">{t("funding.settlement.manualReview")}</p>
      )}

      {status === "PAYOUT_FAILED" && (
        <p className="mt-3 text-sm text-(--color-warning)">
          {t("funding.settlement.failed", {
            attempts: String(settlement.retryCount ?? 0),
          })}
        </p>
      )}

      {showRetry && (
        <Button type="button" variant="secondary" className="mt-3" loading={retrying} onClick={onRetry}>
          {t("funding.settlement.retry")}
        </Button>
      )}
    </section>
  );
}
