"""
The tolerant, schema-driven QR parser (ZM-DOC-010).

The requirement these tests defend is easy to regress by "simplifying" the
parser into the one layout the seed data happens to use, so the cases below
deliberately include payloads our own invoices never carry.
"""

from __future__ import annotations

import base64
import json

from app import canonical as C
from app.qr_schemas import SCHEMAS, parse_payload


def _tlv(*pairs: tuple[int, str]) -> str:
    body = b"".join(
        bytes([tag, len(value.encode())]) + value.encode() for tag, value in pairs
    )
    return base64.b64encode(body).decode()


class TestPipeSchema:
    PAYLOAD = "JO|JO-EINV-20000101-0001|20000101|30000201|2026-05-10|12354.000|1704.000"

    def test_parses_our_seeded_layout(self) -> None:
        result = parse_payload(self.PAYLOAD)
        assert result.parsed
        assert result.schema_name == "zimmamless-pipe-v1"
        assert result.fields[C.EINVOICE_IDENTIFIER] == "JO-EINV-20000101-0001"
        assert result.fields[C.SELLER_ESTABLISHMENT_NO] == "20000101"
        assert result.fields[C.BUYER_ESTABLISHMENT_NO] == "30000201"
        assert result.fields[C.ISSUE_DATE] == "2026-05-10"
        assert result.fields[C.FACE_VALUE] == "12354.000"
        assert result.fields[C.TAX_AMOUNT] == "1704.000"

    def test_tolerates_a_short_payload(self) -> None:
        # Tolerance means a payload carrying fewer trailing fields still
        # yields the ones it does carry, rather than being rejected whole.
        result = parse_payload("JO|JO-EINV-20000101-0001|20000101|30000201")
        assert result.parsed
        assert result.fields[C.EINVOICE_IDENTIFIER] == "JO-EINV-20000101-0001"
        assert C.FACE_VALUE not in result.fields

    def test_surfaces_values_normalization_rejected(self) -> None:
        # A garbled date is a finding. Dropping it silently would let the
        # payload read as a clean parse that simply had no issue date.
        result = parse_payload(
            "JO|JO-EINV-20000101-0001|20000101|30000201|45/13/2026|12354.000|1704.000"
        )
        assert result.parsed
        assert C.ISSUE_DATE not in result.fields
        assert result.rejected[C.ISSUE_DATE] == "45/13/2026"


class TestOtherSchemas:
    def test_json_payload(self) -> None:
        payload = json.dumps(
            {"uuid": "JO-EINV-20000101-0001", "total": "12354.000", "issueDate": "2026-05-10"}
        )
        result = parse_payload(payload)
        assert result.parsed
        assert result.schema_name == "json"
        assert result.fields[C.FACE_VALUE] == "12354.000"

    def test_url_query_payload(self) -> None:
        result = parse_payload(
            "https://verify.example.jo/inv?uuid=JO-EINV-20000101-0001&total=12354.000"
        )
        assert result.parsed
        assert result.schema_name == "url-query"
        assert result.fields[C.EINVOICE_IDENTIFIER] == "JO-EINV-20000101-0001"

    def test_tlv_base64_payload(self) -> None:
        payload = _tlv(
            (1, "Al-Noor Trading Company"),
            (2, "20000101"),
            (3, "2026-05-10"),
            (4, "12354.000"),
            (5, "1704.000"),
        )
        result = parse_payload(payload)
        assert result.parsed
        assert result.schema_name == "tlv-base64"
        assert result.fields[C.SELLER_NAME] == "Al-Noor Trading Company"
        assert result.fields[C.FACE_VALUE] == "12354.000"

    def test_truncated_tlv_keeps_what_parsed(self) -> None:
        full = base64.b64decode(_tlv((1, "Al-Noor Trading Company"), (4, "12354.000")))
        truncated = base64.b64encode(full[:-4]).decode()
        result = parse_payload(truncated)
        # The first tag survived; the truncated one is dropped rather than
        # taking the whole payload down.
        assert result.parsed
        assert result.fields[C.SELLER_NAME] == "Al-Noor Trading Company"


class TestDegradation:
    """ZM-DOC-010: unrecognised structure degrades, it does not raise."""

    def test_unrecognised_payload_is_unparsed_not_an_error(self) -> None:
        result = parse_payload("this is not any invoice format we know")
        assert result.parsed is False
        assert result.schema_name is None
        assert result.fields == {}

    def test_empty_payload(self) -> None:
        assert parse_payload("").parsed is False

    def test_json_with_no_recognisable_fields_is_not_claimed(self) -> None:
        # The JSON schema detects any JSON object. If a detected-but-empty
        # parse counted as a match it would report a successful read of an
        # invoice with no fields, which is indistinguishable to a caller
        # from a genuinely blank invoice.
        result = parse_payload('{"unrelated": "value", "other": 1}')
        assert result.parsed is False

    def test_a_broken_schema_cannot_blind_the_others(self, monkeypatch) -> None:
        exploding = SCHEMAS[0].__class__(
            name="exploding",
            version="0",
            description="raises on detect",
            detect=lambda _: (_ for _ in ()).throw(RuntimeError("boom")),
            parse=lambda _: {},
        )
        monkeypatch.setattr("app.qr_schemas.SCHEMAS", (exploding, *SCHEMAS))
        result = parse_payload(
            "JO|JO-EINV-20000101-0001|20000101|30000201|2026-05-10|12354.000|1704.000"
        )
        assert result.parsed
        assert result.schema_name == "zimmamless-pipe-v1"


def test_every_schema_emits_only_canonical_fields() -> None:
    """
    A schema that emitted its own field name would silently never be
    compared against OCR or the supplier's value — the comparison is keyed
    on the canonical vocabulary.
    """
    payloads = [
        "JO|JO-EINV-20000101-0001|20000101|30000201|2026-05-10|12354.000|1704.000",
        json.dumps({"uuid": "JO-EINV-20000101-0001", "total": "12354.000"}),
        "https://verify.example.jo/inv?uuid=JO-EINV-20000101-0001&total=12354.000",
        _tlv((1, "Al-Noor Trading Company"), (4, "12354.000")),
    ]
    for payload in payloads:
        result = parse_payload(payload)
        assert set(result.fields).issubset(C.CANONICAL_FIELDS)
