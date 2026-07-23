"""
End-to-end extraction over the real seeded e-invoice PDFs.

These are the tests that make the phase's "OCR genuinely running" claim
checkable. They rasterize an actual PDF at 200 dpi and read the pixels with
the real OCR engine — there is no text-layer shortcut and no stubbed
engine, which is why an assertion here failing means extraction genuinely
stopped working rather than a fixture drifting.

They are slower than the rest of the suite (a few seconds for the first,
which loads the ONNX models). That is the cost of testing the thing itself.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app import canonical as C
from app.extraction import run_extraction
from app.ocr import engine_available

SEED_DIR = Path(__file__).resolve().parents[3] / "db" / "seed" / "einvoices"

HAPPY_PATH = SEED_DIR / "INV-2026-0001-alnoor-amman-retail.pdf"
MISMATCH = SEED_DIR / "INV-2026-0002-alnoor-levant-mismatch.pdf"
DUPLICATE_A = SEED_DIR / "INV-2026-0003-alnoor-aqaba-duplicate-a.pdf"
DUPLICATE_B = SEED_DIR / "INV-2026-0003-petra-aqaba-duplicate-b.pdf"

pytestmark = pytest.mark.skipif(
    not SEED_DIR.exists(),
    reason="Seed e-invoices not generated — run services/ml/tools/generate_einvoices.py",
)


@pytest.fixture(scope="module")
def happy():
    return run_extraction(HAPPY_PATH.read_bytes(), "application/pdf")


class TestHappyPath:
    def test_ocr_actually_ran(self, happy) -> None:
        assert engine_available(), "The OCR engine must be installed for this suite"
        assert happy.ocr.available
        assert happy.ocr.raw_output["lineCount"] > 10
        assert happy.ocr.confidence > 0.5

    def test_reads_the_invoice_identity(self, happy) -> None:
        fields = happy.ocr.extracted_fields
        assert fields[C.INVOICE_NUMBER] == "INV-2026-0001"
        assert fields[C.ISSUE_DATE] == "2026-05-10"
        assert fields[C.DUE_DATE] == "2026-08-10"

    def test_reads_the_amounts_as_three_dp_strings(self, happy) -> None:
        fields = happy.ocr.extracted_fields
        assert fields[C.SUBTOTAL_AMOUNT] == "10650.000"
        assert fields[C.TAX_AMOUNT] == "1704.000"
        assert fields[C.FACE_VALUE] == "12354.000"

    def test_reads_both_parties(self, happy) -> None:
        fields = happy.ocr.extracted_fields
        assert fields[C.SELLER_NAME] == "Al-Noor Trading Company"
        assert fields[C.SELLER_ESTABLISHMENT_NO] == "20000101"
        assert fields[C.BUYER_ESTABLISHMENT_NO] == "30000201"

    def test_decodes_the_qr_locally(self, happy) -> None:
        assert happy.qr.parsed
        assert happy.qr.validation_status == "VALID"
        assert happy.qr.schema_name == "zimmamless-pipe-v1"
        assert happy.qr.extracted_fields[C.EINVOICE_IDENTIFIER] == "JO-EINV-20000101-0001"

    def test_ocr_and_qr_agree(self, happy) -> None:
        assert happy.mismatches == []

    def test_preserves_the_raw_payload_and_the_lines(self, happy) -> None:
        # ZM-DOC-006: the machine output is retained independently of any
        # later supplier correction.
        assert happy.qr.raw_output["payloads"][0]["payload"].startswith("JO|")
        assert happy.ocr.raw_output["lines"][0]["text"]

    def test_records_a_content_hash(self, happy) -> None:
        assert len(happy.document_sha256) == 64
        assert happy.page_count == 1


class TestDeliberateMismatch:
    """The seeded OCR-vs-QR disagreement the phase file requires."""

    def test_the_disagreement_is_detected(self) -> None:
        result = run_extraction(MISMATCH.read_bytes(), "application/pdf")
        assert result.mismatches == [
            {"field": C.FACE_VALUE, "ocrValue": "24500.000", "qrValue": "25000.000"}
        ]

    def test_both_readings_are_retained(self) -> None:
        # Neither value is discarded in favour of the other. The supplier
        # resolves it; the platform records what each source said.
        result = run_extraction(MISMATCH.read_bytes(), "application/pdf")
        assert result.ocr.extracted_fields[C.FACE_VALUE] == "24500.000"
        assert result.qr.extracted_fields[C.FACE_VALUE] == "25000.000"


class TestDuplicatePair:
    """
    The two halves of the seeded duplicate carry identical invoice data
    under different sellers — the input the fingerprint check acts on.
    """

    def test_the_pair_shares_invoice_number_date_and_amounts(self) -> None:
        a = run_extraction(DUPLICATE_A.read_bytes(), "application/pdf").ocr.extracted_fields
        b = run_extraction(DUPLICATE_B.read_bytes(), "application/pdf").ocr.extracted_fields
        for key in (C.INVOICE_NUMBER, C.ISSUE_DATE, C.FACE_VALUE, C.TAX_AMOUNT):
            assert a[key] == b[key], key

    def test_but_the_sellers_differ(self) -> None:
        a = run_extraction(DUPLICATE_A.read_bytes(), "application/pdf").ocr.extracted_fields
        b = run_extraction(DUPLICATE_B.read_bytes(), "application/pdf").ocr.extracted_fields
        assert a[C.SELLER_ESTABLISHMENT_NO] == "20000101"
        assert b[C.SELLER_ESTABLISHMENT_NO] == "20000102"


class TestDegradation:
    """Unreadable input is a manual-review outcome, never an exception."""

    def test_garbage_bytes_degrade_rather_than_raise(self) -> None:
        result = run_extraction(b"this is not a document at all", "application/pdf")
        assert result.ocr.available is False
        assert result.ocr.unavailable_reason
        assert result.qr.validation_status == "UNPARSED"
        assert result.ocr.extracted_fields == {}

    def test_empty_input_degrades(self) -> None:
        result = run_extraction(b"", None)
        assert result.ocr.available is False

    def test_a_document_with_no_qr_reports_unavailable_not_unparsed(self) -> None:
        """
        The distinction that matters: "there was no code to read" is not the
        same finding as "there was a code and we could not understand it",
        and only the second warrants manual review of the code itself.
        """
        import fitz

        document = fitz.open()
        page = document.new_page()
        page.insert_text((72, 72), "Invoice Number: INV-NO-QR-0001")
        data = document.tobytes()
        document.close()

        result = run_extraction(data, "application/pdf")
        assert result.qr.validation_status == "UNAVAILABLE"
        assert result.qr.raw_output["detected"] == 0
