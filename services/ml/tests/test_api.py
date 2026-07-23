"""The HTTP surface the Node API calls."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

SEED_DIR = Path(__file__).resolve().parents[3] / "db" / "seed" / "einvoices"
HAPPY_PATH = SEED_DIR / "INV-2026-0001-alnoor-amman-retail.pdf"


class TestHealth:
    def test_reports_ok(self) -> None:
        response = client.get("/health")
        assert response.status_code == 200
        assert response.json()["status"] == "ok"

    def test_reports_ocr_availability_separately_from_liveness(self) -> None:
        # A service that decodes QR codes but cannot OCR is degraded, not
        # down — the API should keep calling it, so the two facts are
        # reported separately.
        body = client.get("/health").json()
        assert "ocrEngineAvailable" in body
        assert isinstance(body["ocrEngineAvailable"], bool)


class TestExtract:
    @pytest.mark.skipif(not HAPPY_PATH.exists(), reason="seed e-invoices not generated")
    def test_extracts_a_real_invoice(self) -> None:
        with HAPPY_PATH.open("rb") as handle:
            response = client.post(
                "/extract",
                files={"file": ("invoice.pdf", handle, "application/pdf")},
            )
        assert response.status_code == 200
        body = response.json()
        assert body["ocr"]["available"] is True
        assert body["ocr"]["extractedFields"]["invoiceNumber"] == "INV-2026-0001"
        assert body["qr"]["validationStatus"] == "VALID"
        assert len(body["documentSha256"]) == 64

    def test_unreadable_content_is_200_with_a_degraded_body(self) -> None:
        # Not a 500: the supplier uploaded something and "manual review" is
        # a supported outcome. A 5xx would teach the client nothing and
        # would look like our fault rather than the file's.
        response = client.post(
            "/extract", files={"file": ("junk.pdf", b"not a pdf", "application/pdf")}
        )
        assert response.status_code == 200
        body = response.json()
        assert body["ocr"]["available"] is False
        assert body["qr"]["validationStatus"] == "UNPARSED"

    def test_empty_upload_is_refused(self) -> None:
        response = client.post("/extract", files={"file": ("empty.pdf", b"", "application/pdf")})
        assert response.status_code == 400

    def test_oversized_upload_is_refused(self, monkeypatch) -> None:
        monkeypatch.setattr("app.main.MAX_UPLOAD_BYTES", 10)
        response = client.post(
            "/extract", files={"file": ("big.pdf", b"%PDF-" + b"x" * 100, "application/pdf")}
        )
        assert response.status_code == 413


class TestValidateEndpoint:
    def test_valid_identifier(self) -> None:
        response = client.post(
            "/einvoice/validate", json={"identifier": "JO-EINV-20000101-0001"}
        )
        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "VALID"
        assert body["sourceAvailable"] is True

    def test_unavailable_is_distinct_from_not_found(self) -> None:
        unavailable = client.post(
            "/einvoice/validate", json={"identifier": "JO-EINV-90000001-0001"}
        ).json()
        not_found = client.post(
            "/einvoice/validate", json={"identifier": "JO-EINV-90000002-0001"}
        ).json()
        assert unavailable["sourceAvailable"] is False
        assert not_found["sourceAvailable"] is True
