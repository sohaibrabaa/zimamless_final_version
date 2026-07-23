"use client";

import { useI18n, useTranslations } from "@/lib/i18n/dictionary-context";
import { Badge } from "@/components/ui/Badge";
import { formatDate } from "@/lib/onboarding/sla";
import type { GovernmentField } from "@/lib/onboarding/government";
import { sortGovernmentFields } from "@/lib/onboarding/government";

/**
 * Government-derived data, rendered read-only with a source badge and
 * retrieval date (brief §5, ZM-SON-003, ZM-GOV-002).
 *
 * There is no editable variant of this component and there must never be one:
 * ZM-SON-003 forbids editing a government-sourced value for *any* user
 * including administrators — corrections are made by re-querying the source.
 *
 * A blank value is rendered with neutral styling and the words "not provided
 * by the source" — never a warning colour, never an icon implying something is
 * wrong (ZM-GOV-003, brief §5 "Score vs. availability").
 */
export function GovernmentFieldList({ fields }: { fields: GovernmentField[] }) {
  const t = useTranslations();
  const { locale } = useI18n();

  if (fields.length === 0) {
    return (
      <p className="rounded-lg border border-(--color-border) px-4 py-6 text-sm text-(--color-muted)">
        {t("onboarding.government.nothingRetrievedYet")}
      </p>
    );
  }

  return (
    <dl className="divide-y divide-(--color-border) rounded-lg border border-(--color-border)">
      {sortGovernmentFields(fields).map((field) => {
        const retrieved = formatDate(field.retrievedAt, locale);
        return (
          <div key={field.name} className="grid gap-1 px-4 py-3 sm:grid-cols-3 sm:gap-4">
            <dt className="text-sm font-medium text-(--color-muted)">
              {t(`onboarding.government.field.${field.name}`)}
            </dt>
            <dd className="sm:col-span-2">
              {field.value === null ? (
                <span className="text-sm text-(--color-muted)">
                  {t("onboarding.government.notProvidedBySource")}
                </span>
              ) : (
                // Establishment numbers, tax numbers and Latin names must not
                // visually reorder inside Arabic text (RTL checklist #4).
                <span className="zm-ltr-embed text-sm text-(--color-fg)">{field.value}</span>
              )}
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {field.source && (
                  <Badge tone="info">{t(`onboarding.government.source.${field.source}`)}</Badge>
                )}
                {field.sourceKind === "SELF_DECLARED" && (
                  <Badge tone="neutral">{t("onboarding.government.selfDeclared")}</Badge>
                )}
                {retrieved && (
                  <span className="text-xs text-(--color-muted)">
                    {t("onboarding.government.retrievedOn", { date: retrieved })}
                  </span>
                )}
              </div>
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
