"""Value normalization — the layer OCR near-misses land on first."""

from __future__ import annotations

import pytest

from app.normalize import (
    normalize_date,
    normalize_digits,
    normalize_establishment_number,
    normalize_money,
    normalize_text,
)


class TestMoney:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("1250.000", "1250.000"),
            ("1250", "1250.000"),
            ("1,600.500", "1600.500"),
            ("1,600", "1600.000"),
            ("12354.000 JOD", "12354.000"),
            ("  11600.000  ", "11600.000"),
            ("-500.000", "-500.000"),
            ("1.234.567,89", "1234567.890"),  # European grouping
        ],
    )
    def test_parses(self, raw: str, expected: str) -> None:
        assert normalize_money(raw) == expected

    def test_always_three_decimal_places(self) -> None:
        # The wire form is 3dp everywhere in this system; a 2dp string would
        # fail the contract's Money pattern on the Node side.
        assert normalize_money("99.5") == "99.500"

    def test_folds_arabic_indic_digits(self) -> None:
        assert normalize_money("١٢٥٠") == "1250.000"

    def test_repairs_digit_lookalikes_in_numeric_context(self) -> None:
        # OCR routinely reads 0 as O and 1 as l. Only applied once we know
        # we are looking at an amount.
        assert normalize_money("l0O0.000") == "1000.000"

    @pytest.mark.parametrize("raw", ["", "   ", "not a number", "abc.def", "12,34,56"])
    def test_refuses_rather_than_guessing(self, raw: str) -> None:
        assert normalize_money(raw) is None

    def test_ambiguous_comma_is_refused_not_guessed(self) -> None:
        # "1,60" could be a typo for 1.60 or for 160. Guessing either way
        # would put a wrong amount in front of a supplier as if it were read
        # off their invoice.
        assert normalize_money("1,6") is None


class TestDate:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("2026-05-10", "2026-05-10"),
            ("10/05/2026", "2026-05-10"),
            ("10-05-2026", "2026-05-10"),
            ("2026/05/10", "2026-05-10"),
            ("10.05.2026", "2026-05-10"),
            ("10 May 2026", "2026-05-10"),
        ],
    )
    def test_parses_to_iso(self, raw: str, expected: str) -> None:
        assert normalize_date(raw) == expected

    @pytest.mark.parametrize("raw", ["", "45/13/2026", "not a date", "2026-13-45"])
    def test_refuses_impossible_dates(self, raw: str) -> None:
        assert normalize_date(raw) is None

    def test_refuses_implausible_year(self) -> None:
        # A two-digit year misread into antiquity is a misread, not an
        # invoice from the year 26.
        assert normalize_date("10/05/0026") is None


class TestEstablishmentNumber:
    def test_accepts_eight_digits(self) -> None:
        assert normalize_establishment_number("20000101") == "20000101"

    def test_strips_separators(self) -> None:
        assert normalize_establishment_number("2000-0101") == "20000101"

    @pytest.mark.parametrize("raw", ["2000010", "200001012", "", "abcdefgh"])
    def test_refuses_wrong_length(self, raw: str) -> None:
        # A half-read number must not be returned, or the API would match a
        # buyer on a prefix.
        assert normalize_establishment_number(raw) is None


class TestText:
    def test_collapses_whitespace(self) -> None:
        assert normalize_text("  Al-Noor   Trading  ") == "Al-Noor Trading"

    def test_empty_becomes_none(self) -> None:
        assert normalize_text("   ") is None

    def test_digits_helper_is_safe_on_plain_text(self) -> None:
        assert normalize_digits("Al-Noor") == "Al-Noor"
