"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { MoneyInput } from "@/components/money/MoneyInput";
import { MoneyDisplay } from "@/components/money/MoneyDisplay";
import { SkeletonText } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/StatePanels";
import { ApiError } from "@/lib/api/client";
import { useListing } from "@/lib/marketplace/useMarketplace";
import { createOfferForListing } from "@/lib/marketplace/useOffers";
import { computeCommission, computeNetSupplierPayout, LISTING_FEE_AMOUNT } from "@/lib/marketplace/offer-money";
import { isPositiveMoney, isValidMoneyString } from "@/lib/money";
import { CONDITION_TYPES, RECOURSE_TYPES, TRANSACTION_TYPES, type DraftCondition } from "@/lib/marketplace/offer-domain";

/**
 * Offer creation, wired to `POST /listings/{id}/offers/create`.
 *
 * `platformCommissionAmount` and `listingFeeAmount` are computed the same
 * way here (a live preview) and in the mock store (the authoritative
 * figure) — `lib/marketplace/offer-money.ts` is the one place either side
 * reads the formula from, so this preview can never disagree with what the
 * store actually persists (ZM-OFR-003's "server figure wins" still holds:
 * this is presentational only, and a real API's own commission tier could
 * differ from the demo flat rate — nothing here is asserted as final).
 *
 * The below-floor rejection (ZM-MKT-012's design note) renders only the
 * generic message the API sends — this screen never even receives the
 * floor or the shortfall to accidentally show.
 */
export default function OfferFormPage() {
  const t = useTranslations();
  const router = useRouter();
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
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selectedTransactionType = TRANSACTION_TYPES.find((tt) => tt.value === transactionType);
  const selectedRecourseType = RECOURSE_TYPES.find((rt) => rt.value === recourseType);

  const preview = useMemo(() => {
    if (!isValidMoneyString(grossFundingAmount) || !isPositiveMoney(grossFundingAmount)) return null;
    const discount = isValidMoneyString(bankDiscountAmount) ? bankDiscountAmount : "0.000";
    const fees = isValidMoneyString(bankFeesAmount) ? bankFeesAmount : "0.000";
    const other = isValidMoneyString(otherDeductionsAmount) ? otherDeductionsAmount : "0.000";
    const commission = computeCommission(grossFundingAmount);
    const net = computeNetSupplierPayout({
      grossFundingAmount,
      bankDiscountAmount: discount,
      bankFeesAmount: fees,
      platformCommissionAmount: commission,
      unpaidListingFeeAmount: LISTING_FEE_AMOUNT,
      otherDeductionsAmount: other,
    });
    return { commission, net };
  }, [grossFundingAmount, bankDiscountAmount, bankFeesAmount, otherDeductionsAmount]);

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

  async function submit() {
    if (!id || !grossFundingAmount || !validUntil) return;
    setBusy(true);
    setSubmitError(null);
    try {
      await createOfferForListing(id, {
        transactionType,
        recourseType,
        grossFundingAmount,
        bankDiscountAmount: bankDiscountAmount || undefined,
        bankFeesAmount: bankFeesAmount || undefined,
        otherDeductionsAmount: otherDeductionsAmount || undefined,
        expectedPayoutDate: expectedPayoutDate || undefined,
        validUntil: new Date(validUntil).toISOString(),
        conditions,
      });
      router.push(`/${locale}/bank/marketplace/${id}`);
    } catch (err) {
      setSubmitError(offerErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function offerErrorMessage(err: unknown): string {
    if (!(err instanceof ApiError)) return t("common.unknownError");
    switch (err.code) {
      case "OFFER_BELOW_SUPPLIER_REQUIREMENT":
        // ZM-MKT-012's design note: generic wording only, nothing numeric.
        return t("marketplace.offer.belowFloor");
      case "OFFER_WINDOW_CLOSED":
        return t("marketplace.offer.windowClosed");
      case "VALIDATION_FAILED":
        return err.message || t("marketplace.offer.validationFailed");
      case "FORBIDDEN":
        return t("marketplace.offer.notEligible");
      default:
        return err.message || t("common.unknownError");
    }
  }

  if (loading) return <SkeletonText lines={6} />;
  if (error || !listing) {
    return <ErrorState title={error ?? t("marketplace.detail.notFound")} />;
  }

  const alreadyOffered = !!listing.myOffer;
  const canSubmit = !alreadyOffered && !!grossFundingAmount && !!validUntil && !busy;

  return (
    <div className="max-w-2xl">
      <Link
        href={`/${locale}/bank/marketplace/${id}`}
        className="text-sm text-(--color-muted) underline underline-offset-2"
      >
        {t("marketplace.offer.backToListing")}
      </Link>

      <h1 className="mt-3 mb-1 text-lg font-semibold">{t("marketplace.offer.title")}</h1>
      <p className="mb-5 text-sm text-(--color-muted)">
        {listing.supplier?.legalName} · {listing.invoice?.invoiceNumber}
      </p>

      {alreadyOffered && (
        <p className="mb-5 rounded-lg border border-(--color-border) px-4 py-3 text-sm text-(--color-muted)">
          {t("marketplace.offer.alreadyOffered")}
        </p>
      )}

      <div className="flex flex-col gap-4">
        <Select
          label={t("marketplace.offer.transactionTypeLabel")}
          value={transactionType}
          onChange={(e) => setTransactionType(e.target.value as typeof transactionType)}
          options={TRANSACTION_TYPES.map((tt) => ({ value: tt.value, label: t(tt.labelKey) }))}
          disabled={alreadyOffered}
        />
        {selectedTransactionType && (
          <p className="-mt-2 text-xs text-(--color-muted)">{t(selectedTransactionType.explainKey)}</p>
        )}

        <Select
          label={t("marketplace.offer.recourseTypeLabel")}
          value={recourseType}
          onChange={(e) => setRecourseType(e.target.value as typeof recourseType)}
          options={RECOURSE_TYPES.map((rt) => ({ value: rt.value, label: t(rt.labelKey) }))}
          disabled={alreadyOffered}
        />
        {selectedRecourseType && (
          <p className="-mt-2 text-xs text-(--color-muted)">{t(selectedRecourseType.explainKey)}</p>
        )}

        <MoneyInput
          label={t("marketplace.offer.grossFundingAmount")}
          value={grossFundingAmount}
          onChange={setGrossFundingAmount}
          disabled={alreadyOffered}
          required
        />
        <MoneyInput
          label={t("marketplace.offer.bankDiscountAmount")}
          value={bankDiscountAmount}
          onChange={setBankDiscountAmount}
          disabled={alreadyOffered}
        />
        <MoneyInput
          label={t("marketplace.offer.bankFeesAmount")}
          value={bankFeesAmount}
          onChange={setBankFeesAmount}
          disabled={alreadyOffered}
        />
        <MoneyInput
          label={t("marketplace.offer.otherDeductionsAmount")}
          value={otherDeductionsAmount}
          onChange={setOtherDeductionsAmount}
          disabled={alreadyOffered}
        />

        {/*
          A live preview, not the authoritative figure — the store recomputes
          independently on submit and its answer is what actually persists.
        */}
        <div className="rounded-lg border border-(--color-border) px-4 py-3">
          <p className="text-sm font-medium">{t("marketplace.offer.serverComputedTitle")}</p>
          <p className="mt-1 text-xs text-(--color-muted)">{t("marketplace.offer.serverComputedNote")}</p>
          {preview && (
            <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-(--color-muted)">{t("marketplace.offer.platformCommissionAmount")}</dt>
                <dd>
                  <MoneyDisplay value={preview.commission} locale={locale} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-(--color-muted)">{t("marketplace.offer.listingFeeAmount")}</dt>
                <dd>
                  <MoneyDisplay value={LISTING_FEE_AMOUNT} locale={locale} />
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs text-(--color-muted)">{t("marketplace.offer.netSupplierPayoutPreview")}</dt>
                <dd>
                  <MoneyDisplay value={preview.net} locale={locale} emphasis="strong" />
                </dd>
              </div>
            </dl>
          )}
        </div>

        <Input
          label={t("marketplace.offer.expectedPayoutDate")}
          type="date"
          value={expectedPayoutDate}
          onChange={(e) => setExpectedPayoutDate(e.target.value)}
          disabled={alreadyOffered}
        />
        <Input
          label={t("marketplace.offer.validUntil")}
          type="datetime-local"
          value={validUntil}
          onChange={(e) => setValidUntil(e.target.value)}
          disabled={alreadyOffered}
          required
        />

        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-medium">{t("marketplace.offer.conditionsTitle")}</p>
            {!alreadyOffered && (
              <Button type="button" variant="secondary" size="sm" onClick={addCondition}>
                {t("marketplace.offer.addCondition")}
              </Button>
            )}
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

      {submitError && <p className="mt-4 text-sm text-(--color-danger)">{submitError}</p>}

      <div className="mt-6">
        <Button type="button" onClick={submit} disabled={!canSubmit}>
          {busy ? t("common.loading") : t("marketplace.offer.submit")}
        </Button>
      </div>
    </div>
  );
}
