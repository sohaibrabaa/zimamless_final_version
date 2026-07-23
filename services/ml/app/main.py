"""
Zimmamless ML service — FastAPI application.

Scope in Phase 3 is document understanding: OCR extraction, local QR
decoding, and the dummy e-invoice validation adapter. Risk scoring arrives
in Phase 4 and will live alongside, not inside, these endpoints.

The service is deliberately stateless and holds no credentials. It never
touches the database, never sees a JWT, and is not reachable from the
internet — the Node API calls it over the private network and is the only
thing that decides who may extract what. Putting authorization here as well
would be a second place for it to be wrong; putting it ONLY here would be
worse, since a service with no notion of organizations cannot enforce a
rule about them.
"""

from __future__ import annotations

import logging
import os

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

from . import ocr as ocr_module
from .einvoice import validator
from .extraction import PIPELINE_VERSION, run_extraction

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper())
logger = logging.getLogger(__name__)

#: Refused before reading. An invoice is a few hundred kilobytes; anything
#: at this scale is a mistake or an attempt to exhaust the service, and
#: rasterizing it at 200 dpi would cost far more memory than the file size.
MAX_UPLOAD_BYTES = int(os.getenv("ML_MAX_UPLOAD_BYTES", str(20 * 1024 * 1024)))

app = FastAPI(
    title="Zimmamless ML Service",
    version="3.0.0",
    description="OCR extraction, local QR decoding, and e-invoice validation.",
)


class HealthResponse(BaseModel):
    status: str
    version: str
    ocrEngineAvailable: bool = Field(
        description=(
            "False means extraction still runs and still decodes QR codes, "
            "but OCR degrades to UNPARSED rather than failing."
        )
    )


class ValidateRequest(BaseModel):
    identifier: str
    faceValue: str | None = None


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    """
    Liveness plus the one fact a caller's behaviour should depend on.

    `ocrEngineAvailable` is reported rather than folded into `status`
    because a service that can decode QR codes but not run OCR is degraded,
    not down, and the API should keep calling it.
    """
    return HealthResponse(
        status="ok",
        version=PIPELINE_VERSION,
        ocrEngineAvailable=ocr_module.engine_available(),
    )


@app.post("/extract")
async def extract_document(
    file: UploadFile = File(...),
    contentType: str | None = Form(default=None),
) -> dict:
    """
    Extract structured invoice fields from an uploaded document.

    Returns 200 for any document it can accept, including ones it cannot
    read — an unreadable file is a manual-review outcome carried in the
    body, not an error status. 413 and 400 are reserved for the two cases
    where there is nothing to report on: too large, and empty.
    """
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="The uploaded file is empty.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"The file exceeds the {MAX_UPLOAD_BYTES} byte limit.",
        )

    result = run_extraction(data, contentType or file.content_type)
    logger.info(
        "extracted sha256=%s pages=%s ocr=%s qr=%s mismatches=%s",
        result.document_sha256[:12],
        result.page_count,
        result.ocr.available,
        result.qr.validation_status,
        len(result.mismatches),
    )
    return result.to_dict()


@app.post("/einvoice/validate")
def validate_einvoice(request: ValidateRequest) -> dict:
    """
    The dummy government e-invoice validation adapter (ZM-DOC-009), exposed
    directly so the API can re-validate an identifier the supplier typed
    without re-uploading the document.
    """
    verdict = validator.validate(request.identifier, face_value=request.faceValue)
    return {
        "status": verdict.status,
        "sourceAvailable": verdict.source_available,
        "adapterVersion": verdict.adapter_version,
        "detail": verdict.detail,
        "attributes": verdict.attributes,
    }
