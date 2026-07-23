"""
The extraction pipeline: bytes in, OCR + QR readings out.

This is the module that decides what "we could not read this" means, so the
degrade rules (ZM-DOC-010) are concentrated here rather than scattered
across the readers:

  - the file cannot be rasterized      -> both readings UNPARSED, 200 not 500
  - the OCR engine cannot be loaded    -> ocr.available false, QR still tried
  - no QR is present on the page       -> qr.validationStatus UNAVAILABLE
  - a QR is present but unrecognised   -> qr.validationStatus UNPARSED, and
                                          the payload is kept verbatim

The distinction in the last two is the same one hard rule 7 draws for
government sources, applied to a document: "there was no code to read" and
"there was a code and we do not understand it" are different facts, and only
the second one is a reason to put a human in the loop.
"""

from __future__ import annotations

import hashlib
from dataclasses import asdict, dataclass, field
from typing import Any

from . import canonical as C
from . import ocr as ocr_module
from . import qr as qr_module
from . import raster
from .einvoice import validator
from .fields import EXTRACTOR_VERSION, extract
from .qr_schemas import parse_payload

PIPELINE_VERSION = "extraction-1.0"


@dataclass
class OcrReading:
    available: bool
    #: Everything the engine returned, preserved verbatim. This is the
    #: `raw_output` that ZM-DOC-006 requires be retrievable independently of
    #: any supplier correction — line text, per-line confidence, and the
    #: box each line was read from.
    raw_output: dict[str, Any]
    extracted_fields: dict[str, str]
    confidence: float
    #: Label matches whose value failed normalization.
    rejected_fields: dict[str, str] = field(default_factory=dict)
    unavailable_reason: str | None = None


@dataclass
class QrReading:
    parsed: bool
    #: VALID   — a payload was read and a known schema understood it
    #: UNPARSED— a payload was read and no schema understood it
    #: UNAVAILABLE — no QR code was found on the document at all
    #: INVALID — a payload was understood but the validator rejected it
    validation_status: str
    raw_output: dict[str, Any]
    extracted_fields: dict[str, str]
    schema_name: str | None = None
    rejected_fields: dict[str, str] = field(default_factory=dict)


@dataclass
class ExtractionResult:
    document_sha256: str
    size_bytes: int
    page_count: int
    ocr: OcrReading
    qr: QrReading
    engine_version: str
    #: Fields where OCR and QR disagree. Supplier-entered values are not
    #: known here — the API adds that third column (ZM-DOC-008).
    mismatches: list[dict[str, str]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "documentSha256": self.document_sha256,
            "sizeBytes": self.size_bytes,
            "pageCount": self.page_count,
            "engineVersion": self.engine_version,
            "ocr": {
                "available": self.ocr.available,
                "rawOutput": self.ocr.raw_output,
                "extractedFields": self.ocr.extracted_fields,
                "confidence": self.ocr.confidence,
                "rejectedFields": self.ocr.rejected_fields,
                "unavailableReason": self.ocr.unavailable_reason,
            },
            "qr": {
                "parsed": self.qr.parsed,
                "validationStatus": self.qr.validation_status,
                "schemaName": self.qr.schema_name,
                "rawOutput": self.qr.raw_output,
                "extractedFields": self.qr.extracted_fields,
                "rejectedFields": self.qr.rejected_fields,
            },
            "mismatches": self.mismatches,
        }


def run_extraction(data: bytes, content_type: str | None = None) -> ExtractionResult:
    """Read a document. Never raises for unreadable content — it degrades."""
    digest = hashlib.sha256(data).hexdigest()
    size = len(data)

    try:
        pages = raster.rasterize(data, content_type)
    except raster.UnreadableDocument as exc:
        # The file is not a document we can render. That is a manual-review
        # outcome, not a server error: the supplier uploaded something, and
        # telling them "500" teaches nothing.
        return ExtractionResult(
            document_sha256=digest,
            size_bytes=size,
            page_count=0,
            ocr=OcrReading(
                available=False,
                raw_output={"error": str(exc)},
                extracted_fields={},
                confidence=0.0,
                unavailable_reason=str(exc),
            ),
            qr=QrReading(
                parsed=False,
                validation_status="UNPARSED",
                raw_output={"error": str(exc)},
                extracted_fields={},
            ),
            engine_version=_engine_version(),
        )

    ocr_reading = _read_ocr(pages)
    qr_reading = _read_qr(pages)
    mismatches = _compare(ocr_reading.extracted_fields, qr_reading.extracted_fields)

    return ExtractionResult(
        document_sha256=digest,
        size_bytes=size,
        page_count=raster.page_count_of(data),
        ocr=ocr_reading,
        qr=qr_reading,
        engine_version=_engine_version(),
        mismatches=mismatches,
    )


def _engine_version() -> str:
    return (
        f"{PIPELINE_VERSION}; {ocr_module.ENGINE_NAME}-{ocr_module.ENGINE_VERSION}; "
        f"{EXTRACTOR_VERSION}; {qr_module.DETECTOR_VERSION}"
    )


def _read_ocr(pages: list[raster.Page]) -> OcrReading:
    result = ocr_module.run(pages)
    if not result.available:
        return OcrReading(
            available=False,
            raw_output={"lines": [], "unavailableReason": result.unavailable_reason},
            extracted_fields={},
            confidence=0.0,
            unavailable_reason=result.unavailable_reason,
        )

    fields, rejected = extract(result.lines)
    return OcrReading(
        available=True,
        raw_output={
            "lines": [asdict(line) for line in result.lines],
            "lineCount": len(result.lines),
            "meanConfidence": round(result.mean_confidence, 4),
        },
        extracted_fields={key: value.value for key, value in fields.items()},
        confidence=round(result.mean_confidence, 4),
        rejected_fields=rejected,
    )


def _read_qr(pages: list[raster.Page]) -> QrReading:
    detections = qr_module.detect_payloads(pages)
    if not detections:
        # No code on the page. Not a failure to parse — there was nothing to
        # parse, and an invoice without a QR is a normal thing to receive.
        return QrReading(
            parsed=False,
            validation_status="UNAVAILABLE",
            raw_output={"payloads": [], "detected": 0},
            extracted_fields={},
        )

    # Payloads are kept verbatim regardless of whether we understand them —
    # an unrecognised payload is evidence, and the reviewer needs to see the
    # actual bytes rather than our failure to interpret them.
    raw_output: dict[str, Any] = {
        "payloads": [
            {"payload": d.payload, "pageIndex": d.page_index} for d in detections
        ],
        "detected": len(detections),
    }

    for detection in detections:
        parsed = parse_payload(detection.payload)
        if not parsed.parsed:
            continue

        fields = dict(parsed.fields)
        raw_output["schemaName"] = parsed.schema_name

        identifier = fields.get(C.EINVOICE_IDENTIFIER)
        if identifier:
            verdict = validator.validate(identifier, face_value=fields.get(C.FACE_VALUE))
            raw_output["validation"] = {
                "status": verdict.status,
                "sourceAvailable": verdict.source_available,
                "adapterVersion": verdict.adapter_version,
                "detail": verdict.detail,
                "attributes": verdict.attributes,
            }
            if verdict.status == "INVALID":
                return QrReading(
                    parsed=True,
                    validation_status="INVALID",
                    raw_output=raw_output,
                    extracted_fields=fields,
                    schema_name=parsed.schema_name,
                    rejected_fields=parsed.rejected,
                )

        return QrReading(
            parsed=True,
            validation_status="VALID",
            raw_output=raw_output,
            extracted_fields=fields,
            schema_name=parsed.schema_name,
            rejected_fields=parsed.rejected,
        )

    # A code was read but no schema recognised it. The documented degrade
    # path: manual review, with the payload preserved above.
    return QrReading(
        parsed=False,
        validation_status="UNPARSED",
        raw_output=raw_output,
        extracted_fields={},
    )


def _compare(ocr_fields: dict[str, str], qr_fields: dict[str, str]) -> list[dict[str, str]]:
    """
    Fields both readings produced and disagreed on (ZM-DOC-008).

    Only fields present in both are compared. A field the QR carries and the
    OCR missed is not a mismatch — it is one reading being more complete
    than the other, and reporting it as a conflict would bury the real
    conflicts in noise.
    """
    mismatches: list[dict[str, str]] = []
    for key in sorted(set(ocr_fields) & set(qr_fields)):
        if ocr_fields[key] != qr_fields[key]:
            mismatches.append(
                {"field": key, "ocrValue": ocr_fields[key], "qrValue": qr_fields[key]}
            )
    return mismatches
