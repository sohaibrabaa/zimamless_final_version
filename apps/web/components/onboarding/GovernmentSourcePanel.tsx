"use client";

import { useI18n, useTranslations } from "@/lib/i18n/dictionary-context";
import { Badge } from "@/components/ui/Badge";
import { formatDate } from "@/lib/onboarding/sla";
import type { components } from "@/lib/api/generated/schema";
import {
  GOVERNMENT_SOURCES,
  type GovernmentField,
  type GovernmentSource,
} from "@/lib/onboarding/government";

type GovernmentRequest = components["schemas"]["GovernmentRequest"];

/** The three sources onboarding queries (requirements §5.3); EINVOICE belongs to invoice submission. */
const ONBOARDING_SOURCES: GovernmentSource[] = GOVERNMENT_SOURCES.filter(
  (s): s is GovernmentSource => s !== "EINVOICE"
);

interface SourceRow {
  source: GovernmentSource;
  request?: GovernmentRequest;
  fieldCount: number;
}

/**
 * Per-source availability, kept visually and semantically separate from the
 * data itself.
 *
 * The whole point of this panel is `sourceAvailable` (ZM-GOV-008): "the source
 * did not answer" is a *neutral* operational fact and must never be styled or
 * worded as a finding against the supplier (ZM-SON-010, ZM-GOV-003). Hence no
 * warning colours, no downward arrows, and copy that says the registry has not
 * responded — not that anything is missing or wrong.
 *
 * Falls back to reconstructing rows from the retrieved fields when the API
 * doesn't send `governmentRequests` (Q-08): a source that answered with nothing
 * at all is then shown as "not yet retrieved", which is the honest reading of
 * what we actually know in that case.
 */
export function GovernmentSourcePanel({
  requests,
  fields,
}: {
  requests: GovernmentRequest[] | undefined;
  fields: GovernmentField[];
}) {
  const t = useTranslations();
  const { locale } = useI18n();

  const rows: SourceRow[] = ONBOARDING_SOURCES.map((source) => ({
    source,
    request: requests?.find((r) => r.source === source),
    fieldCount: fields.filter((f) => f.source === source && f.value !== null).length,
  }));

  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold">{t("onboarding.government.sourcesTitle")}</h3>
      <p className="mb-3 text-xs text-(--color-muted)">
        {t("onboarding.government.sourcesExplainer")}
      </p>
      <ul className="divide-y divide-(--color-border) rounded-lg border border-(--color-border)">
        {rows.map(({ source, request, fieldCount }) => {
          const answered = request ? request.sourceAvailable !== false : fieldCount > 0;
          const pending = request?.status === "PENDING";
          const retrieved = formatDate(request?.retrievedAt, locale);
          const validUntil = formatDate(request?.validUntil, locale);

          return (
            <li key={source} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <div>
                <p className="text-sm font-medium">{t(`onboarding.government.source.${source}`)}</p>
                <p className="text-xs text-(--color-muted)">
                  {t(`onboarding.government.sourceDescription.${source}`)}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {/* Neutral tone in every branch — see the note above. */}
                <Badge tone={answered && !pending ? "success" : "neutral"}>
                  {pending
                    ? t("onboarding.government.availability.PENDING")
                    : answered
                      ? t("onboarding.government.availability.ANSWERED")
                      : t("onboarding.government.availability.NO_RESPONSE")}
                </Badge>
                {retrieved && (
                  <span className="text-xs text-(--color-muted)">
                    {t("onboarding.government.retrievedOn", { date: retrieved })}
                  </span>
                )}
                {validUntil && (
                  <span className="text-xs text-(--color-muted)">
                    {t("onboarding.government.validUntil", { date: validUntil })}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {rows.some((r) => r.request?.sourceAvailable === false) && (
        <p className="mt-2 rounded-md bg-(--color-neutral-bg) px-3 py-2 text-xs text-(--color-neutral-fg)">
          {t("onboarding.government.noResponseExplainer")}
        </p>
      )}
    </div>
  );
}
