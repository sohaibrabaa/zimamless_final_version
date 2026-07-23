"""
Schema-driven field extraction from OCR lines.

Two of these are regression tests for defects that only appeared once real
OCR output was run through the extractor — both were substring matches that
should have been word matches, and both produced plausible output rather
than an obvious failure.
"""

from __future__ import annotations

from app import canonical as C
from app.fields import extract
from app.ocr import OcrLine


def line(text: str, confidence: float = 0.9) -> OcrLine:
    return OcrLine(text=text, confidence=confidence, page_index=0, box=[])


class TestExtraction:
    def test_reads_labelled_fields_from_one_line(self) -> None:
        fields, _ = extract(
            [
                line("Invoice Number: INV-2026-0001"),
                line("Issue Date: 2026-05-10"),
                line("Due Date: 2026-08-10"),
                line("Total: 12354.000 JOD"),
            ]
        )
        assert fields[C.INVOICE_NUMBER].value == "INV-2026-0001"
        assert fields[C.ISSUE_DATE].value == "2026-05-10"
        assert fields[C.DUE_DATE].value == "2026-08-10"
        assert fields[C.FACE_VALUE].value == "12354.000"

    def test_separates_fields_whose_labels_nest(self) -> None:
        fields, _ = extract(
            [
                line("Subtotal: 10650.000 JOD"),
                line("Tax: 1704.000 JOD"),
                line("Total: 12354.000 JOD"),
            ]
        )
        assert fields[C.SUBTOTAL_AMOUNT].value == "10650.000"
        assert fields[C.TAX_AMOUNT].value == "1704.000"
        assert fields[C.FACE_VALUE].value == "12354.000"

    def test_invoice_number_is_not_taken_from_the_purchase_order(self) -> None:
        fields, _ = extract(
            [line("Purchase Order: PO-AR-88120"), line("Invoice Number: INV-2026-0001")]
        )
        assert fields[C.INVOICE_NUMBER].value == "INV-2026-0001"
        assert fields[C.PURCHASE_ORDER_NUMBER].value == "PO-AR-88120"

    def test_records_where_a_value_came_from(self) -> None:
        # Provenance on the page: a mismatch has to be traceable back to
        # what was actually printed, not just to a field name.
        fields, _ = extract([line("Total: 12354.000 JOD", confidence=0.83)])
        extracted = fields[C.FACE_VALUE]
        assert extracted.source_text == "Total: 12354.000 JOD"
        assert extracted.confidence == 0.83

    def test_reads_a_value_from_the_adjacent_cell(self) -> None:
        fields, _ = extract([line("Invoice Number"), line("INV-2026-0001")])
        assert fields[C.INVOICE_NUMBER].value == "INV-2026-0001"


class TestRegressions:
    def test_company_name_containing_a_reject_token_survives(self) -> None:
        """
        Regression: the reject token "no." canonicalizes to "no", which is a
        substring of "noor", so every Al-Noor invoice silently lost its
        seller name. Reject terms must match whole words.
        """
        fields, _ = extract([line("Seller: Al-Noor Trading Company")])
        assert fields[C.SELLER_NAME].value == "Al-Noor Trading Company"

    def test_seller_establishment_line_is_not_read_as_the_seller_name(self) -> None:
        # The whole-word fix must not go so far that the reject stops
        # working: this line still has to be rejected for SELLER_NAME.
        fields, _ = extract([line("Seller Establishment Number: 20000101")])
        assert C.SELLER_NAME not in fields
        assert fields[C.SELLER_ESTABLISHMENT_NO].value == "20000101"

    def test_totals_line_is_not_read_as_the_buyer(self) -> None:
        """
        Regression: the buyer label "to" prefix-matched "total 12354 000
        jod", so a totals line could be extracted as the buyer's name. A
        label must match at a word boundary.
        """
        fields, _ = extract([line("Total: 12354.000 JOD")])
        assert C.BUYER_NAME not in fields
        assert fields[C.FACE_VALUE].value == "12354.000"

    def test_line_item_table_header_does_not_become_the_goods_description(self) -> None:
        """
        Regression: each column header is its own OCR detection, so the
        adjacent-cell fallback read "Description" and took the next header,
        pre-filling the goods description with "Amount".
        """
        fields, _ = extract(
            [line("Description"), line("Quantity"), line("Unit Price"), line("Amount")]
        )
        assert C.GOODS_DESCRIPTION not in fields


class TestDegradation:
    def test_a_malformed_value_is_reported_not_dropped(self) -> None:
        _, rejected = extract([line("Due Date: 45/13/2026")])
        assert rejected[C.DUE_DATE] == "45/13/2026"

    def test_no_guessing_from_unlabelled_numbers(self) -> None:
        # There is deliberately no "biggest number on the page is the total"
        # fallback. An unlabelled page yields nothing.
        fields, _ = extract([line("12354.000"), line("10650.000"), line("1704.000")])
        assert fields == {}

    def test_empty_input(self) -> None:
        fields, rejected = extract([])
        assert fields == {} and rejected == {}

    def test_only_canonical_fields_are_emitted(self) -> None:
        fields, _ = extract(
            [line("Invoice Number: INV-1"), line("Total: 1.000"), line("Unrelated: x")]
        )
        assert set(fields).issubset(C.CANONICAL_FIELDS)
