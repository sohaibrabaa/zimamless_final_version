"use client";

import Link from "next/link";
import { useState } from "react";
import { useParams } from "next/navigation";
import { FinancingGate } from "@/components/onboarding/FinancingGate";
import { VerificationPanel } from "@/components/invoices/VerificationPanel";
import { RiskPanel } from "@/components/risk/RiskPanel";
import { ListingActivationPanel } from "@/components/marketplace/ListingActivationPanel";
import { Badge } from "@/components/ui/Badge";
import { SkeletonText } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/StatePanels";
import { MoneyDisplay } from "@/components/money/MoneyDisplay";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import {
  requestDownloadUrl,
  useTransaction,
  useVerificationRun,
  type TransactionDocument,
} from "@/lib/invoices/useTransactions";
import {
  hasVerificationRun,
  transactionStateLabelKey,
  transactionStateTone,
} from "@/lib/invoices/transaction-status";
import { buyerStatusLabelKey, buyerStatusTone } from "@/lib/invoices/buyer-rules";
import { useRiskAssessment } from "@/lib/risk/useRiskAssessment";

export default function Page() {
  return (
    <FinancingGate>
      <TransactionDetail />
    </FinancingGate>
  );
}

function TransactionDetail() {
  const t = useTranslations();
  const params = useParams<{ locale: string; id: string }>();
  const locale = params?.locale === "ar" ? "ar" : "en";
  const id = params?.id;

  const { data: transaction, loading, error, reload } = useTransaction(id);
  const { data: verification, loading: verificationLoading } = useVerificationRun(
    id,
    hasVerificationRun(transaction?.state)
  );
  const { data: risk, loading: riskLoading } = useRiskAssessment(
    id,
    hasVerificationRun(transaction?.state)
  );

  if (loading) return <SkeletonText lines={6} />;

  if (error || !transaction) {
    return (
      <ErrorState
        title={error ?? t("invoices.detail.notFound")}
        onRetry={reload}
        retryLabel={t("common.retry")}
      />
    );
  }

  const invoice = transaction.invoice;

  return (
    <div className="max-w-3xl">
      <Link
        href={`/${locale}/supplier/invoices`}
        className="text-sm text-(--color-muted) underline underline-offset-2"
      >
        {t("invoices.detail.backToList")}
      </Link>

      <div className="mt-3 mb-5 flex flex-wrap items-center gap-3">
        <h1 className="zm-ltr-embed text-lg font-semibold">
          {transaction.referenceNumber ?? transaction.id}
        </h1>
        <Badge tone={transactionStateTone(transaction.state)}>
          {t(transactionStateLabelKey(transaction.state))}
        </Badge>
      </div>

      <section className="rounded-lg border border-(--color-border) p-4">
        <h2 className="text-sm font-semibold">{t("invoices.detail.invoiceSection")}</h2>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          <Row label={t("invoices.field.invoiceNumber")}>
            <span className="zm-ltr-embed">{invoice?.invoiceNumber ?? "—"}</span>
          </Row>
          <Row label={t("invoices.field.einvoiceIdentifier")}>
            <span className="zm-ltr-embed">{invoice?.einvoiceIdentifier ?? "—"}</span>
          </Row>
          <Row label={t("invoices.field.issueDate")}>
            <span className="zm-ltr-embed">{invoice?.issueDate ?? "—"}</span>
          </Row>
          <Row label={t("invoices.field.dueDate")}>
            <span className="zm-ltr-embed">{invoice?.dueDate ?? "—"}</span>
          </Row>
          <Row label={t("invoices.field.faceValue")}>
            {invoice?.faceValue ? <MoneyDisplay value={invoice.faceValue} locale={locale} /> : "—"}
          </Row>
          <Row label={t("invoices.field.outstandingAmount")}>
            {invoice?.outstandingAmount ? (
              <MoneyDisplay value={invoice.outstandingAmount} locale={locale} />
            ) : (
              "—"
            )}
          </Row>
        </dl>
      </section>

      {transaction.buyer && (
        <section className="mt-4 rounded-lg border border-(--color-border) p-4">
          <h2 className="text-sm font-semibold">{t("invoices.detail.buyerSection")}</h2>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-sm">{transaction.buyer.legalCompanyName}</span>
            <Badge tone={buyerStatusTone(transaction.buyer.registryStatus)}>
              {t(buyerStatusLabelKey(transaction.buyer.registryStatus))}
            </Badge>
          </div>
          <p className="zm-ltr-embed mt-1 text-xs text-(--color-muted)">
            {transaction.buyer.nationalEstablishmentNumber}
          </p>
        </section>
      )}

      {/*
        The floor. This is a supplier view, so it renders — and it renders with
        the privacy statement attached, because the whole point of the field is
        that the supplier can trust it stays private. `minimumAcceptableAmount`
        is absent from bank-facing responses by contract; no bank component
        reads this section, and none should ever import from here.
      */}
      {transaction.minimumAcceptableAmount && (
        <section className="mt-4 rounded-lg border border-(--color-border) p-4">
          <h2 className="text-sm font-semibold">{t("invoices.minimum.reviewLabel")}</h2>
          <p className="mt-2">
            <MoneyDisplay value={transaction.minimumAcceptableAmount} locale={locale} emphasis="strong" />
          </p>
          <p className="mt-2 text-xs text-(--color-muted)">{t("invoices.minimum.privacyNote")}</p>
        </section>
      )}

      {transaction.documents && transaction.documents.length > 0 && (
        <section className="mt-4 rounded-lg border border-(--color-border) p-4">
          <h2 className="text-sm font-semibold">{t("invoices.detail.documentsSection")}</h2>
          <ul className="mt-3 flex flex-col gap-2">
            {transaction.documents.map((doc) => (
              <DocumentRow key={doc.id} document={doc} />
            ))}
          </ul>
        </section>
      )}

      {hasVerificationRun(transaction.state) && (
        <section className="mt-4">
          <VerificationPanel run={verification} loading={verificationLoading} />
        </section>
      )}

      {/*
        Requirements §9 scopes the Trust Score to bank underwriting (ZM-RSK-012
        names the audience as "an eligible bank"), but nothing forbids the
        supplier seeing their own — and a supplier watching their own score
        exist is a reasonable transparency default given §9.1's plain-language
        disclaimer already governs every display. Loading state only, never a
        hard error: a transaction that has not been scored yet is normal, not
        broken.
      */}
      {hasVerificationRun(transaction.state) && !riskLoading && risk && (
        <section className="mt-4">
          <h2 className="mb-2 text-sm font-semibold">{t("risk.sectionTitle")}</h2>
          <RiskPanel assessment={risk} />
        </section>
      )}

      {id && (transaction.state === "ELIGIBLE" || transaction.state === "OPEN_FOR_OFFERS") && (
        <ListingActivationPanel
          transactionId={id}
          locale={locale}
          eligible={transaction.state === "ELIGIBLE"}
          onActivated={reload}
        />
      )}
    </div>
  );
}

/**
 * One attached document, with its download.
 *
 * The signed URL is requested on click rather than with the transaction: it
 * lives about two minutes, so minting one per rendered row would hand out
 * credentials nobody uses and hold an expired link by the time a supplier
 * reads the page. A refusal is a 404 by design (a document that is not yours
 * is indistinguishable from one that does not exist), so both cases get the
 * same neutral message.
 */
function DocumentRow({ document: doc }: { document: TransactionDocument }) {
  const t = useTranslations();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function open() {
    if (!doc.id) return;
    setBusy(true);
    setFailed(false);
    try {
      const url = await requestDownloadUrl(doc.id);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <span>{t(`invoices.documents.type.${doc.documentType}`)}</span>
      <span className="flex flex-wrap items-center gap-3">
        <span className="zm-ltr-embed text-xs text-(--color-muted)">{doc.fileName}</span>
        <button
          type="button"
          onClick={open}
          disabled={busy || !doc.id}
          className="text-xs underline underline-offset-2 disabled:opacity-50"
        >
          {busy ? t("common.loading") : t("invoices.documents.download")}
        </button>
      </span>
      {failed && (
        <p className="w-full text-xs text-(--color-muted)">
          {t("invoices.documents.downloadUnavailable")}
        </p>
      )}
    </li>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-(--color-muted)">{label}</dt>
      <dd className="mt-0.5 text-sm">{children}</dd>
    </div>
  );
}
