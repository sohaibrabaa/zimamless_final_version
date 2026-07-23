"""The /risk/score HTTP surface, including its degraded contract."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from app.risk import inference

client = TestClient(app)

CLEAN = {
    "tenorDays": 90,
    "faceValue": 12354.0,
    "subtotalAmount": 10650.0,
    "taxAmount": 1704.0,
    "completenessRatio": 1.0,
    "duplicateCollision": False,
    "electronicInvoiceAttached": True,
    "partiallyPaid": False,
    "priorSubmittedCount": 4,
    "disputeCount": 0,
    "duplicateReferralCount": 0,
    "recourseCount": 0,
}


class TestHealth:
    def test_reports_risk_model_availability(self) -> None:
        body = client.get("/health").json()
        assert body["riskModelAvailable"] is True


class TestScore:
    def test_scores_a_clean_transaction(self) -> None:
        response = client.post("/risk/score", json=CLEAN)
        assert response.status_code == 200
        body = response.json()
        assert body["modelAvailable"] is True
        assert 0.0 <= body["riskProbability"] <= 1.0
        assert body["modelVersion"]

    def test_returns_contributions_with_direction(self) -> None:
        body = client.post("/risk/score", json=CLEAN).json()
        assert body["contributions"]
        assert {"feature", "label", "contribution", "direction"} <= set(
            body["contributions"][0]
        )

    def test_declares_the_training_data_synthetic(self) -> None:
        # ZM-RSK-016 — the caller cannot render a score without being told.
        assert client.post("/risk/score", json=CLEAN).json()["synthetic"] is True

    def test_a_duplicate_scores_riskier_than_a_clean_invoice(self) -> None:
        clean = client.post("/risk/score", json=CLEAN).json()["riskProbability"]
        flagged = client.post(
            "/risk/score", json={**CLEAN, "duplicateCollision": True}
        ).json()["riskProbability"]
        assert flagged > clean

    def test_an_empty_body_is_scored_rather_than_rejected(self) -> None:
        # Every field has a default, so a partial payload degrades to a
        # score rather than a 422 the API would have to treat as an outage.
        response = client.post("/risk/score", json={})
        assert response.status_code == 200
        assert response.json()["modelAvailable"] is True

    def test_the_response_carries_no_raw_weights(self) -> None:
        # ZM-RSK-013: banks must not receive model internals. The API strips
        # what it forwards, but the service should not hand out coefficients
        # in the first place — defence in depth, one layer each.
        body = client.post("/risk/score", json=CLEAN).json()
        assert "coefficients" not in body
        assert "means" not in body
        assert "intercept" not in body


class TestDegraded:
    def test_reports_model_unavailable_instead_of_failing(self, monkeypatch) -> None:
        # The fallback contract (ZM-RSK-017) from the service's side: still
        # 200, still the same shape, with the flag turned off. The API's own
        # rules-only path is tested on the Node side.
        inference.reset_for_tests()
        monkeypatch.setattr(inference, "get_model", lambda: None)
        try:
            response = client.post("/risk/score", json=CLEAN)
            assert response.status_code == 200
            body = response.json()
            assert body["modelAvailable"] is False
            assert body["riskProbability"] is None
            assert body["contributions"] == []
        finally:
            inference.reset_for_tests()
