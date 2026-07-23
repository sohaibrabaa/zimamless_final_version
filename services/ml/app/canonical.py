"""
The canonical invoice field vocabulary.

OCR, QR, and the supplier's typed values are three independent readings of
the same invoice, and the whole point of the extraction service is to let
the API compare them (ZM-DOC-005b, ZM-DOC-008). They can only be compared
if all three speak the same field names, so those names are defined once,
here, and every producer maps into them.

The names match `InvoiceInput` in the frozen API contract exactly, so the
API never has to translate between an ML field name and a contract field
name — a translation layer is somewhere a rename can silently drop a field.

Money is a string everywhere in this system, including here. A JSON number
would have already lost precision by the time the API read it, which is the
same reasoning `Money.from()` uses on the Node side to refuse floats.
"""

from __future__ import annotations

# Field keys shared by OCR output, QR output, and the contract's InvoiceInput.
INVOICE_NUMBER = "invoiceNumber"
EINVOICE_IDENTIFIER = "einvoiceIdentifier"
ISSUE_DATE = "issueDate"
DUE_DATE = "dueDate"
SUBTOTAL_AMOUNT = "subtotalAmount"
TAX_AMOUNT = "taxAmount"
FACE_VALUE = "faceValue"
CURRENCY = "currency"
SELLER_NAME = "sellerName"
SELLER_ESTABLISHMENT_NO = "sellerEstablishmentNumber"
BUYER_NAME = "buyerName"
BUYER_ESTABLISHMENT_NO = "buyerEstablishmentNumber"
PAYMENT_TERMS = "paymentTerms"
PURCHASE_ORDER_NUMBER = "purchaseOrderNumber"
DELIVERY_NOTE_NUMBER = "deliveryNoteNumber"
GOODS_DESCRIPTION = "goodsDescription"

#: Every key this service may emit. The API treats anything outside this set
#: as unrecognised rather than silently trusting it.
CANONICAL_FIELDS: frozenset[str] = frozenset(
    {
        INVOICE_NUMBER,
        EINVOICE_IDENTIFIER,
        ISSUE_DATE,
        DUE_DATE,
        SUBTOTAL_AMOUNT,
        TAX_AMOUNT,
        FACE_VALUE,
        CURRENCY,
        SELLER_NAME,
        SELLER_ESTABLISHMENT_NO,
        BUYER_NAME,
        BUYER_ESTABLISHMENT_NO,
        PAYMENT_TERMS,
        PURCHASE_ORDER_NUMBER,
        DELIVERY_NOTE_NUMBER,
        GOODS_DESCRIPTION,
    }
)

#: Fields whose values are money and therefore 3-dp strings.
MONEY_FIELDS: frozenset[str] = frozenset(
    {SUBTOTAL_AMOUNT, TAX_AMOUNT, FACE_VALUE}
)

#: Fields whose values are ISO dates (YYYY-MM-DD).
DATE_FIELDS: frozenset[str] = frozenset({ISSUE_DATE, DUE_DATE})
