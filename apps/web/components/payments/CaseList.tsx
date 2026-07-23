"use client";

import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Badge } from "@/components/ui/Badge";
import { MoneyDisplay } from "@/components/money/MoneyDisplay";
import { EmptyState } from "@/components/ui/StatePanels";
import { isCaseTypeVisibleTo, type CaseType } from "@/lib/payments/payments-domain";
import type { CaseSummary } from "@/lib/payments/usePayments";

/**
 * The case desk — fraud, disputes, withdrawal, recourse in one list.
 *
 * The API already excludes fraud cases from a bank's or supplier's results, so
 * the filter here is redundant. It is deliberate redundancy: the server rule
 * is the one that matters, and this one exists so that a future change to the
 * endpoint cannot quietly start rendering fraud cases on a supplier's screen
 * without also changing a line that says, in words, that it must not.
 */
export function CaseList({
  cases,
  organizationType,
  locale,
}: {
  cases: CaseSummary[];
  organizationType: string | undefined;
  locale: "en" | "ar";
}) {
  const t = useTranslations();

  const visible = cases.filter((c) => isCaseTypeVisibleTo(c.type as CaseType, organizationType));

  if (visible.length === 0) return <EmptyState title={t("payments.cases.empty")} />;

  return (
    <ul className="flex flex-col gap-2">
      {visible.map((item) => (
        <li
          key={`${item.type}-${item.id}`}
          className="rounded-lg border border-(--color-border) p-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Badge tone={item.type === "FRAUD" ? "danger" : "info"}>
                {t(`payments.cases.type.${item.type}`)}
              </Badge>
              <span className="text-sm">{item.status}</span>
            </div>
            {item.amount && <MoneyDisplay value={item.amount} locale={locale} />}
          </div>
          <p className="mt-1 text-xs text-(--color-muted)">
            {t("payments.cases.openedOn", { date: item.openedAt.slice(0, 10) })}
          </p>
        </li>
      ))}
    </ul>
  );
}
