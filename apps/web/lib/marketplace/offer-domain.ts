import type { components } from "@/lib/api/generated/schema";

export type TransactionType = NonNullable<components["schemas"]["OfferInput"]["transactionType"]>;
export type RecourseType = NonNullable<components["schemas"]["OfferInput"]["recourseType"]>;
export type ConditionType = NonNullable<
  NonNullable<components["schemas"]["OfferInput"]["conditions"]>[number]["conditionType"]
>;

/**
 * Transaction and recourse type catalogues, with plain-language explanation
 * keys. The phase file requires the *comparison* screen (supplier side) to
 * show these with plain-language explanations; the offer creation form
 * (bank side, this file's consumer) gets the same catalogue because a maker
 * choosing between them needs the same explanation the supplier will later
 * see, and a divergent explanation on either side would be its own defect.
 */
export const TRANSACTION_TYPES: readonly { value: TransactionType; labelKey: string; explainKey: string }[] = [
  {
    value: "INVOICE_FINANCING",
    labelKey: "marketplace.offer.transactionType.INVOICE_FINANCING",
    explainKey: "marketplace.offer.transactionTypeExplain.INVOICE_FINANCING",
  },
  {
    value: "RECEIVABLE_PURCHASE",
    labelKey: "marketplace.offer.transactionType.RECEIVABLE_PURCHASE",
    explainKey: "marketplace.offer.transactionTypeExplain.RECEIVABLE_PURCHASE",
  },
  {
    value: "RECEIVABLE_ASSIGNMENT",
    labelKey: "marketplace.offer.transactionType.RECEIVABLE_ASSIGNMENT",
    explainKey: "marketplace.offer.transactionTypeExplain.RECEIVABLE_ASSIGNMENT",
  },
  { value: "OTHER", labelKey: "marketplace.offer.transactionType.OTHER", explainKey: "marketplace.offer.transactionTypeExplain.OTHER" },
] as const;

export const RECOURSE_TYPES: readonly { value: RecourseType; labelKey: string; explainKey: string }[] = [
  {
    value: "FULL_RECOURSE",
    labelKey: "marketplace.offer.recourseType.FULL_RECOURSE",
    explainKey: "marketplace.offer.recourseTypeExplain.FULL_RECOURSE",
  },
  {
    value: "LIMITED_RECOURSE",
    labelKey: "marketplace.offer.recourseType.LIMITED_RECOURSE",
    explainKey: "marketplace.offer.recourseTypeExplain.LIMITED_RECOURSE",
  },
  {
    value: "NON_RECOURSE",
    labelKey: "marketplace.offer.recourseType.NON_RECOURSE",
    explainKey: "marketplace.offer.recourseTypeExplain.NON_RECOURSE",
  },
  { value: "OTHER", labelKey: "marketplace.offer.recourseType.OTHER", explainKey: "marketplace.offer.recourseTypeExplain.OTHER" },
] as const;

export const CONDITION_TYPES: readonly { value: ConditionType; labelKey: string }[] = [
  { value: "REQUIRED_GUARANTEE", labelKey: "marketplace.offer.conditionType.REQUIRED_GUARANTEE" },
  { value: "REQUIRED_DOCUMENT", labelKey: "marketplace.offer.conditionType.REQUIRED_DOCUMENT" },
  { value: "RECOURSE_TERM", labelKey: "marketplace.offer.conditionType.RECOURSE_TERM" },
  { value: "FUNDING_TIMELINE", labelKey: "marketplace.offer.conditionType.FUNDING_TIMELINE" },
  { value: "CONTRACTUAL_CONDITION", labelKey: "marketplace.offer.conditionType.CONTRACTUAL_CONDITION" },
  { value: "OTHER", labelKey: "marketplace.offer.conditionType.OTHER" },
] as const;

export interface DraftCondition {
  conditionType: ConditionType;
  title: string;
  description: string;
  isMandatory: boolean;
}
