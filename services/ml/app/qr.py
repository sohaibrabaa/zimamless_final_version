"""
Local QR decoding (ZM-DOC-007).

"Locally" is the operative word in the requirement: the invoice QR is
decoded on our own hardware, never by posting the page to a third-party
decoding service. An invoice carries the supplier's counterparties, amounts,
and terms; shipping it to an external API to read a barcode would leak all
of that to obtain something OpenCV does in a few milliseconds.

Decoding and *understanding* are kept separate. This module's job ends at
"here is the text painted into the QR"; what that text means is
qr_schemas.py's problem. The split is what makes the tolerant multi-schema
parse testable without a camera, and it is why a payload we cannot interpret
is still recorded verbatim.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from .raster import Page

DETECTOR_VERSION = f"opencv-{cv2.__version__}"


@dataclass(frozen=True)
class QrDetection:
    payload: str
    page_index: int


def detect_payloads(pages: list[Page]) -> list[QrDetection]:
    """
    Every QR payload found, in page order.

    Multiple detections are kept rather than collapsed to the first. An
    invoice can legitimately carry more than one code (a payment QR
    alongside the tax authority's), and picking one at random would make the
    extraction non-deterministic across runs.
    """
    detector = cv2.QRCodeDetector()
    found: list[QrDetection] = []
    seen: set[str] = set()

    for page in pages:
        for image in _candidate_images(page.image):
            for payload in _decode(detector, image):
                if payload and payload not in seen:
                    seen.add(payload)
                    found.append(QrDetection(payload=payload, page_index=page.index))
            if found:
                # A clean read on this page — no need to try the enhanced
                # variants, which exist only to rescue a poor scan.
                break
    return found


def _decode(detector: "cv2.QRCodeDetector", image: np.ndarray) -> list[str]:
    """
    Try the multi-code API first, then the single-code one.

    Both are attempted because they do not always agree: detectAndDecodeMulti
    finds several codes but is the more easily defeated by low contrast,
    while detectAndDecode sometimes reads a marginal code the multi version
    misses entirely. Either raises on some malformed inputs, so both are
    guarded — a QR that cannot be read must degrade to "no payload", never
    take down the extraction of a document whose OCR was fine.
    """
    payloads: list[str] = []
    try:
        ok, decoded, _, _ = detector.detectAndDecodeMulti(image)
        if ok and decoded:
            payloads.extend(text for text in decoded if text)
    except cv2.error:
        pass

    if not payloads:
        try:
            text, _, _ = detector.detectAndDecode(image)
            if text:
                payloads.append(text)
        except cv2.error:
            pass
    return payloads


def _candidate_images(image: np.ndarray) -> list[np.ndarray]:
    """
    The original, then progressively more aggressive clean-ups.

    A QR photographed under uneven lighting or printed faintly often fails
    at full colour and reads perfectly after thresholding. These are ordered
    cheapest-first and stop at the first success, so a normal document pays
    only for the first attempt.
    """
    grey = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    _, otsu = cv2.threshold(grey, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    adaptive = cv2.adaptiveThreshold(
        grey, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 5
    )
    upscaled = cv2.resize(grey, None, fx=2.0, fy=2.0, interpolation=cv2.INTER_CUBIC)
    return [image, grey, otsu, adaptive, upscaled]
