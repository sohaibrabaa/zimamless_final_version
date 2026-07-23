"""
Schema-driven field extraction from OCR text.

The rules live in FIELD_RULES as data. Adding support for another invoice
layout means adding labels to a list, not editing the matcher — the same
property qr_schemas.py has, and for the same reason: a layout-specific
branch inside the extractor is how a parser quietly becomes a hard-coded
assumption about one supplier's stationery.

Two things this deliberately does NOT do:

  - It does not fall back to "the largest number on the page is the total".
    Heuristics of that shape are right often enough to be trusted and wrong
    often enough to matter, and a wrong total that looks confident is worse
    for the supplier than a blank the wizard asks them to fill in
    (ZM-DOC-010's "degrade rather than guess").

  - It does not treat its output as fact. Everything here is a *suggestion*
    for supplier review (ZM-DOC-005a); the supplier's confirmed value wins,
    and both are kept (ZM-DOC-006).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field as dataclass_field
from typing import Callable

from . import canonical as C
from .normalize import (
    normalize_date,
    normalize_establishment_number,
    normalize_money,
    normalize_text,
)
from .ocr import OcrLine

EXTRACTOR_VERSION = "fields-1.0"


@dataclass(frozen=True)
class FieldRule:
    """
    How one canonical field is recognised.

    `labels` are matched case- and punctuation-insensitively against the
    start of a line; the value is whatever follows on the same line, or —
    when a label sits alone in its own cell — the nearest line to its right
    or below (`allow_adjacent`).
    """

    key: str
    labels: tuple[str, ...]
    normalizer: Callable[[str], str | None]
    allow_adjacent: bool = True
    #: Labels that must NOT appear, to separate fields whose names nest.
    #: "Invoice Number" and "Purchase Order Number" both end in "Number",
    #: and "Total" appears inside "Subtotal" and "Total Tax".
    reject: tuple[str, ...] = dataclass_field(default_factory=tuple)


FIELD_RULES: tuple[FieldRule, ...] = (
    FieldRule(
        key=C.INVOICE_NUMBER,
        labels=("invoice number", "invoice no", "invoice #", "رقم الفاتورة"),
        normalizer=normalize_text,
        reject=("purchase order", "delivery note", "e-invoice", "einvoice"),
    ),
    FieldRule(
        key=C.EINVOICE_IDENTIFIER,
        labels=(
            "e-invoice identifier",
            "einvoice identifier",
            "e-invoice id",
            "electronic invoice identifier",
            "uuid",
            "المعرف الالكتروني",
        ),
        normalizer=normalize_text,
    ),
    FieldRule(
        key=C.ISSUE_DATE,
        labels=("issue date", "invoice date", "date of issue", "تاريخ الفاتورة"),
        normalizer=normalize_date,
        reject=("due",),
    ),
    FieldRule(
        key=C.DUE_DATE,
        labels=("due date", "payment due", "maturity date", "تاريخ الاستحقاق"),
        normalizer=normalize_date,
    ),
    FieldRule(
        key=C.SUBTOTAL_AMOUNT,
        labels=("subtotal", "sub total", "net amount", "amount before tax", "المجموع الفرعي"),
        normalizer=normalize_money,
    ),
    FieldRule(
        key=C.TAX_AMOUNT,
        labels=("tax", "vat", "sales tax", "tax amount", "الضريبة"),
        normalizer=normalize_money,
        reject=("number", "no.", "registration", "الرقم"),
    ),
    FieldRule(
        key=C.FACE_VALUE,
        labels=("total", "grand total", "total amount", "amount due", "المجموع الكلي"),
        normalizer=normalize_money,
        reject=("sub", "tax", "before"),
    ),
    FieldRule(
        key=C.CURRENCY,
        labels=("currency", "العملة"),
        normalizer=normalize_text,
    ),
    FieldRule(
        key=C.SELLER_NAME,
        labels=("seller", "supplier", "from", "المورد", "البائع"),
        normalizer=normalize_text,
        reject=("tax", "number", "no.", "id"),
    ),
    FieldRule(
        key=C.SELLER_ESTABLISHMENT_NO,
        labels=(
            "seller establishment number",
            "supplier establishment number",
            "seller establishment no",
            "supplier id",
        ),
        normalizer=normalize_establishment_number,
    ),
    FieldRule(
        key=C.BUYER_NAME,
        labels=("buyer", "customer", "bill to", "sold to", "to", "المشتري", "العميل"),
        normalizer=normalize_text,
        reject=("tax", "number", "no.", "id"),
    ),
    FieldRule(
        key=C.BUYER_ESTABLISHMENT_NO,
        labels=(
            "buyer establishment number",
            "customer establishment number",
            "buyer establishment no",
            "buyer id",
        ),
        normalizer=normalize_establishment_number,
    ),
    FieldRule(
        key=C.PAYMENT_TERMS,
        labels=("payment terms", "terms", "شروط الدفع"),
        normalizer=normalize_text,
    ),
    FieldRule(
        key=C.PURCHASE_ORDER_NUMBER,
        labels=("purchase order", "po number", "po no", "أمر الشراء"),
        normalizer=normalize_text,
    ),
    FieldRule(
        key=C.DELIVERY_NOTE_NUMBER,
        labels=("delivery note", "delivery note number", "grn", "اشعار التسليم"),
        normalizer=normalize_text,
    ),
    FieldRule(
        key=C.GOODS_DESCRIPTION,
        labels=("description", "goods", "services", "الوصف"),
        normalizer=normalize_text,
        # Only from an explicit "Description: <text>" line, never from the
        # neighbouring cell. In a line-items table each column header is its
        # own OCR detection, so the adjacent-cell fallback reads the header
        # "Description" and then takes the NEXT header — pre-filling the
        # goods description with the word "Amount". An empty box the wizard
        # asks the supplier to fill in beats a confidently wrong one, which
        # is the whole of ZM-DOC-010's degrade-rather-than-guess rule.
        allow_adjacent=False,
        reject=("quantity", "unit price", "amount", "line total"),
    ),
)

# Separators between a label and its value on one line.
_SEPARATOR = re.compile(r"^\s*[:：\-–—]\s*")


def _canonicalize_label(text: str) -> str:
    """
    Fold a line to a comparable form.

    Punctuation and spacing vary between layouts and OCR passes ("Invoice
    No." / "Invoice No" / "INVOICE NO:"), and none of that variation carries
    meaning. Digits are kept: they distinguish nothing here but removing
    them would merge "Tax" and "Tax 16%".
    """
    return re.sub(r"[^a-z0-9؀-ۿ]+", " ", text.lower()).strip()


@dataclass(frozen=True)
class ExtractedField:
    value: str
    confidence: float
    #: The OCR line the value was taken from, so a mismatch can be traced
    #: back to what was actually on the page.
    source_text: str
    page_index: int


def extract(lines: list[OcrLine]) -> tuple[dict[str, ExtractedField], dict[str, str]]:
    """
    Pull canonical fields out of OCR lines.

    Returns (fields, rejected). `rejected` holds label matches whose value
    failed normalization — "Due Date: 45/13/2026" is a finding worth
    surfacing, and dropping it would let a garbled date read as an absent
    one.
    """
    fields: dict[str, ExtractedField] = {}
    rejected: dict[str, str] = {}

    prepared = [(_canonicalize_label(line.text), line) for line in lines]

    for rule in FIELD_RULES:
        for index, (canonical_text, line) in enumerate(prepared):
            if rule.key in fields:
                break
            match = _match_label(rule, canonical_text)
            if match is None:
                continue

            raw_value = _value_after_label(line.text, match)
            if not raw_value and rule.allow_adjacent:
                raw_value = _value_from_adjacent(prepared, index)
            if not raw_value:
                continue

            value = rule.normalizer(raw_value)
            if value is None:
                rejected.setdefault(rule.key, raw_value)
                continue
            fields[rule.key] = ExtractedField(
                value=value,
                confidence=line.confidence,
                source_text=line.text,
                page_index=line.page_index,
            )

    return fields, rejected


def _starts_with_word(text: str, prefix: str) -> bool:
    """
    True when `text` begins with `prefix` at a word boundary.

    A plain startswith is wrong here and was wrong in a way that only showed
    up on real data: the buyer label "to" prefix-matches "total 12354 000
    jod", so a totals line could be read as the buyer's name. Requiring the
    prefix to end at a word boundary is the whole fix.
    """
    if not prefix or not text.startswith(prefix):
        return False
    return len(text) == len(prefix) or text[len(prefix)] == " "


def _contains_word(text: str, word: str) -> bool:
    """
    True when `word` appears in `text` as a whole word.

    Substring matching here dropped the seller's name from every Al-Noor
    invoice: the reject token "no." canonicalizes to "no", which is a
    substring of "noor". Company names are full of short tokens that appear
    inside longer ones, so reject terms have to be words.
    """
    if not word:
        return False
    return re.search(rf"(?:^| ){re.escape(word)}(?: |$)", text) is not None


def _match_label(rule: FieldRule, canonical_text: str) -> str | None:
    """The longest label matching the start of the line, or None."""
    if any(_contains_word(canonical_text, _canonicalize_label(bad)) for bad in rule.reject):
        return None
    best: str | None = None
    for label in rule.labels:
        canonical_label = _canonicalize_label(label)
        if _starts_with_word(canonical_text, canonical_label) and (
            best is None or len(canonical_label) > len(best)
        ):
            best = canonical_label
    return best


def _value_after_label(original: str, canonical_label: str) -> str:
    """
    Take what follows the label on the same line.

    The label was matched against a canonicalized copy, so its length there
    does not map onto the original string. Re-finding the label's last word
    in the original is what survives the punctuation differences between the
    two forms.
    """
    words = canonical_label.split()
    if not words:
        return ""
    last_word = words[-1]
    position = original.lower().find(last_word)
    if position < 0:
        return ""
    remainder = original[position + len(last_word) :]
    return _SEPARATOR.sub("", remainder).strip()


def _value_from_adjacent(prepared: list[tuple[str, OcrLine]], index: int) -> str:
    """
    The next non-label line, for layouts where a label sits in its own cell.

    Bounded to the two following lines: further than that and a label in one
    table column starts collecting a value from an unrelated row.
    """
    for offset in (1, 2):
        if index + offset >= len(prepared):
            return ""
        _, candidate = prepared[index + offset]
        text = candidate.text.strip()
        if text and not text.endswith(":"):
            return text
    return ""
