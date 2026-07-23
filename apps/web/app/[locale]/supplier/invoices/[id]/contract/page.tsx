"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { SkeletonText } from "@/components/ui/Skeleton";
import { ErrorState, EmptyState } from "@/components/ui/StatePanels";
import { ApiError } from "@/lib/api/client";
import { useSession } from "@/lib/session/SessionProvider";
import { generateContract, signContract, useContract } from "@/lib/contracts/useContracts";

/**
 * Contract review + signing (`GET/POST /transactions/{id}/contract`,
 * `POST /contracts/{id}/sign`). `canonicalLanguage` is always `EN`
 * (ZM-I18N-003b) — the Arabic body is shown for reading, with a note that
 * the English text governs, never the reverse.
 *
 * A non-signatory sees signature status only, per the phase file; the
 * sign button is **absent**, not disabled, for a user whose membership
 * lacks `isAuthorizedSignatory` — the server enforces the same boundary
 * independently (`FORBIDDEN` on `POST /contracts/{id}/sign`).
 */
export default function ContractReviewPage() {
  const t = useTranslations();
  const params = useParams<{ locale: string; id: string }>();
  const locale = params?.locale === "ar" ? "ar" : "en";
  const transactionId = params?.id;
  const { activeMembership } = useSession();

  const { data: contract, loading, error, reload } = useContract(transactionId);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function generate() {
    if (!transactionId) return;
    setBusy(true);
    setActionError(null);
    try {
      await generateContract(transactionId);
      reload();
    } catch (err) {
      setActionError(contractErrorMessage(err, t));
    } finally {
      setBusy(false);
    }
  }

  async function sign() {
    if (!contract?.id) return;
    setBusy(true);
    setActionError(null);
    try {
      await signContract(contract.id);
      reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t("common.unknownError"));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <SkeletonText lines={6} />;
  if (error) return <ErrorState title={error} onRetry={reload} retryLabel={t("common.retry")} />;

  const backLink = (
    <Link
      href={`/${locale}/supplier/invoices/${transactionId}`}
      className="text-sm text-(--color-muted) underline underline-offset-2"
    >
      {t("marketplace.comparison.backToInvoice")}
    </Link>
  );

  if (!contract) {
    return (
      <div className="max-w-2xl">
        {backLink}
        <h1 className="mt-3 mb-1 text-lg font-semibold">{t("marketplace.contract.title")}</h1>
        <EmptyState
          title={t("marketplace.contract.notGenerated")}
          action={
            <Button type="button" disabled={busy} onClick={generate}>
              {busy ? t("common.loading") : t("marketplace.contract.generate")}
            </Button>
          }
        />
        {actionError && <p className="mt-3 text-sm text-(--color-danger)">{actionError}</p>}
      </div>
    );
  }

  const supplierSigned = contract.signatures?.some((s) => s.organizationType === "SUPPLIER");
  const bankSigned = contract.signatures?.some((s) => s.organizationType === "BANK");
  const canSign = !!activeMembership?.isAuthorizedSignatory && !supplierSigned;

  return (
    <div className="max-w-2xl">
      {backLink}

      <div className="mt-3 mb-1 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">{t("marketplace.contract.title")}</h1>
        <Badge tone={contract.status === "FULLY_SIGNED" ? "success" : "info"}>
          {t(`marketplace.contract.status.${contract.status}`)}
        </Badge>
      </div>
      <p className="zm-ltr-embed mb-1 text-xs text-(--color-muted)">{contract.contractNumber}</p>
      <p className="mb-5 text-xs text-(--color-muted)">
        {t("marketplace.contract.templateVersion", { version: contract.templateVersion ?? "—" })} ·{" "}
        {t("marketplace.contract.canonicalLanguageNote")}
      </p>

      <section className="rounded-lg border border-(--color-border) p-4">
        <h2 className="text-sm font-semibold">{t("marketplace.contract.termsSection")}</h2>
        <pre className="zm-ltr-embed mt-3 whitespace-pre-wrap text-start text-sm">
          {locale === "ar" ? contract.bodyAr : contract.bodyEn}
        </pre>
      </section>

      <section className="mt-4 rounded-lg border border-(--color-border) p-4">
        <h2 className="text-sm font-semibold">{t("marketplace.contract.signaturesSection")}</h2>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-xs text-(--color-muted)">{t("marketplace.contract.supplierSignature")}</dt>
            <dd className="mt-0.5">
              <Badge tone={supplierSigned ? "success" : "neutral"}>
                {supplierSigned ? t("marketplace.contract.signed") : t("marketplace.contract.pending")}
              </Badge>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-(--color-muted)">{t("marketplace.contract.bankSignature")}</dt>
            <dd className="mt-0.5">
              <Badge tone={bankSigned ? "success" : "neutral"}>
                {bankSigned ? t("marketplace.contract.signed") : t("marketplace.contract.pending")}
              </Badge>
            </dd>
          </div>
        </dl>

        {canSign && (
          <Button type="button" className="mt-4" disabled={busy} onClick={sign}>
            {busy ? t("common.loading") : t("marketplace.contract.signAction")}
          </Button>
        )}
        {!canSign && !supplierSigned && (
          <p className="mt-4 text-xs text-(--color-muted)">{t("marketplace.contract.notSignatory")}</p>
        )}
        {actionError && <p className="mt-3 text-sm text-(--color-danger)">{actionError}</p>}
      </section>
    </div>
  );
}

function contractErrorMessage(err: unknown, t: (key: string, vars?: Record<string, string>) => string): string {
  if (!(err instanceof ApiError)) return t("common.unknownError");
  if (err.code === "PRE_CONTRACT_CHECK_FAILED") {
    const failures = (err.details?.failures as string[] | undefined) ?? [];
    const labels = failures.map((f) => t(`marketplace.contract.checkFailure.${f}`));
    return labels.length > 0 ? labels.join(" ") : t("marketplace.contract.notReady");
  }
  return err.message || t("common.unknownError");
}
