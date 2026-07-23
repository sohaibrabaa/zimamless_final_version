import type { components } from "@/lib/api/generated/schema";

export type DeclarationInput = components["schemas"]["DeclarationInput"];

/** The eight affirmations, in the order ZM-INV-004 lists them. */
export type DeclarationKey = Exclude<keyof DeclarationInput, "declarationTemplateVersion">;

export interface DeclarationItem {
  key: DeclarationKey;
  /** Full affirmation text — the thing the supplier is actually signing. */
  textKey: string;
}

/**
 * Supplier declarations (requirements §8.4 / ZM-INV-004). All eight are
 * required: the contract types each as `enum: [true]`, so there is no
 * "declined" value to send — an unchecked box means the submission does not
 * happen, not that a `false` is recorded.
 *
 * The wording here is a transcription of ZM-INV-004's bullets. LT-04 marks the
 * final legal wording as post-competition, and the requirement itself says the
 * text is a **versioned template** whose accepted version is stored per
 * submission — but nothing in the frozen pack says what that version string
 * is. `DECLARATION_TEMPLATE_VERSION` below is therefore this half's assumption
 * and must match Agent A's, exactly as the consent catalogue had to (Q-09).
 * Filed as Q-13.
 */
export const DECLARATION_TEMPLATE_VERSION = "1.0";

export const DECLARATIONS: readonly DeclarationItem[] = [
  { key: "isAuthentic", textKey: "invoices.declarations.isAuthentic" },
  { key: "goodsDelivered", textKey: "invoices.declarations.goodsDelivered" },
  { key: "unpaidAndNotCancelled", textKey: "invoices.declarations.unpaidAndNotCancelled" },
  { key: "noKnownDispute", textKey: "invoices.declarations.noKnownDispute" },
  { key: "notPreviouslyFinanced", textKey: "invoices.declarations.notPreviouslyFinanced" },
  { key: "buyerIsNamedEntity", textKey: "invoices.declarations.buyerIsNamedEntity" },
  { key: "contactIsBuyerRep", textKey: "invoices.declarations.contactIsBuyerRep" },
  { key: "acceptsRecourse", textKey: "invoices.declarations.acceptsRecourse" },
] as const;

export function allDeclarationsAffirmed(checked: Partial<Record<DeclarationKey, boolean>>): boolean {
  return DECLARATIONS.every((d) => checked[d.key] === true);
}

/**
 * Builds the request body. Deliberately refuses rather than coercing: sending
 * `false` for an unaffirmed declaration would be recording an affirmation the
 * supplier did not make, and the contract has no shape for it.
 */
export function buildDeclarationBody(
  checked: Partial<Record<DeclarationKey, boolean>>
): DeclarationInput {
  if (!allDeclarationsAffirmed(checked)) {
    throw new Error("All eight declarations must be affirmed before submission (ZM-INV-004).");
  }
  return {
    declarationTemplateVersion: DECLARATION_TEMPLATE_VERSION,
    isAuthentic: true,
    goodsDelivered: true,
    unpaidAndNotCancelled: true,
    noKnownDispute: true,
    notPreviouslyFinanced: true,
    buyerIsNamedEntity: true,
    contactIsBuyerRep: true,
    acceptsRecourse: true,
  };
}
