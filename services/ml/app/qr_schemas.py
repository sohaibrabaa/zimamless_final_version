"""
QR payload schemas — the schema-driven, tolerant parser ZM-DOC-010 requires.

The requirement is unusually specific and worth restating, because it is the
sort of rule that gets quietly broken by a helpful refactor:

    ZM-DOC-010  The system MUST NOT hard-code an undocumented official QR
                payload structure. Parsing MUST be schema-driven and
                tolerant of format variation, degrading to "unparsed —
                manual review" rather than failing loudly or guessing.

What that rules out is a parser that assumes one layout and treats anything
else as corrupt. What it asks for is a registry of *candidate* layouts, each
one declared as data, tried in turn, with a documented and visible outcome
when none of them fits.

None of the schemas below is claimed to be the official Jordanian (JoFotara)
structure. We do not have that specification, and inventing one and calling
it official is precisely the failure mode the requirement names. They are:

  - `zimmamless-pipe-v1` — the layout OUR seeded e-invoices use. Ours, and
    documented as ours in docs/specs/EINVOICE_QR.md.
  - `tlv-base64` — the tag-length-value-in-base64 shape used by several
    regional e-invoicing systems. Included because it is the most likely
    real structure to meet, and it costs nothing to support.
  - `json` — a JSON object payload.
  - `url-query` — a verification URL carrying fields as query parameters.

Adding a schema is adding an entry to SCHEMAS. No parsing code changes, and
no existing schema's behaviour changes — which is the property that lets the
real structure be dropped in later "without core changes" (ZM-DOC-009's
sibling requirement for the validation adapter).
"""

from __future__ import annotations

import base64
import binascii
import json
import re
from dataclasses import dataclass, field
from typing import Callable
from urllib.parse import parse_qs, urlparse

from . import canonical as C
from .normalize import (
    normalize_date,
    normalize_establishment_number,
    normalize_money,
    normalize_text,
)

#: How each canonical field's raw text is turned into its stored value.
_NORMALIZERS: dict[str, Callable[[str], str | None]] = {
    C.SUBTOTAL_AMOUNT: normalize_money,
    C.TAX_AMOUNT: normalize_money,
    C.FACE_VALUE: normalize_money,
    C.ISSUE_DATE: normalize_date,
    C.DUE_DATE: normalize_date,
    C.SELLER_ESTABLISHMENT_NO: normalize_establishment_number,
    C.BUYER_ESTABLISHMENT_NO: normalize_establishment_number,
}


def _normalize(field_key: str, raw: str) -> str | None:
    return _NORMALIZERS.get(field_key, normalize_text)(raw)


@dataclass(frozen=True)
class QrSchema:
    """
    One candidate payload layout.

    `detect` is cheap and total — it must never raise, because a schema that
    throws while sniffing would stop later schemas from being tried at all.
    `parse` returns raw {canonical_field: text} pairs; normalization is
    applied centrally afterwards so no schema can normalize differently.
    """

    name: str
    version: str
    description: str
    detect: Callable[[str], bool]
    parse: Callable[[str], dict[str, str]]
    #: Fields that must be present for a parse to count as a match. Without
    #: this, a schema that extracts one incidental field from an unrelated
    #: payload would claim it.
    required: frozenset[str] = field(default_factory=frozenset)


# ---------------------------------------------------------------------------
# zimmamless-pipe-v1 — the layout our own seeded e-invoices carry.
# ---------------------------------------------------------------------------
# JO|<einvoiceIdentifier>|<sellerEstNo>|<buyerEstNo>|<issueDate>|<total>|<tax>
_PIPE_ORDER = (
    C.EINVOICE_IDENTIFIER,
    C.SELLER_ESTABLISHMENT_NO,
    C.BUYER_ESTABLISHMENT_NO,
    C.ISSUE_DATE,
    C.FACE_VALUE,
    C.TAX_AMOUNT,
)


def _pipe_detect(payload: str) -> bool:
    return payload.startswith("JO|") and payload.count("|") >= 3


def _pipe_parse(payload: str) -> dict[str, str]:
    parts = payload.split("|")[1:]
    # Tolerant by construction: a payload carrying fewer trailing fields than
    # the full layout still yields the ones it does carry, rather than being
    # rejected wholesale for being short.
    return {key: parts[i].strip() for i, key in enumerate(_PIPE_ORDER) if i < len(parts) and parts[i].strip()}


# ---------------------------------------------------------------------------
# tlv-base64 — tag/length/value triplets, base64-wrapped.
# ---------------------------------------------------------------------------
_TLV_TAGS: dict[int, str] = {
    1: C.SELLER_NAME,
    2: C.SELLER_ESTABLISHMENT_NO,
    3: C.ISSUE_DATE,
    4: C.FACE_VALUE,
    5: C.TAX_AMOUNT,
    6: C.EINVOICE_IDENTIFIER,
    7: C.BUYER_NAME,
    8: C.BUYER_ESTABLISHMENT_NO,
}


def _tlv_decode(payload: str) -> bytes | None:
    stripped = re.sub(r"\s+", "", payload)
    # A base64 payload of TLV data is binary-ish and never contains '|'.
    if not stripped or not re.fullmatch(r"[A-Za-z0-9+/=]+", stripped):
        return None
    try:
        # validate=True so a payload that merely looks base64-ish is refused
        # rather than silently decoded from its valid-looking prefix.
        return base64.b64decode(stripped, validate=True)
    except (binascii.Error, ValueError):
        return None


def _tlv_walk(data: bytes) -> dict[int, str]:
    out: dict[int, str] = {}
    i = 0
    while i + 2 <= len(data):
        tag, length = data[i], data[i + 1]
        i += 2
        if i + length > len(data):
            break  # truncated — keep what parsed, which is the tolerant read
        try:
            out[tag] = data[i : i + length].decode("utf-8")
        except UnicodeDecodeError:
            pass  # a binary tag we do not understand is skipped, not fatal
        i += length
    return out


def _tlv_detect(payload: str) -> bool:
    data = _tlv_decode(payload)
    return bool(data) and bool(_tlv_walk(data))


def _tlv_parse(payload: str) -> dict[str, str]:
    data = _tlv_decode(payload)
    if not data:
        return {}
    return {
        _TLV_TAGS[tag]: value
        for tag, value in _tlv_walk(data).items()
        if tag in _TLV_TAGS and value.strip()
    }


# ---------------------------------------------------------------------------
# json — a JSON object, with generously-aliased keys.
# ---------------------------------------------------------------------------
_JSON_ALIASES: dict[str, str] = {
    "invoicenumber": C.INVOICE_NUMBER,
    "invoiceno": C.INVOICE_NUMBER,
    "uuid": C.EINVOICE_IDENTIFIER,
    "einvoiceidentifier": C.EINVOICE_IDENTIFIER,
    "einvoiceid": C.EINVOICE_IDENTIFIER,
    "issuedate": C.ISSUE_DATE,
    "duedate": C.DUE_DATE,
    "subtotal": C.SUBTOTAL_AMOUNT,
    "subtotalamount": C.SUBTOTAL_AMOUNT,
    "tax": C.TAX_AMOUNT,
    "taxamount": C.TAX_AMOUNT,
    "vat": C.TAX_AMOUNT,
    "total": C.FACE_VALUE,
    "totalamount": C.FACE_VALUE,
    "facevalue": C.FACE_VALUE,
    "currency": C.CURRENCY,
    "sellername": C.SELLER_NAME,
    "seller": C.SELLER_NAME,
    "sellerid": C.SELLER_ESTABLISHMENT_NO,
    "buyername": C.BUYER_NAME,
    "buyer": C.BUYER_NAME,
    "buyerid": C.BUYER_ESTABLISHMENT_NO,
}


def _json_load(payload: str) -> dict | None:
    text = payload.strip()
    if not text.startswith("{"):
        return None
    try:
        loaded = json.loads(text)
    except json.JSONDecodeError:
        return None
    return loaded if isinstance(loaded, dict) else None


def _json_detect(payload: str) -> bool:
    return _json_load(payload) is not None


def _json_parse(payload: str) -> dict[str, str]:
    loaded = _json_load(payload) or {}
    out: dict[str, str] = {}
    for key, value in loaded.items():
        if value is None or isinstance(value, (dict, list)):
            continue
        canonical_key = _JSON_ALIASES.get(re.sub(r"[^a-z]", "", str(key).lower()))
        if canonical_key:
            out[canonical_key] = str(value)
    return out


# ---------------------------------------------------------------------------
# url-query — a verification link carrying fields as query parameters.
# ---------------------------------------------------------------------------
def _url_detect(payload: str) -> bool:
    parsed = urlparse(payload.strip())
    return parsed.scheme in ("http", "https") and bool(parsed.query)


def _url_parse(payload: str) -> dict[str, str]:
    query = parse_qs(urlparse(payload.strip()).query)
    out: dict[str, str] = {}
    for key, values in query.items():
        if not values or not values[0]:
            continue
        canonical_key = _JSON_ALIASES.get(re.sub(r"[^a-z]", "", key.lower()))
        if canonical_key:
            out[canonical_key] = values[0]
    return out


#: Tried in order. Most specific first, so a payload that could satisfy two
#: schemas is claimed by the one that describes it most precisely.
SCHEMAS: tuple[QrSchema, ...] = (
    QrSchema(
        name="zimmamless-pipe-v1",
        version="1.0",
        description=(
            "Pipe-delimited layout used by Zimmamless-generated seed "
            "e-invoices. Ours, not an official structure."
        ),
        detect=_pipe_detect,
        parse=_pipe_parse,
        required=frozenset({C.EINVOICE_IDENTIFIER}),
    ),
    QrSchema(
        name="json",
        version="1.0",
        description="JSON object payload with aliased field names.",
        detect=_json_detect,
        parse=_json_parse,
        required=frozenset(),
    ),
    QrSchema(
        name="url-query",
        version="1.0",
        description="Verification URL carrying invoice fields as query parameters.",
        detect=_url_detect,
        parse=_url_parse,
        required=frozenset(),
    ),
    QrSchema(
        name="tlv-base64",
        version="1.0",
        description=(
            "Base64-wrapped tag/length/value triplets, the shape used by "
            "several regional e-invoicing systems."
        ),
        detect=_tlv_detect,
        parse=_tlv_parse,
        required=frozenset(),
    ),
)


@dataclass(frozen=True)
class QrParseResult:
    parsed: bool
    schema_name: str | None
    fields: dict[str, str]
    #: Values a schema produced that normalization then rejected. Surfaced
    #: rather than dropped: "the QR said 2026-13-45" is a finding, and
    #: silently discarding it would show the supplier a clean parse.
    rejected: dict[str, str]


def parse_payload(payload: str) -> QrParseResult:
    """
    Try each candidate schema and return the first genuine match.

    "Genuine" means it detected, produced at least one field, and produced
    every field it declared required. A schema that detects but yields
    nothing usable is not a match — otherwise the tolerant JSON schema would
    claim every JSON payload on the planet and report zero fields, which
    reads as a successful parse of an empty invoice.
    """
    if not payload or not payload.strip():
        return QrParseResult(False, None, {}, {})

    for schema in SCHEMAS:
        try:
            if not schema.detect(payload):
                continue
            raw_fields = schema.parse(payload)
        except Exception:  # noqa: BLE001 — a broken schema must not blind the rest
            continue

        fields_out: dict[str, str] = {}
        rejected: dict[str, str] = {}
        for key, raw in raw_fields.items():
            if key not in C.CANONICAL_FIELDS:
                continue
            value = _normalize(key, raw)
            if value is None:
                rejected[key] = raw
            else:
                fields_out[key] = value

        if not fields_out:
            continue
        if not schema.required.issubset(fields_out.keys()):
            continue
        return QrParseResult(True, schema.name, fields_out, rejected)

    # Nothing fit. This is the documented degrade path, not an error: the
    # payload was read off the page perfectly well, we simply do not
    # recognise its structure, and a human should look at it.
    return QrParseResult(False, None, {}, {})
