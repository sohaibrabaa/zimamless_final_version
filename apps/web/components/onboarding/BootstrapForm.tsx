"use client";

import { useState } from "react";
import { apiClient, ApiError } from "@/lib/api/client";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";

/**
 * D-04 org bootstrap: one call creates the organization, the SUPPLIER_OWNER
 * membership, and the draft application. Exempt from the X-Organization-Id
 * header because the caller has no organization yet.
 *
 * These two numbers are the *only* business data the supplier types
 * (ZM-SON-001/005) — everything else on the following steps is retrieved and
 * read-only. The form says so explicitly, because a supplier who expects to
 * type their company name will otherwise think the wizard is broken.
 */
export function BootstrapForm({ onCreated }: { onCreated: () => void }) {
  const t = useTranslations();
  const { show } = useToast();
  const [establishmentNumber, setEstablishmentNumber] = useState("");
  const [licenceNumber, setLicenceNumber] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const { error: apiError } = await apiClient.POST("/onboarding/register", {
        body: {
          nationalEstablishmentNumber: establishmentNumber.trim(),
          professionLicenceNumber: licenceNumber.trim(),
        },
      });
      if (apiError) throw apiError;
      show({ title: t("onboarding.bootstrap.created"), tone: "success" });
      onCreated();
    } catch (err) {
      // Branch on the stable error code, not the HTTP status (NOTE D-14).
      const code = err instanceof ApiError ? err.code : "UNKNOWN_ERROR";
      setError(
        code === "ESTABLISHMENT_ALREADY_REGISTERED"
          ? t("onboarding.bootstrap.alreadyRegistered")
          : t("common.unknownError")
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-md">
      <h2 className="text-base font-semibold">{t("onboarding.bootstrap.title")}</h2>
      <p className="mt-1 text-sm text-(--color-muted)">{t("onboarding.bootstrap.subtitle")}</p>
      <p className="mt-2 rounded-md bg-(--color-neutral-bg) px-3 py-2 text-xs text-(--color-neutral-fg)">
        {t("onboarding.bootstrap.derivedNotice")}
      </p>

      <div className="mt-4 flex flex-col gap-4">
        <Input
          label={t("onboarding.field.nationalEstablishmentNumber")}
          hint={t("onboarding.field.nationalEstablishmentNumberHint")}
          value={establishmentNumber}
          onChange={(e) => setEstablishmentNumber(e.target.value)}
          // Latin/numeric identifier: stays LTR inside Arabic UI (RTL checklist #4).
          dir="ltr"
          inputMode="numeric"
          autoComplete="off"
          required
        />
        <Input
          label={t("onboarding.field.professionLicenceNumber")}
          hint={t("onboarding.field.professionLicenceNumberHint")}
          value={licenceNumber}
          onChange={(e) => setLicenceNumber(e.target.value)}
          dir="ltr"
          autoComplete="off"
          required
        />
        {error && (
          <p role="alert" className="text-sm text-(--color-danger)">
            {error}
          </p>
        )}
        <Button type="submit" loading={submitting} className="self-start">
          {t("onboarding.bootstrap.submit")}
        </Button>
      </div>
    </form>
  );
}
