"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { apiClient, ApiError } from "@/lib/api/client";
import { FinancingGate } from "@/components/onboarding/FinancingGate";
import { InvoiceWizard } from "@/components/invoices/InvoiceWizard";
import { Button } from "@/components/ui/Button";
import { ErrorState } from "@/components/ui/StatePanels";
import { useTranslations } from "@/lib/i18n/dictionary-context";

/**
 * Hosts the six-step wizard.
 *
 * The draft transaction is created by an explicit action rather than on mount:
 * `POST /transactions` creates a real row, and a supplier who opens this page
 * and changes their mind should not have left a draft behind. It is also the
 * screen where the listing-fee framing will eventually matter (Phase 4), so
 * "start" being deliberate is the right habit to establish now.
 */
export default function Page() {
  return (
    <FinancingGate>
      <NewInvoice />
    </FinancingGate>
  );
}

function NewInvoice() {
  const t = useTranslations();
  const router = useRouter();
  const params = useParams<{ locale: string }>();
  const locale = params?.locale === "ar" ? "ar" : "en";

  const [transactionId, setTransactionId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startDraft() {
    setError(null);
    setCreating(true);
    try {
      const { data, error: apiError } = await apiClient.POST("/transactions", {});
      if (apiError) throw apiError;
      if (!data?.id) throw new Error("No transaction id returned");
      setTransactionId(data.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("common.unknownError"));
    } finally {
      setCreating(false);
    }
  }

  if (error && !transactionId) {
    return <ErrorState title={error} onRetry={startDraft} retryLabel={t("common.retry")} />;
  }

  if (!transactionId) {
    return (
      <div className="max-w-2xl">
        <h1 className="mb-2 text-lg font-semibold">{t("invoices.new.title")}</h1>
        <p className="mb-5 text-sm text-(--color-muted)">{t("invoices.new.intro")}</p>
        <Button type="button" loading={creating} onClick={startDraft}>
          {t("invoices.new.start")}
        </Button>
      </div>
    );
  }

  return (
    <div className="max-w-3xl">
      <h1 className="mb-4 text-lg font-semibold">{t("invoices.new.title")}</h1>
      <InvoiceWizard
        transactionId={transactionId}
        onSubmitted={() => router.push(`/${locale}/supplier/invoices/${transactionId}`)}
      />
    </div>
  );
}
