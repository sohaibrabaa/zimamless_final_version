# Zimmamless ML Service

Python FastAPI service for document understanding: OCR extraction, local QR
decoding, and the dummy e-invoice validation adapter. Risk scoring arrives
in Phase 4 and will live alongside these endpoints, not inside them.

## Setup

Python 3.11+ (developed and tested on 3.13.3). Every dependency installs
from PyPI as a pure wheel — no Tesseract, no system package, no PATH entry:

```bash
python -m venv services/ml/.venv
services/ml/.venv/Scripts/python -m pip install -r services/ml/requirements.txt   # Windows
# source services/ml/.venv/bin/activate && pip install -r requirements.txt        # POSIX
```

That constraint is deliberate. An OCR step that is present on the
developer's machine and absent in CI produces a suite that passes locally
while silently no longer exercising extraction.

> **Windows note.** If `python` opens the Microsoft Store, the launcher `py`
> is the working entry point (`py -m venv …`). If pip is missing from a
> fresh install, `py -m ensurepip --upgrade` restores it.

## Run

```bash
services/ml/.venv/Scripts/python -m uvicorn app.main:app --app-dir services/ml --port 8000
```

The Node API reaches it at `ML_SERVICE_URL` (default `http://localhost:8000`).

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness, plus `ocrEngineAvailable` |
| `POST` | `/extract` | Multipart upload → OCR + QR readings |
| `POST` | `/einvoice/validate` | Dummy e-invoice validation adapter (ZM-DOC-009) |

`/extract` returns **200 for any document it accepts, including ones it
cannot read.** An unreadable file is a manual-review outcome carried in the
body, not a server error — a 5xx teaches the client nothing and reads as our
fault rather than the file's. Only "empty" (400) and "too large" (413) are
error statuses.

## Design notes

**Rasterize first, always.** A PDF from an accounting package usually has a
text layer, and reading it would be faster and exact. It would also mean the
platform reads only invoices that happen to have one, and silently reads
nothing from the scan or phone photo a supplier with a paper invoice
actually uploads. Rendering every input to pixels means the OCR result means
the same thing for all of them.

**Degrade, never guess** (`ZM-DOC-010`). There is deliberately no "the
biggest number on the page is the total" fallback. Heuristics like that are
right often enough to be trusted and wrong often enough to matter, and a
confidently wrong amount is worse for the supplier than an empty box the
wizard asks them to fill in.

**Schema-driven parsing.** QR payload layouts (`app/qr_schemas.py`) and OCR
field labels (`app/fields.py`) are both data. Supporting another invoice
layout is a list entry, not a code change — which is what keeps a
layout-specific branch from quietly becoming a hard-coded assumption about
one supplier's stationery.

**No authorization here.** The service holds no credentials, never touches
the database, never sees a JWT, and is not reachable from the internet. The
Node API decides who may extract what. A second copy of that rule here would
be a second place for it to be wrong; only here would be worse, since a
service with no notion of organizations cannot enforce a rule about them.

See `docs/specs/EINVOICE_QR.md` for the payload schemas and the parsing
policy in full.

## Tests

```bash
cd services/ml && .venv/Scripts/python -m pytest
```

The end-to-end suite rasterizes the real seeded PDFs at 200 dpi and reads
them with the real OCR engine — no stub and no text-layer shortcut — so a
failure there means extraction genuinely stopped working. It is the slow
part of the suite; that is the cost of testing the thing itself.

## Seed e-invoices

```bash
services/ml/.venv/Scripts/python services/ml/tools/generate_einvoices.py
services/ml/.venv/Scripts/python services/ml/tools/generate_einvoices.py --check
```

Writes byte-stable PDFs to `db/seed/einvoices/`. `--check` regenerates in
memory and fails if a file on disk has drifted.
