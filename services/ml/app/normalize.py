"""
Value normalization shared by the OCR and QR readers.

OCR reads pixels, so it produces near-misses: a comma where a period
belongs, an Arabic-Indic digit, "l" for "1", stray whitespace. Normalizing
here rather than in each reader means OCR and QR cannot disagree merely
because they cleaned a value differently — which would surface to the
supplier as a mismatch that is really a bug in this file.

Everything is deliberately conservative. Where a value cannot be normalized
with confidence the raw text is returned unchanged and the caller decides;
guessing is what ZM-DOC-010 forbids, and a wrong-but-plausible amount is far
worse than an obviously unparsed one.
"""

from __future__ import annotations

import re
from datetime import date, datetime
from decimal import Decimal, InvalidOperation

# Arabic-Indic (U+0660..) and Eastern Arabic-Indic (U+06F0..) digits. An
# invoice issued in Arabic can carry either set, and neither is a Python int.
_ARABIC_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")

# Glyphs OCR routinely confuses with digits, in numeric context only. Applied
# nowhere near names or free text, where "O" really is a letter.
_DIGIT_LOOKALIKES = str.maketrans({"O": "0", "o": "0", "l": "1", "I": "1", "|": "1", "S": "5"})

_DATE_FORMATS = (
    "%Y-%m-%d",
    "%d/%m/%Y",
    "%d-%m-%Y",
    "%Y/%m/%d",
    "%d.%m.%Y",
    "%d %b %Y",
    "%d %B %Y",
)


def normalize_digits(text: str) -> str:
    """Fold Arabic-Indic digits to ASCII. Safe on any string."""
    return text.translate(_ARABIC_DIGITS)


def normalize_money(text: str) -> str | None:
    """
    Parse an amount into the 3-dp string form used on every wire in this
    system. Returns None when the text is not confidently an amount.

    Thousands separators are stripped only when they are positioned like
    thousands separators. "1,600" is 1600 in a Jordanian invoice, but a bare
    "1,60" is ambiguous between a typo and a European decimal comma, so it
    is refused rather than guessed at.
    """
    if not text:
        return None
    raw = normalize_digits(str(text)).strip()
    # Currency codes and symbols travel with amounts; the field is typed.
    raw = re.sub(r"(?i)\b(jod|jd|د\.ا|دينار)\b", "", raw).strip()
    raw = raw.replace(" ", " ").replace(" ", "")
    if not raw:
        return None

    # Only now, once we know we are in numeric context, fix digit lookalikes.
    raw = raw.translate(_DIGIT_LOOKALIKES)

    if not re.fullmatch(r"-?[\d.,]+", raw):
        return None

    if "," in raw and "." in raw:
        # Whichever appears last is the decimal separator.
        if raw.rfind(",") > raw.rfind("."):
            raw = raw.replace(".", "").replace(",", ".")
        else:
            raw = raw.replace(",", "")
    elif "," in raw:
        groups = raw.split(",")
        # 1,600 / 1,600,000 — comma used as a thousands separator.
        if all(len(g) == 3 for g in groups[1:]) and len(groups[0]) <= 3:
            raw = raw.replace(",", "")
        elif len(groups) == 2 and len(groups[1]) in (2, 3):
            raw = raw.replace(",", ".")  # European decimal comma
        else:
            return None

    try:
        value = Decimal(raw)
    except InvalidOperation:
        return None
    # quantize rather than round(): banker's rounding on money is a defect,
    # and the Node side is HALF_UP at 3dp.
    return f"{value:.3f}"


def normalize_date(text: str) -> str | None:
    """Parse a date into ISO YYYY-MM-DD, or None if it is not clearly one."""
    if not text:
        return None
    raw = normalize_digits(str(text)).strip().replace(" ", " ")
    raw = re.sub(r"\s+", " ", raw)
    for fmt in _DATE_FORMATS:
        try:
            parsed = datetime.strptime(raw, fmt).date()
        except ValueError:
            continue
        # A two-digit year parsed into the first century is a misread, not a
        # medieval invoice.
        if parsed.year < 1900:
            return None
        return parsed.isoformat()
    return None


def normalize_establishment_number(text: str) -> str | None:
    """
    Jordanian national establishment numbers are 8 digits (GOV_DUMMY_DATA
    §1). Anything else is returned as None so the API does not match a
    buyer on a half-read number.
    """
    if not text:
        return None
    digits = re.sub(r"\D", "", normalize_digits(str(text)))
    return digits if len(digits) == 8 else None


def normalize_text(text: str) -> str | None:
    """Collapse whitespace. Returns None for an empty result."""
    if text is None:
        return None
    collapsed = re.sub(r"\s+", " ", str(text)).strip()
    return collapsed or None


def is_iso_date(value: str) -> bool:
    try:
        date.fromisoformat(value)
        return True
    except (ValueError, TypeError):
        return False
