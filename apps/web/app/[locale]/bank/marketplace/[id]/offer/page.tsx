"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { MoneyInput } from "@/components/money/MoneyInput";
import { SkeletonText } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/StatePanels";
import { useListing } from "@/lib/marketplace/useMarketplace";
import { CONDITION_TYPES, RECOURSE_TYPES, TRANSACTION_TYPES, type DraftCondition } from "@/lib/marketplace/offer-domain";

/**
 * Offer creation — a **visual skeleton**, named as such by the Phase 4
 * kickoff ("offer form skeletons"). The fields, layout and catalogues exist
 * and are exercised; submission is not wired to a mock endpoint and the
 * button stays disabled.
 *
 * Deliberately does not compute or display a "net preview" figure. The
 * contract is explicit that `platformCommissionAmount` and
 * `listingFeeAmount` are server-computed, and every prior fabricated-figure
 * defect this project has caught (invented fixtures, invented catalogues)
 * came from a client rendering a number nothing authoritative produced. A
 * skeleton that quietly guessed a commission rate would be exactly that
 * defect, one field earlier than the ones already caught. The real Phase 5
 * session wires this to the create endpoint and gets the live-reconciled
 * preview the phase file calls for.
 */
export default function OfferFormSkeletonPage() {
  const t = useTranslations();
  const params = useParams<{ locale: string; id: string }>();
  const locale = params?.locale === "ar" ? "ar" : "en";
  const id = params?.id;

  const { data: listing, loading, error } = useListing(id);

  const [transactionType, setTransactionType] = useState(TRANSACTION_TYPES[0].value);
  const [recourseType, setRecourseType] = useState(RECOURSE_TYPES[0].value);
  const [grossFundingAmount, setGrossFundingAmount] = useState("");
  const [bankDiscountAmount, setBankDiscountAmount] = useState("");
  const [bankFeesAmount, setBankFeesAmount] = useState("");
  const [otherDeductionsAmount, setOtherDeductionsAmount] = useState("");
  const [expectedPayoutDate, setExpectedPayoutDate] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [conditions, setConditions] = useState<DraftCondition[]>([]);

  const selectedTransactionType = TRANSACTION_TYPES.find((tt) => tt.value === transactionType);
  const selectedRecourseType = RECOURSE_TYPES.find((rt) => rt.value === recourseType);

  function addCondition() {
    setConditions((prev) => [
      ...prev,
      { conditionType: "OTHER", title: "", description: "", isMandatory: false },
    ]);
  }

  function updateCondition(index: number, patch: Partial<DraftCondition>) {
    setConditions((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  }

  function removeCondition(index: number) {
    setConditions((prev) => prev.filter((_, i) => i !== index));
  }

  if (loading) return <SkeletonText lines={6} />;
  if (error || !listing) {
    return <ErrorState title={error ?? t("marketplace.detail.notFound")} />;
  }

  return (
    <div className="max-w-2xl">
      <Link
        href={`/${locale}/bank/marketplace/${id}`}
        className="text-sm text-(--color-muted) underline underline-offset-2"
      >
        {t("marketplace.offer.backToListing")}
      </Link>

      <h1 className="mt-3 mb-1 text-lg font-semibold">{t("marketplace.offer.title")}</h1>
      <p className="mb-2 text-sm text-(--color-muted)">
        {listing.supplier?.legalName} · {listing.invoice?.invoiceNumber}
      </p>

      <p className="mb-5 rounded-lg border border-dashed border-(--color-border) px-4 py-3 text-sm text-(--color-muted)">
        {t("marketplace.offer.skeletonNotice")}
      </p>

      <div className="flex flex-col gap-4">
        <Select
          label={t("marketplace.offer.transactionTypeLabel")}
          value={transactionType}
          onChange={(e) => setTransactionType(e.target.value as typeof transactionType)}
          options={TRANSACTION_TYPES.map((tt) => ({ value: tt.value, label: t(tt.labelKey) }))}
        />
        {selectedTransactionType && (
          <p className="-mt-2 text-xs text-(--color-muted)">{t(selectedTransactionType.explainKey)}</p>
        )}

        <Select
          label={t("marketplace.offer.recourseTypeLabel")}
          value={recourseType}
          onChange={(e) => setRecourseType(e.target.value as typeof recourseType)}
          options={RECOURSE_TYPES.map((rt) => ({ value: rt.value, label: t(rt.labelKey) }))}
        />
        {selectedRecourseType && (
          <p className="-mt-2 text-xs text-(--color-muted)">{t(selectedRecourseType.explainKey)}</p>
        )}

        <MoneyInput
          label={t("marketplace.offer.grossFundingAmount")}
          value={grossFundingAmount}
          onChange={setGrossFundingAmount}
          required
        />
        <MoneyInput
          label={t("marketplace.offer.bankDiscountAmount")}
          value={bankDiscountAmount}
          onChange={setBankDiscountAmount}
        />
        <MoneyInput
          label={t("marketplace.offer.bankFeesAmount")}
          value={bankFeesAmount}
          onChange={setBankFeesAmount}
        />
        <MoneyInput
          label={t("marketplace.offer.otherDeductionsAmount")}
          value={otherDeductionsAmount}
          onChange={setOtherDeductionsAmount}
        />

        {/*
          Commission and listing fee are named here, without a value, rather
          than omitted entirely — the shape of the eventual read-only
          server-computed rows is worth establishing now even though this
          session has nothing authoritative to put in them.
        */}
        <div className="rounded-lg border border-(--color-border) px-4 py-3">
          <p className="text-sm font-medium">{t("marketplace.offer.serverComputedTitle")}</p>
          <p className="mt-1 text-xs text-(--color-muted)">{t("marketplace.offer.serverComputedNote")}</p>
        </div>

        <Input
          label={t("marketplace.offer.expectedPayoutDate")}
          type="date"
          value={expectedPayoutDate}
          onChange={(e) => setExpectedPayoutDate(e.target.value)}
        />
        <Input
          label={t("marketplace.offer.validUntil")}
          type="datetime-local"
          value={validUntil}
          onChange={(e) => setValidUntil(e.target.value)}
          required
        />

        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-medium">{t("marketplace.offer.conditionsTitle")}</p>
            <Button type="button" variant="secondary" size="sm" onClick={addCondition}>
              {t("marketplace.offer.addCondition")}
            </Button>
          </div>
          <div className="flex flex-col gap-3">
            {conditions.map((condition, index) => (
              <div key={index} className="rounded-lg border border-(--color-border) p-3">
                <div className="flex flex-col gap-3">
                  <Select
                    label={t("marketplace.offer.conditionTypeLabel")}
                    value={condition.conditionType}
                    onChange={(e) =>
                      updateCondition(index, { conditionType: e.target.value as DraftCondition["conditionType"] })
                    }
                    options={CONDITION_TYPES.map((ct) => ({ value: ct.value, label: t(ct.labelKey) }))}
                  />
                  <Input
                    label={t("marketplace.offer.conditionTitle")}
                    value={condition.title}
                    onChange={(e) => updateCondition(index, { title: e.target.value })}
                  />
                  <Input
                    label={t("marketplace.offer.conditionDescription")}
                    value={condition.description}
                    onChange={(e) => updateCondition(index, { description: e.target.value })}
                  />
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={condition.isMandatory}
                      onChange={(e) => updateCondition(index, { isMandatory: e.target.checked })}
                    />
                    {t("marketplace.offer.conditionMandatory")}
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="self-start"
                    onClick={() => removeCondition(index)}
                  >
                    {t("marketplace.offer.removeCondition")}
                  </Button>
                </div>
              </div>
            ))}
            {conditions.length === 0 && (
              <p className="text-xs text-(--color-muted)">{t("marketplace.offer.noConditions")}</p>
            )}
          </div>
        </div>
      </div>

      <div className="mt-6">
        <Button type="button" disabled title={t("marketplace.offer.submitDisabledReason")}>
          {t("marketplace.offer.submit")}
        </Button>
        <p className="mt-2 text-xs text-(--color-muted)">{t("marketplace.offer.submitDisabledReason")}</p>
      </div>
    </div>
  );
}
