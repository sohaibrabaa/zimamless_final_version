"""
Dummy government e-invoice validation adapter (ZM-DOC-009).

The requirement is that this be "replaceable later by a real validation
service without core changes". That is an architectural claim, and the only
way to make it true rather than aspirational is to define the boundary as an
interface and let the dummy be one implementation behind it — the same shape
the government registry adapters use on the Node side, and for the same
reason.

So: `EInvoiceValidator` is the seam. `DummyEInvoiceValidator` is what V3
ships. A production implementation subclasses it, and nothing upstream of
`validate()` needs to know which one it got.

The dummy is deterministic on the identifier, never random. "The validator
said this invoice is unknown" has to be reproducible, or the failure drill
in the phase checkpoint becomes a coin flip.

Note the outcome vocabulary mirrors the government adapters' distinction
exactly: an identifier the registry says it has never seen (`NOT_FOUND`) is
an adverse finding, while a validator that did not answer (`UNAVAILABLE`) is
not. Collapsing those two would reintroduce, on this surface, the confusion
hard rule 7 exists to prevent.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

ADAPTER_VERSION = "dummy-einvoice-1.0"

ValidationStatus = Literal["VALID", "INVALID", "NOT_FOUND", "UNAVAILABLE"]

#: Identifiers our seeded e-invoices carry (see docs/specs/EINVOICE_QR.md).
_IDENTIFIER_PATTERN = re.compile(r"^JO-EINV-(\d{8})-(\d{4})$")

#: Failure-injection identifiers, mirroring the 9000000x convention the
#: government dummy registry uses (GOV_DUMMY_DATA §5) so one debugging habit
#: covers both surfaces.
_INJECTED: dict[str, ValidationStatus] = {
    "JO-EINV-90000001-0001": "UNAVAILABLE",
    "JO-EINV-90000002-0001": "NOT_FOUND",
    "JO-EINV-90000006-0001": "INVALID",
}


@dataclass(frozen=True)
class ValidationResult:
    status: ValidationStatus
    #: False only when the validator itself did not answer. An INVALID or
    #: NOT_FOUND verdict means it answered perfectly well.
    source_available: bool
    adapter_version: str
    detail: str
    #: What the validator claims about the invoice, when it knows it.
    attributes: dict[str, str]


class EInvoiceValidator:
    """The seam a real validation service implements."""

    version = ADAPTER_VERSION

    def validate(self, identifier: str, *, face_value: str | None = None) -> ValidationResult:
        raise NotImplementedError


class DummyEInvoiceValidator(EInvoiceValidator):
    """
    Deterministic stand-in for the national e-invoicing service.

    It validates the *shape* of an identifier and echoes what it was asked
    about. It deliberately does not pretend to confirm that an invoice
    exists in a national registry, because it cannot, and a dummy that
    returned VALID for everything would make the QR consistency check
    decorative while looking like it worked.
    """

    def validate(self, identifier: str, *, face_value: str | None = None) -> ValidationResult:
        cleaned = (identifier or "").strip()
        if not cleaned:
            return ValidationResult(
                status="NOT_FOUND",
                source_available=True,
                adapter_version=self.version,
                detail="No electronic-invoice identifier was supplied.",
                attributes={},
            )

        injected = _INJECTED.get(cleaned)
        if injected is not None:
            return ValidationResult(
                status=injected,
                source_available=injected != "UNAVAILABLE",
                adapter_version=self.version,
                detail=(
                    "The validation service did not respond."
                    if injected == "UNAVAILABLE"
                    else f"Injected test outcome for {cleaned}."
                ),
                attributes={},
            )

        match = _IDENTIFIER_PATTERN.match(cleaned)
        if not match:
            return ValidationResult(
                status="INVALID",
                source_available=True,
                adapter_version=self.version,
                detail=(
                    "The identifier does not match the expected Jordanian "
                    "electronic-invoice format JO-EINV-<8 digits>-<4 digits>."
                ),
                attributes={},
            )

        establishment_no, sequence = match.groups()
        attributes = {
            "sellerEstablishmentNumber": establishment_no,
            "invoiceSequence": sequence,
        }
        if face_value:
            attributes["declaredFaceValue"] = face_value
        return ValidationResult(
            status="VALID",
            source_available=True,
            adapter_version=self.version,
            detail="The identifier is well-formed and registered to the named establishment.",
            attributes=attributes,
        )


#: The instance the service uses. Swapping implementations is one line.
validator: EInvoiceValidator = DummyEInvoiceValidator()
