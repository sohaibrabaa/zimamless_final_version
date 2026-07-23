"""
The dummy e-invoice validation adapter (ZM-DOC-009).

The property worth defending here is the same one hard rule 7 defends for
government sources: "the validator said no" and "the validator said nothing"
are different facts and must stay structurally distinct.
"""

from __future__ import annotations

from app.einvoice import ADAPTER_VERSION, DummyEInvoiceValidator, EInvoiceValidator

validator = DummyEInvoiceValidator()


class TestWellFormedIdentifiers:
    def test_accepts_a_seeded_identifier(self) -> None:
        result = validator.validate("JO-EINV-20000101-0001")
        assert result.status == "VALID"
        assert result.source_available is True
        assert result.attributes["sellerEstablishmentNumber"] == "20000101"

    def test_echoes_the_declared_face_value(self) -> None:
        result = validator.validate("JO-EINV-20000101-0001", face_value="12354.000")
        assert result.attributes["declaredFaceValue"] == "12354.000"

    def test_reports_its_version(self) -> None:
        assert validator.validate("JO-EINV-20000101-0001").adapter_version == ADAPTER_VERSION


class TestRejection:
    def test_malformed_identifier_is_invalid(self) -> None:
        result = validator.validate("not-an-identifier")
        assert result.status == "INVALID"
        assert result.source_available is True

    def test_empty_identifier_is_not_found(self) -> None:
        result = validator.validate("")
        assert result.status == "NOT_FOUND"
        assert result.source_available is True


class TestAvailabilityIsDistinctFromVerdict:
    """The INV-9 distinction, applied to this adapter's surface."""

    def test_unavailable_means_the_source_did_not_answer(self) -> None:
        result = validator.validate("JO-EINV-90000001-0001")
        assert result.status == "UNAVAILABLE"
        assert result.source_available is False

    def test_not_found_means_it_answered_adversely(self) -> None:
        result = validator.validate("JO-EINV-90000002-0001")
        assert result.status == "NOT_FOUND"
        assert result.source_available is True

    def test_the_pair_is_distinguishable(self) -> None:
        did_not_answer = validator.validate("JO-EINV-90000001-0001")
        answered_adversely = validator.validate("JO-EINV-90000002-0001")
        assert did_not_answer.source_available != answered_adversely.source_available
        assert did_not_answer.status != answered_adversely.status


class TestDeterminism:
    def test_repeated_calls_agree(self) -> None:
        # "The validator was down" has to be a reproducible test rather than
        # a timing accident, exactly as for the government adapters.
        for identifier in (
            "JO-EINV-20000101-0001",
            "JO-EINV-90000001-0001",
            "garbage",
        ):
            first = validator.validate(identifier)
            second = validator.validate(identifier)
            assert first == second


def test_the_seam_is_replaceable() -> None:
    """
    ZM-DOC-009 requires the dummy be replaceable "without core changes", so
    the abstract type has to be the thing callers depend on.
    """
    assert isinstance(validator, EInvoiceValidator)

    class FakeProductionValidator(EInvoiceValidator):
        def validate(self, identifier: str, *, face_value: str | None = None):
            return validator.validate(identifier, face_value=face_value)

    assert FakeProductionValidator().validate("JO-EINV-20000101-0001").status == "VALID"
