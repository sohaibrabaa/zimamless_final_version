#!/usr/bin/env python
"""
Generate the seeded e-invoice PDFs.

    python services/ml/tools/generate_einvoices.py

Writes to db/seed/einvoices/. The phase file puts seeded e-invoice files
under /db/seed (Agent A-owned) and has Agent B reference them by the
identity list only.

Why generate rather than obtain: the phase requires an invoice with a
"deliberate OCR-vs-entered mismatch" and a duplicate pair across two
suppliers. Both are properties of the *relationship* between a document and
the data seeded alongside it, which you cannot arrange by finding a PDF
somewhere. Generating them also means the QR payload layout is one we
document rather than one we reverse-engineered and guessed at (ZM-DOC-010).

These are laid out to be legible to OCR but are NOT synthetic-perfect: the
text is rendered as normal PDF text and then read back through the same
rasterize-then-OCR path a scanned upload takes, so the extraction the
platform demonstrates is genuine OCR of pixels, not a text-layer read.

Output is deterministic — same bytes on every run — so regenerating does not
produce a spurious diff. Nothing here reads the clock.
"""

from __future__ import annotations

import argparse
import io
import os
import sys
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path

import qrcode
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas

REPO_ROOT = Path(__file__).resolve().parents[3]
OUTPUT_DIR = REPO_ROOT / "db" / "seed" / "einvoices"

PAGE_WIDTH, PAGE_HEIGHT = A4


@dataclass(frozen=True)
class LineItem:
    description: str
    quantity: str
    unit_price: str

    @property
    def line_amount(self) -> str:
        return f"{Decimal(self.quantity) * Decimal(self.unit_price):.3f}"


@dataclass(frozen=True)
class SeedInvoice:
    #: File name stem, and the key the seed SQL references.
    slug: str
    invoice_number: str
    einvoice_identifier: str
    seller_name: str
    seller_establishment_no: str
    buyer_name: str
    buyer_establishment_no: str
    issue_date: str
    due_date: str
    items: tuple[LineItem, ...]
    tax_rate: str = "0.16"
    payment_terms: str = "Net 90 days"
    purchase_order_number: str = ""
    delivery_note_number: str = ""
    #: Explains what this file exists to demonstrate. Printed nowhere on the
    #: page — it is documentation for whoever reads the generator.
    purpose: str = ""
    #: When set, the QR carries THIS total instead of the computed one,
    #: creating a deliberate QR-vs-OCR disagreement.
    qr_total_override: str | None = None
    notes: tuple[str, ...] = field(default_factory=tuple)

    @property
    def subtotal(self) -> str:
        return f"{sum(Decimal(i.line_amount) for i in self.items):.3f}"

    @property
    def tax_amount(self) -> str:
        return f"{Decimal(self.subtotal) * Decimal(self.tax_rate):.3f}"

    @property
    def face_value(self) -> str:
        return f"{Decimal(self.subtotal) + Decimal(self.tax_amount):.3f}"

    @property
    def qr_payload(self) -> str:
        """
        The zimmamless-pipe-v1 layout documented in docs/specs/EINVOICE_QR.md.
        Ours, and never claimed to be the official Jordanian structure.
        """
        total = self.qr_total_override or self.face_value
        return "|".join(
            [
                "JO",
                self.einvoice_identifier,
                self.seller_establishment_no,
                self.buyer_establishment_no,
                self.issue_date,
                total,
                self.tax_amount,
            ]
        )


# ---------------------------------------------------------------------------
# The seeded set. Identities come from docs/specs/GOV_DUMMY_DATA.md — copied,
# never invented, which is the lesson the Phase 1 and Phase 2 audits both
# recorded about fixtures.
# ---------------------------------------------------------------------------
SEED_INVOICES: tuple[SeedInvoice, ...] = (
    SeedInvoice(
        slug="INV-2026-0001-alnoor-amman-retail",
        purpose=(
            "Happy path. S1 Al-Noor -> B1 Amman Retail Group. Every field "
            "reads cleanly and the QR agrees with the printed total. This is "
            "the invoice the checkpoint's register-to-ELIGIBLE walk uses."
        ),
        invoice_number="INV-2026-0001",
        einvoice_identifier="JO-EINV-20000101-0001",
        seller_name="Al-Noor Trading Company",
        seller_establishment_no="20000101",
        buyer_name="Amman Retail Group",
        buyer_establishment_no="30000201",
        issue_date="2026-05-10",
        due_date="2026-08-10",
        purchase_order_number="PO-AR-88120",
        delivery_note_number="DN-2026-0413",
        items=(
            LineItem("Bulk packaged foodstuffs — grade A", "1200.000", "8.500"),
            LineItem("Cold-chain handling surcharge", "1.000", "450.000"),
        ),
    ),
    SeedInvoice(
        slug="INV-2026-0002-alnoor-levant-mismatch",
        purpose=(
            "The deliberate OCR-vs-entered mismatch the phase file requires. "
            "The QR carries a total of 25000.000 while the page prints "
            "24500.000, so extraction reports a genuine disagreement the "
            "wizard must highlight and the supplier must resolve. Both "
            "values are retained (ZM-DOC-006) — the correction never "
            "overwrites the machine reading."
        ),
        invoice_number="INV-2026-0002",
        einvoice_identifier="JO-EINV-20000101-0002",
        seller_name="Al-Noor Trading Company",
        seller_establishment_no="20000101",
        buyer_name="Levant Construction Co.",
        buyer_establishment_no="30000202",
        issue_date="2026-05-18",
        due_date="2026-09-16",
        purchase_order_number="PO-LC-33471",
        items=(LineItem("Construction site catering contract — Q2", "1.000", "21120.690"),),
        qr_total_override="25000.000",
        notes=("QR total intentionally disagrees with the printed total.",),
    ),
    SeedInvoice(
        slug="INV-2026-0003-alnoor-aqaba-duplicate-a",
        purpose=(
            "First half of the duplicate pair. Same parties, number, date, "
            "value and tax as the -duplicate-b file below, which is issued "
            "under S2 Petra. Submitting both must collide on fingerprint "
            "(ZM-VER-001): the second is blocked with a review record."
        ),
        invoice_number="INV-2026-0003",
        einvoice_identifier="JO-EINV-20000101-0003",
        seller_name="Al-Noor Trading Company",
        seller_establishment_no="20000101",
        buyer_name="Aqaba Logistics Ltd",
        buyer_establishment_no="30000203",
        issue_date="2026-06-01",
        due_date="2026-09-01",
        items=(LineItem("Warehouse consumables — bulk order", "500.000", "12.000"),),
    ),
    SeedInvoice(
        slug="INV-2026-0003-petra-aqaba-duplicate-b",
        purpose=(
            "Second half of the duplicate pair, issued by S2 Petra against "
            "the same buyer, number, date and amounts. The fingerprint is "
            "over parties-plus-invoice-data, so this is the double-financing "
            "attempt the duplicate check exists to stop."
        ),
        invoice_number="INV-2026-0003",
        einvoice_identifier="JO-EINV-20000102-0003",
        seller_name="Petra Industrial Supplies",
        seller_establishment_no="20000102",
        buyer_name="Aqaba Logistics Ltd",
        buyer_establishment_no="30000203",
        issue_date="2026-06-01",
        due_date="2026-09-01",
        items=(LineItem("Warehouse consumables — bulk order", "500.000", "12.000"),),
    ),
    SeedInvoice(
        slug="INV-2026-0004-petra-amman-retail-past-due",
        purpose=(
            "Past-due invoice for AS-07: the due date is behind the demo "
            "clock, so it must be refused for listing rather than reaching "
            "ELIGIBLE. Nothing about the document is malformed — the only "
            "problem is its maturity."
        ),
        invoice_number="INV-2026-0004",
        einvoice_identifier="JO-EINV-20000102-0004",
        seller_name="Petra Industrial Supplies",
        seller_establishment_no="20000102",
        buyer_name="Amman Retail Group",
        buyer_establishment_no="30000201",
        issue_date="2026-01-05",
        due_date="2026-03-05",
        items=(LineItem("Industrial fasteners — assorted", "8000.000", "1.250"),),
    ),
)


def _draw_header(pdf: canvas.Canvas, invoice: SeedInvoice) -> float:
    pdf.setFillColor(colors.HexColor("#0f172a"))
    pdf.setFont("Helvetica-Bold", 20)
    pdf.drawString(20 * mm, PAGE_HEIGHT - 25 * mm, "ELECTRONIC INVOICE")
    pdf.setFont("Helvetica", 9)
    pdf.setFillColor(colors.HexColor("#475569"))
    pdf.drawString(
        20 * mm,
        PAGE_HEIGHT - 31 * mm,
        "Hashemite Kingdom of Jordan — electronic invoice (test document, not a real tax document)",
    )
    pdf.setStrokeColor(colors.HexColor("#cbd5e1"))
    pdf.line(20 * mm, PAGE_HEIGHT - 34 * mm, PAGE_WIDTH - 20 * mm, PAGE_HEIGHT - 34 * mm)
    return PAGE_HEIGHT - 44 * mm


def _draw_labelled(pdf: canvas.Canvas, x: float, y: float, label: str, value: str) -> float:
    """
    One `Label: value` line.

    Label and value are drawn as a single string rather than as two
    positioned runs. Two runs would render identically to a human but reach
    OCR as two separate detections, and the field extractor pairs a label
    with what follows it on the same line — so splitting them here would
    quietly make every field depend on the adjacent-cell fallback.
    """
    pdf.setFillColor(colors.HexColor("#0f172a"))
    pdf.setFont("Helvetica", 11)
    pdf.drawString(x, y, f"{label}: {value}")
    return y - 6.5 * mm


def _render(invoice: SeedInvoice) -> bytes:
    buffer = io.BytesIO()
    # invariant=1 is what makes the output byte-stable. Without it reportlab
    # embeds the current time as /CreationDate and a run-specific /ID, so
    # every regeneration differs from the committed file and `--check` can
    # never distinguish a real content change from the clock ticking.
    pdf = canvas.Canvas(buffer, pagesize=A4, invariant=1)
    pdf.setTitle(f"{invoice.invoice_number} - {invoice.seller_name}")
    pdf.setKeywords(invoice.einvoice_identifier)

    y = _draw_header(pdf, invoice)

    y = _draw_labelled(pdf, 20 * mm, y, "Invoice Number", invoice.invoice_number)
    y = _draw_labelled(pdf, 20 * mm, y, "E-Invoice Identifier", invoice.einvoice_identifier)
    y = _draw_labelled(pdf, 20 * mm, y, "Issue Date", invoice.issue_date)
    y = _draw_labelled(pdf, 20 * mm, y, "Due Date", invoice.due_date)
    y = _draw_labelled(pdf, 20 * mm, y, "Payment Terms", invoice.payment_terms)
    if invoice.purchase_order_number:
        y = _draw_labelled(pdf, 20 * mm, y, "Purchase Order", invoice.purchase_order_number)
    if invoice.delivery_note_number:
        y = _draw_labelled(pdf, 20 * mm, y, "Delivery Note", invoice.delivery_note_number)

    y -= 3 * mm
    y = _draw_labelled(pdf, 20 * mm, y, "Seller", invoice.seller_name)
    y = _draw_labelled(
        pdf, 20 * mm, y, "Seller Establishment Number", invoice.seller_establishment_no
    )
    y = _draw_labelled(pdf, 20 * mm, y, "Buyer", invoice.buyer_name)
    y = _draw_labelled(
        pdf, 20 * mm, y, "Buyer Establishment Number", invoice.buyer_establishment_no
    )

    # --- line items ---
    y -= 5 * mm
    pdf.setFont("Helvetica-Bold", 10)
    pdf.setFillColor(colors.HexColor("#0f172a"))
    pdf.drawString(20 * mm, y, "Description")
    pdf.drawRightString(120 * mm, y, "Quantity")
    pdf.drawRightString(150 * mm, y, "Unit Price")
    pdf.drawRightString(190 * mm, y, "Amount")
    y -= 2 * mm
    pdf.setStrokeColor(colors.HexColor("#cbd5e1"))
    pdf.line(20 * mm, y, PAGE_WIDTH - 20 * mm, y)
    y -= 6 * mm

    pdf.setFont("Helvetica", 10)
    for item in invoice.items:
        pdf.drawString(20 * mm, y, item.description)
        pdf.drawRightString(120 * mm, y, item.quantity)
        pdf.drawRightString(150 * mm, y, item.unit_price)
        pdf.drawRightString(190 * mm, y, item.line_amount)
        y -= 6.5 * mm

    y -= 3 * mm
    pdf.line(110 * mm, y, PAGE_WIDTH - 20 * mm, y)
    y -= 7 * mm

    for label, value in (
        ("Subtotal", invoice.subtotal),
        ("Tax", invoice.tax_amount),
        ("Total", invoice.face_value),
    ):
        pdf.setFont("Helvetica-Bold" if label == "Total" else "Helvetica", 11)
        pdf.drawString(110 * mm, y, f"{label}: {value} JOD")
        y -= 6.5 * mm

    y = _draw_labelled(pdf, 110 * mm, y - 1 * mm, "Currency", "JOD")

    # --- QR ---
    qr_image = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=10,
        border=2,
    )
    qr_image.add_data(invoice.qr_payload)
    qr_image.make(fit=True)
    rendered = qr_image.make_image(fill_color="black", back_color="white")
    qr_buffer = io.BytesIO()
    rendered.save(qr_buffer, format="PNG")
    qr_buffer.seek(0)

    from reportlab.lib.utils import ImageReader

    pdf.drawImage(
        ImageReader(qr_buffer),
        PAGE_WIDTH - 62 * mm,
        30 * mm,
        width=42 * mm,
        height=42 * mm,
    )
    pdf.setFont("Helvetica", 8)
    pdf.setFillColor(colors.HexColor("#64748b"))
    pdf.drawString(PAGE_WIDTH - 62 * mm, 26 * mm, "Scan to verify — zimmamless-pipe-v1")

    pdf.setFont("Helvetica", 7)
    pdf.drawString(
        20 * mm,
        18 * mm,
        "Generated by services/ml/tools/generate_einvoices.py for Zimmamless V3 testing. Not a tax document.",
    )

    pdf.showPage()
    pdf.save()
    return buffer.getvalue()


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate the seeded e-invoice PDFs.")
    parser.add_argument(
        "--out",
        default=str(OUTPUT_DIR),
        help="Output directory (default: db/seed/einvoices)",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Regenerate in memory and fail if any file on disk differs.",
    )
    args = parser.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    drifted: list[str] = []
    for invoice in SEED_INVOICES:
        target = out_dir / f"{invoice.slug}.pdf"
        rendered = _render(invoice)
        if args.check:
            if not target.exists() or target.read_bytes() != rendered:
                drifted.append(target.name)
            continue
        target.write_bytes(rendered)
        print(
            f"  {target.name}  "
            f"({invoice.face_value} JOD, QR total {invoice.qr_total_override or invoice.face_value})"
        )

    if args.check:
        if drifted:
            print("These generated e-invoices differ from the generator's output:")
            for name in drifted:
                print(f"  {name}")
            print("\nRe-run without --check to regenerate.")
            return 1
        print(f"OK: all {len(SEED_INVOICES)} seeded e-invoices match the generator.")
        return 0

    print(f"\nWrote {len(SEED_INVOICES)} e-invoices to {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
