"""
Turning an uploaded file into images the OCR and QR readers can work on.

Everything downstream operates on pixels, deliberately. A PDF produced by an
accounting package usually carries a text layer, and reading that layer
would be faster and perfectly accurate — but it would also mean the platform
"reads" only invoices that happen to have one, and silently reads nothing
from a scan or a photographed page, which is what a supplier with a paper
invoice actually uploads. Rasterizing first means every input takes the same
path and the OCR result means the same thing for all of them.
"""

from __future__ import annotations

import io
from dataclasses import dataclass

import cv2
import fitz  # PyMuPDF
import numpy as np

#: Rendering resolution for PDF pages. 200 dpi is the point where small
#: print in a table cell stops degrading OCR accuracy; higher mostly costs
#: time and memory without changing what is read.
RENDER_DPI = 200

#: A cap on pages examined. An invoice is one to three pages; a 400-page PDF
#: is either a mistake or an attempt to exhaust the service.
MAX_PAGES = 5

PDF_MAGIC = b"%PDF-"


class UnreadableDocument(Exception):
    """The bytes are not a document this service can rasterize."""


@dataclass(frozen=True)
class Page:
    index: int
    #: BGR, the layout OpenCV expects.
    image: np.ndarray


def is_pdf(data: bytes) -> bool:
    return data[:5] == PDF_MAGIC


def rasterize(data: bytes, content_type: str | None = None) -> list[Page]:
    """
    Render an upload to a list of BGR images.

    Dispatches on content, not on the declared MIME type or the file
    extension: both are supplied by the caller and neither is evidence. A
    file named invoice.pdf that is really a JPEG should still be read.
    """
    if not data:
        raise UnreadableDocument("The uploaded file is empty.")

    if is_pdf(data):
        return _rasterize_pdf(data)
    page = _decode_image(data)
    if page is not None:
        return [Page(0, page)]

    raise UnreadableDocument(
        "The file is neither a readable PDF nor an image format OpenCV can "
        f"decode (declared content type: {content_type or 'unknown'})."
    )


def _rasterize_pdf(data: bytes) -> list[Page]:
    try:
        document = fitz.open(stream=data, filetype="pdf")
    except Exception as exc:  # noqa: BLE001 — surfaced as a typed error below
        raise UnreadableDocument(f"The PDF could not be opened: {exc}") from exc

    pages: list[Page] = []
    try:
        for index, page in enumerate(document):
            if index >= MAX_PAGES:
                break
            pixmap = page.get_pixmap(dpi=RENDER_DPI)
            buffer = np.frombuffer(pixmap.samples, dtype=np.uint8)
            image = buffer.reshape(pixmap.height, pixmap.width, pixmap.n)
            if pixmap.n == 4:
                image = cv2.cvtColor(image, cv2.COLOR_RGBA2BGR)
            elif pixmap.n == 3:
                image = cv2.cvtColor(image, cv2.COLOR_RGB2BGR)
            else:
                image = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
            pages.append(Page(index, image))
    finally:
        document.close()

    if not pages:
        raise UnreadableDocument("The PDF has no renderable pages.")
    return pages


def _decode_image(data: bytes) -> np.ndarray | None:
    buffer = np.frombuffer(data, dtype=np.uint8)
    image = cv2.imdecode(buffer, cv2.IMREAD_COLOR)
    return image if image is not None and image.size else None


def page_count_of(data: bytes) -> int:
    """Pages in the document, for the raw record. 1 for a plain image."""
    if not is_pdf(data):
        return 1
    try:
        with fitz.open(stream=data, filetype="pdf") as document:
            return document.page_count
    except Exception:  # noqa: BLE001
        return 0


def to_png_bytes(image: np.ndarray) -> bytes:
    ok, encoded = cv2.imencode(".png", image)
    if not ok:
        raise UnreadableDocument("Failed to encode the rendered page.")
    return io.BytesIO(encoded.tobytes()).getvalue()
