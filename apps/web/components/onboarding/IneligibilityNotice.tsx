"use client";

import { useTranslations } from "@/lib/i18n/dictionary-context";

/**
 * ZM-SON-013 ineligibility screen (sole proprietorships and entities that
 * cannot be verified through CCD or a supported licensing authority).
 *
 * Copy rules, deliberately encoded here rather than left to whoever edits the
 * strings next:
 *  - It states a **scope limit of this version of the platform**, not a
 *    judgement about the business. "not eligible in this version" — never
 *    "rejected", "failed", "unqualified", or "ineligible business".
 *  - No warning or danger colouring, no error iconography. This is an outcome,
 *    not a fault.
 *  - It says what *would* change the outcome, so the reader is not left
 *    without a next step.
 */
export function IneligibilityNotice({ establishmentNumber }: { establishmentNumber?: string }) {
  const t = useTranslations();

  return (
    <section className="rounded-lg border border-(--color-border) p-6">
      <h2 className="text-base font-semibold">{t("onboarding.ineligibility.title")}</h2>
      <p className="mt-2 text-sm text-(--color-fg)">{t("onboarding.ineligibility.body")}</p>
      <p className="mt-2 text-sm text-(--color-muted)">{t("onboarding.ineligibility.whyNow")}</p>
      <p className="mt-2 text-sm text-(--color-muted)">{t("onboarding.ineligibility.whatNext")}</p>
      {establishmentNumber && (
        <p className="mt-4 text-xs text-(--color-muted)">
          {t("onboarding.ineligibility.reference")}{" "}
          <span className="zm-ltr-embed">{establishmentNumber}</span>
        </p>
      )}
    </section>
  );
}
