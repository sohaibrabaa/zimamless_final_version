"""
The OCR engine wrapper.

RapidOCR (ONNX Runtime, models bundled in the wheel) is used rather than
Tesseract so that installing this service is `pip install -r
requirements.txt` on every platform, with no system package and no PATH
entry. That matters more than it sounds: an OCR step that is present on the
developer's machine and absent in CI produces a test suite that passes
locally and silently stops exercising extraction in the pipeline.

The engine is loaded once and lazily. Loading costs a second or so and holds
the models in memory, so doing it per request would make the first upload of
every request slow for no benefit; doing it at import time would make the
whole service fail to start on a machine where the models are unavailable,
when it could still serve QR decoding perfectly well.

If the engine cannot be loaded at all, extraction degrades to UNPARSED with
a stated reason (ZM-DOC-010) rather than raising. A supplier whose invoice
could not be machine-read is sent to manual review, which is a supported
outcome; a 500 is not.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass

import numpy as np

from .raster import Page

logger = logging.getLogger(__name__)

ENGINE_NAME = "rapidocr-onnxruntime"
ENGINE_VERSION = "1.2.3"

_engine = None
_engine_error: str | None = None
_lock = threading.Lock()


@dataclass(frozen=True)
class OcrLine:
    text: str
    confidence: float
    page_index: int
    #: [x, y] quadrilateral corners, top-left first. Retained in the raw
    #: output so a reviewer can be shown *where* on the page a value came
    #: from — an extracted amount with no provenance on the page is hard to
    #: adjudicate in a dispute.
    box: list[list[float]]


@dataclass(frozen=True)
class OcrResult:
    available: bool
    lines: list[OcrLine]
    #: Why OCR produced nothing, when it did. None on success.
    unavailable_reason: str | None = None

    @property
    def mean_confidence(self) -> float:
        if not self.lines:
            return 0.0
        return sum(line.confidence for line in self.lines) / len(self.lines)

    @property
    def text(self) -> str:
        return "\n".join(line.text for line in self.lines)


def _load_engine():
    """Load the OCR engine once. Returns None if it cannot be loaded."""
    global _engine, _engine_error
    if _engine is not None or _engine_error is not None:
        return _engine
    with _lock:
        if _engine is not None or _engine_error is not None:
            return _engine
        try:
            from rapidocr_onnxruntime import RapidOCR

            _engine = RapidOCR()
            logger.info("OCR engine loaded: %s %s", ENGINE_NAME, ENGINE_VERSION)
        except Exception as exc:  # noqa: BLE001 — recorded, then degraded
            _engine_error = f"{type(exc).__name__}: {exc}"
            logger.error("OCR engine unavailable — extraction will degrade: %s", _engine_error)
    return _engine


def engine_available() -> bool:
    return _load_engine() is not None


def run(pages: list[Page]) -> OcrResult:
    """Read every page, returning one entry per recognised text line."""
    engine = _load_engine()
    if engine is None:
        return OcrResult(
            available=False,
            lines=[],
            unavailable_reason=f"OCR engine could not be loaded ({_engine_error}).",
        )

    lines: list[OcrLine] = []
    for page in pages:
        try:
            detections, _ = engine(page.image)
        except Exception as exc:  # noqa: BLE001 — one bad page must not lose the rest
            logger.warning("OCR failed on page %s: %s", page.index, exc)
            continue
        for detection in detections or []:
            parsed = _parse_detection(detection, page.index)
            if parsed is not None:
                lines.append(parsed)

    return OcrResult(available=True, lines=lines)


def _parse_detection(detection, page_index: int) -> OcrLine | None:
    """
    Normalize one engine detection into an OcrLine.

    Written defensively against the tuple's shape rather than unpacking it
    positionally: RapidOCR returns (box, text, score), but the score arrives
    as a string in some builds and a float in others, and an unpacking that
    assumed one of those would fail on the other at runtime having
    typechecked fine.
    """
    try:
        box, text, score = detection[0], detection[1], detection[2]
    except (IndexError, TypeError):
        return None
    if not text or not str(text).strip():
        return None
    try:
        confidence = float(score)
    except (TypeError, ValueError):
        confidence = 0.0
    try:
        corners = [[float(point[0]), float(point[1])] for point in np.asarray(box).tolist()]
    except (TypeError, ValueError):
        corners = []
    return OcrLine(
        text=str(text).strip(),
        confidence=round(confidence, 4),
        page_index=page_index,
        box=corners,
    )
