"use client";

import { useState } from "react";
import { apiClient, ApiError } from "@/lib/api/client";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { MoneyDisplay } from "@/components/money/MoneyDisplay";
import { MoneyInput } from "@/components/money/MoneyInput";
import { WizardStepper, type WizardStep } from "@/components/onboarding/WizardStepper";
import { BuyerStep } from "./BuyerStep";
import { DocumentUpload, type UploadedDocument } from "./DocumentUpload";
import { ExtractionComparison } from "./ExtractionComparison";
import { DuplicateBlockedNotice } from "./DuplicateBlockedNotice";
import { EINVOICE_SPEC, SUPPORTING_DOCUMENT_TYPES } from "@/lib/invoices/documents";
import { useExtraction } from "@/lib/invoices/useTransactions";
import {
  COMPARABLE_FIELDS,
  compareFields,
  hasMismatches,
  prefillFromExtraction,
  type ComparableField,
} from "@/lib/invoices/extraction";
import {
  DECLARATIONS,
  DECLARATION_TEMPLATE_VERSION,
  allDeclarationsAffirmed,
  buildDeclarationBody,
  type DeclarationKey,
} from "@/lib/invoices/declarations";
import { readDuplicateBlock, type DuplicateBlock } from "@/lib/invoices/duplicate";
import { buyerStatusLabelKey, buyerStatusTone, contactIsComplete, type Buyer, type BuyerContactInput } from "@/lib/invoices/buyer-rules";
import { isValidMoneyString, compareMoney } from "@/lib/money";

/**
 * The six-step invoice submission wizard (brief §4 Phase 3, phase file B tasks).
 *
 * Each step writes through to its own endpoint as the supplier advances rather
 * than batching everything into the final submit: the contract models the
 * transaction as a draft that is progressively completed (`PUT …/invoice`,
 * `PUT …/buyer`, `PUT …/minimum-amount`, `POST …/declarations`, then
 * `POST …/submit`), and a supplier who closes the tab at step 4 should not lose
 * steps 1–3.
 */

const STEPS: WizardStep[] = [
  { key: "buyer", labelKey: "invoices.wizard.step.buyer" },
  { key: "invoice", labelKey: "invoices.wizard.step.invoice" },
  { key: "documents", labelKey: "invoices.wizard.step.documents" },
  { key: "minimumAmount", labelKey: "invoices.wizard.step.minimumAmount" },
  { key: "declarations", labelKey: "invoices.wizard.step.declarations" },
  { key: "review", labelKey: "invoices.wizard.step.review" },
];

type InvoiceFields = Partial<Record<ComparableField, string>>;

export function InvoiceWizard({
  transactionId,
  onSubmitted,
}: {
  transactionId: string;
  onSubmitted: (state: string | undefined) => void;
}) {
  const t = useTranslations();
  const [stepIndex, setStepIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<DuplicateBlock | null>(null);

  const [buyer, setBuyer] = useState<Buyer | null>(null);
  const [contact, setContact] = useState<Partial<BuyerContactInput>>({});
  const [einvoice, setEinvoice] = useState<UploadedDocument | undefined>();
  const [supporting, setSupporting] = useState<Record<string, UploadedDocument>>({});
  const [fields, setFields] = useState<InvoiceFields>({});
  const [minimumAmount, setMinimumAmount] = useState("");
  const [affirmed, setAffirmed] = useState<Partial<Record<DeclarationKey, boolean>>>({});

  const { data: extraction, loading: extracting, reload: reloadExtraction } = useExtraction(
    einvoice?.documentId
  );
  const comparisons = compareFields(extraction, fields);

  const faceValue = fields.faceValue ?? "";
  const floorTooHigh =
    minimumAmount !== "" &&
    faceValue !== "" &&
    isValidMoneyString(minimumAmount) &&
    isValidMoneyString(faceValue) &&
    compareMoney(minimumAmount, faceValue) > 0;

  function applyPrefill() {
    setFields((current) => prefillFromExtraction(extraction, current));
  }

  const invoiceComplete = COMPARABLE_FIELDS.every((f) => (fields[f] ?? "").trim() !== "");

  async function saveInvoice() {
    const { error: apiError } = await apiClient.PUT("/transactions/{id}/invoice", {
      params: { path: { id: transactionId } },
      body: {
        invoiceNumber: fields.invoiceNumber!,
        einvoiceIdentifier: fields.einvoiceIdentifier!,
        issueDate: fields.issueDate!,
        dueDate: fields.dueDate!,
        subtotalAmount: fields.subtotalAmount!,
        taxAmount: fields.taxAmount!,
        faceValue: fields.faceValue!,
      },
    });
    if (apiError) throw apiError;
  }

  async function saveBuyerLink() {
    if (!buyer?.id) return;
    const { error: apiError } = await apiClient.PUT("/transactions/{id}/buyer", {
      params: { path: { id: transactionId } },
      body: {
        buyerId: buyer.id,
        ...(contactIsComplete(contact) ? { contact: contact as BuyerContactInput } : {}),
      },
    });
    if (apiError) throw apiError;
  }

  async function saveMinimumAmount() {
    const { error: apiError } = await apiClient.PUT("/transactions/{id}/minimum-amount", {
      params: { path: { id: transactionId } },
      body: { minimumAcceptableAmount: minimumAmount },
    });
    if (apiError) throw apiError;
  }

  async function saveDeclarations() {
    const { error: apiError } = await apiClient.POST("/transactions/{id}/declarations", {
      params: { path: { id: transactionId } },
      body: buildDeclarationBody(affirmed),
    });
    if (apiError) throw apiError;
  }

  async function submit() {
    const { data, error: apiError } = await apiClient.POST("/transactions/{id}/submit", {
      params: { path: { id: transactionId } },
    });
    if (apiError) throw apiError;
    onSubmitted(data?.state);
  }

  async function handleNext() {
    setError(null);
    setBusy(true);
    try {
      if (stepIndex === 0) await saveBuyerLink();
      if (stepIndex === 1) await saveInvoice();
      if (stepIndex === 3) await saveMinimumAmount();
      if (stepIndex === 4) await saveDeclarations();
      if (stepIndex === 5) {
        await submit();
        return;
      }
      setStepIndex((i) => i + 1);
    } catch (err) {
      // The console gets the whole story — code, message, and the details
      // object naming exactly which fields the server rejected. The UI copy
      // stays friendly; this is for whoever has DevTools open.
      if (err instanceof ApiError) {
        console.error(
          `[InvoiceWizard] step ${stepIndex} rejected: ${err.status} ${err.code} — ${err.message}\n` +
            JSON.stringify(err.details ?? {}, null, 2) +
            `\ncorrelationId=${err.correlationId ?? "n/a"}`
        );
      } else {
        console.error(`[InvoiceWizard] step ${stepIndex} failed:`, err);
      }
      const block = readDuplicateBlock(err);
      if (block) {
        setDuplicate(block);
        return;
      }
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function errorMessage(err: unknown): string {
    if (!(err instanceof ApiError)) return t("common.unknownError");
    switch (err.code) {
      case "VALIDATION_FAILED":
        return err.message || t("invoices.wizard.validationFailed");
      case "INVALID_STATE_TRANSITION":
        return t("invoices.wizard.invalidState");
      case "BUYER_BLOCKED":
        return t("invoices.buyer.blockedGeneric");
      default:
        return err.message || t("common.unknownError");
    }
  }

  if (duplicate) {
    return (
      <DuplicateBlockedNotice
        block={duplicate}
        onBack={() => {
          setDuplicate(null);
          setStepIndex(1);
        }}
      />
    );
  }

  const canAdvance = (() => {
    switch (stepIndex) {
      case 0:
        return !!buyer;
      case 1:
        return invoiceComplete && !!einvoice;
      case 2:
        return true;
      case 3:
        return minimumAmount !== "" && isValidMoneyString(minimumAmount) && !floorTooHigh;
      case 4:
        return allDeclarationsAffirmed(affirmed);
      default:
        return true;
    }
  })();

  return (
    <div>
      <WizardStepper steps={STEPS} currentIndex={stepIndex} />

      <div className="mt-6">
        {stepIndex === 0 && (
          <BuyerStep
            selectedBuyer={buyer}
            contact={contact}
            onChange={({ buyer: nextBuyer, contact: nextContact }) => {
              setBuyer(nextBuyer);
              setContact(nextContact);
            }}
          />
        )}

        {stepIndex === 1 && (
          <section aria-labelledby="wizard-step-heading">
            <h2 id="wizard-step-heading" className="text-base font-semibold">
              {t("invoices.wizard.step.invoice")}
            </h2>
            <p className="mt-1 mb-4 text-sm text-(--color-muted)">{t("invoices.invoice.intro")}</p>

            <DocumentUpload
              documentType="ELECTRONIC_INVOICE"
              label={t(EINVOICE_SPEC.labelKey)}
              description={t(EINVOICE_SPEC.descriptionKey)}
              transactionId={transactionId}
              uploaded={einvoice}
              onUploaded={setEinvoice}
            />

            {einvoice && (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  loading={extracting}
                  onClick={reloadExtraction}
                >
                  {t("invoices.extraction.refresh")}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={!extraction}
                  onClick={applyPrefill}
                >
                  {t("invoices.extraction.prefill")}
                </Button>
              </div>
            )}

            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <Input
                label={t("invoices.field.invoiceNumber")}
                value={fields.invoiceNumber ?? ""}
                onChange={(e) => setFields({ ...fields, invoiceNumber: e.target.value })}
                dir="ltr"
                required
              />
              <Input
                label={t("invoices.field.einvoiceIdentifier")}
                hint={t("invoices.field.einvoiceIdentifierHint")}
                value={fields.einvoiceIdentifier ?? ""}
                onChange={(e) => setFields({ ...fields, einvoiceIdentifier: e.target.value })}
                dir="ltr"
                required
              />
              <Input
                label={t("invoices.field.issueDate")}
                type="date"
                value={fields.issueDate ?? ""}
                onChange={(e) => setFields({ ...fields, issueDate: e.target.value })}
                required
              />
              <Input
                label={t("invoices.field.dueDate")}
                hint={t("invoices.field.dueDateHint")}
                type="date"
                value={fields.dueDate ?? ""}
                onChange={(e) => setFields({ ...fields, dueDate: e.target.value })}
                required
              />
              <MoneyInput
                label={t("invoices.field.subtotalAmount")}
                value={fields.subtotalAmount ?? ""}
                onChange={(v) => setFields({ ...fields, subtotalAmount: v })}
                required
              />
              <MoneyInput
                label={t("invoices.field.taxAmount")}
                value={fields.taxAmount ?? ""}
                onChange={(v) => setFields({ ...fields, taxAmount: v })}
                required
              />
              <MoneyInput
                label={t("invoices.field.faceValue")}
                hint={t("invoices.field.faceValueHint")}
                value={fields.faceValue ?? ""}
                onChange={(v) => setFields({ ...fields, faceValue: v })}
                required
              />
            </div>

            {einvoice && (
              <div className="mt-6">
                <ExtractionComparison extraction={extraction} comparisons={comparisons} />
                {hasMismatches(comparisons) && (
                  <p className="mt-2 text-sm text-(--color-muted)">
                    {t("invoices.extraction.mismatchGuidance")}
                  </p>
                )}
              </div>
            )}
          </section>
        )}

        {stepIndex === 2 && (
          <section aria-labelledby="wizard-step-heading">
            <h2 id="wizard-step-heading" className="text-base font-semibold">
              {t("invoices.wizard.step.documents")}
            </h2>
            {/* ZM-DOC-002 makes these mandatory-or-conditional *per bank or
                platform policy*, and V3 exposes no endpoint to read that
                policy. So none is required here: blocking a supplier on a rule
                the server does not enforce would be inventing a requirement. */}
            <p className="mt-1 mb-4 text-sm text-(--color-muted)">
              {t("invoices.documents.optionalIntro")}
            </p>
            <div className="flex flex-col gap-3">
              {SUPPORTING_DOCUMENT_TYPES.map((spec) => (
                <DocumentUpload
                  key={spec.type}
                  documentType={spec.type}
                  label={t(spec.labelKey)}
                  description={t(spec.descriptionKey)}
                  transactionId={transactionId}
                  uploaded={supporting[spec.type]}
                  onUploaded={(doc) => setSupporting((prev) => ({ ...prev, [spec.type]: doc }))}
                  onRemoved={() =>
                    setSupporting((prev) => {
                      const next = { ...prev };
                      delete next[spec.type];
                      return next;
                    })
                  }
                />
              ))}
            </div>
          </section>
        )}

        {stepIndex === 3 && (
          <section aria-labelledby="wizard-step-heading" className="max-w-md">
            <h2 id="wizard-step-heading" className="text-base font-semibold">
              {t("invoices.wizard.step.minimumAmount")}
            </h2>
            <p className="mt-1 mb-4 text-sm text-(--color-muted)">{t("invoices.minimum.intro")}</p>
            <MoneyInput
              // The label says NET, and the hint says what net means here,
              // because a supplier who reads this as a gross floor will set it
              // too low and accept less than they meant to.
              label={t("invoices.minimum.label")}
              hint={t("invoices.minimum.hint")}
              value={minimumAmount}
              onChange={setMinimumAmount}
              error={floorTooHigh ? t("invoices.minimum.exceedsFaceValue") : undefined}
              required
            />
            {/* ZM/brief: banks never see this. Stated on the screen where the
                number is entered, not buried in help text elsewhere. */}
            <p className="mt-3 rounded-md border border-(--color-border) px-3 py-2 text-sm text-(--color-muted)">
              {t("invoices.minimum.privacyNote")}
            </p>
          </section>
        )}

        {stepIndex === 4 && (
          <section aria-labelledby="wizard-step-heading">
            <h2 id="wizard-step-heading" className="text-base font-semibold">
              {t("invoices.wizard.step.declarations")}
            </h2>
            <p className="mt-1 text-sm text-(--color-muted)">{t("invoices.declarations.intro")}</p>
            <p className="mt-1 text-xs text-(--color-muted)">
              {t("invoices.declarations.templateVersion", { version: DECLARATION_TEMPLATE_VERSION })}
            </p>
            <ul className="mt-4 flex flex-col gap-3">
              {DECLARATIONS.map((declaration) => (
                <li
                  key={declaration.key}
                  className="rounded-lg border border-(--color-border) px-4 py-3"
                >
                  <label className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 shrink-0"
                      checked={affirmed[declaration.key] === true}
                      onChange={(e) =>
                        setAffirmed((prev) => ({ ...prev, [declaration.key]: e.target.checked }))
                      }
                    />
                    <span className="text-sm">{t(declaration.textKey)}</span>
                  </label>
                </li>
              ))}
            </ul>
            {!allDeclarationsAffirmed(affirmed) && (
              <p className="mt-3 text-xs text-(--color-muted)">
                {t("invoices.declarations.allRequired")}
              </p>
            )}
          </section>
        )}

        {stepIndex === 5 && (
          <section aria-labelledby="wizard-step-heading">
            <h2 id="wizard-step-heading" className="text-base font-semibold">
              {t("invoices.wizard.step.review")}
            </h2>
            <p className="mt-1 mb-4 text-sm text-(--color-muted)">{t("invoices.review.intro")}</p>

            <dl className="grid gap-3 sm:grid-cols-2">
              <ReviewRow label={t("invoices.review.buyer")}>
                <span className="flex flex-wrap items-center gap-2">
                  <span>{buyer?.legalCompanyName ?? "—"}</span>
                  {buyer && (
                    <Badge tone={buyerStatusTone(buyer.registryStatus)}>
                      {t(buyerStatusLabelKey(buyer.registryStatus))}
                    </Badge>
                  )}
                </span>
              </ReviewRow>
              <ReviewRow label={t("invoices.field.invoiceNumber")}>
                <span className="zm-ltr-embed">{fields.invoiceNumber ?? "—"}</span>
              </ReviewRow>
              <ReviewRow label={t("invoices.field.faceValue")}>
                {fields.faceValue && isValidMoneyString(fields.faceValue) ? (
                  <MoneyDisplay value={fields.faceValue} />
                ) : (
                  "—"
                )}
              </ReviewRow>
              <ReviewRow label={t("invoices.field.dueDate")}>
                <span className="zm-ltr-embed">{fields.dueDate ?? "—"}</span>
              </ReviewRow>
              <ReviewRow label={t("invoices.minimum.reviewLabel")}>
                {minimumAmount && isValidMoneyString(minimumAmount) ? (
                  <MoneyDisplay value={minimumAmount} />
                ) : (
                  "—"
                )}
              </ReviewRow>
              <ReviewRow label={t("invoices.review.documents")}>
                {String(1 + Object.keys(supporting).length)}
              </ReviewRow>
            </dl>

            <p className="mt-4 text-xs text-(--color-muted)">{t("invoices.review.submitNotice")}</p>
          </section>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-4 text-sm text-(--color-danger)">
          {error}
        </p>
      )}

      <div className="mt-6 flex items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          disabled={stepIndex === 0 || busy}
          onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
        >
          {t("common.back")}
        </Button>
        <Button type="button" loading={busy} disabled={!canAdvance} onClick={handleNext}>
          {stepIndex === STEPS.length - 1 ? t("invoices.wizard.submit") : t("common.next")}
        </Button>
      </div>
    </div>
  );
}

function ReviewRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-(--color-muted)">{label}</dt>
      <dd className="mt-0.5 text-sm">{children}</dd>
    </div>
  );
}
