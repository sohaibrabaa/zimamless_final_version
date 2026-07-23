"""The feature vocabulary for the risk model.

The single most important property of this file is what it LEAVES OUT.

Every feature below is derived from a fact the platform holds in its own
database: the invoice the supplier typed, the document they attached, the
history they built here. Not one feature comes from a government registry, a
third-party lookup, or any source that can be down.

That is a deliberate architectural choice in service of ZM-RSK-005/INV-9. The
requirement is that an unavailable source must never reduce the Trust Score.
The API layer enforces it arithmetically, by dropping unavailable signals from
both sides of the component average. But a model is harder to reason about
than an average: if `registry_status_known` were a feature, the model would be
free to learn "unknown registry ⇒ riskier", and it would be *right* to learn
that from the data while being *wrong* under the requirement. No amount of
downstream clamping fixes a model that has internalised the correlation.

So the correlation is made unlearnable instead. With no availability-derived
feature in the vector, the model's output is provably invariant to source
downtime — the same argument as the API's, but made once, here, by omission.

`ml_used=false` fallback is the same story from the other side: when the model
service itself is unavailable, the score is produced by rules alone rather
than by a model called with substituted values.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Mapping

#: Order is part of the trained artifact. Appending is safe; reordering or
#: removing a name invalidates every model trained before the change, which is
#: why the artifact records this list and inference refuses a mismatch.
FEATURE_NAMES: tuple[str, ...] = (
    "tenor_days",
    "log_face_value",
    "tax_ratio",
    "completeness_ratio",
    "duplicate_collision",
    "electronic_invoice_attached",
    "partially_paid",
    "prior_submitted_count",
    "dispute_count",
    "duplicate_referral_count",
    "recourse_count",
)

#: Human-readable labels, returned with each per-prediction explanation so a
#: reviewer sees "Remaining tenor" rather than "tenor_days". Not localized —
#: the API maps these to reason codes; UI strings live in the web locales.
FEATURE_LABELS: Mapping[str, str] = {
    "tenor_days": "Remaining tenor in days",
    "log_face_value": "Invoice size",
    "tax_ratio": "Tax as a share of subtotal",
    "completeness_ratio": "Invoice field completeness",
    "duplicate_collision": "Duplicate fingerprint detected",
    "electronic_invoice_attached": "Electronic invoice attached",
    "partially_paid": "Invoice already partly paid",
    "prior_submitted_count": "Prior invoices submitted by this supplier",
    "dispute_count": "Prior disputes",
    "duplicate_referral_count": "Prior duplicate referrals",
    "recourse_count": "Prior recourse cases",
}


@dataclass(frozen=True)
class RiskInput:
    """One transaction, as the model sees it.

    Every field has a defined value for every transaction — there is no
    Optional here, by design (see the module docstring).
    """

    tenor_days: float
    face_value: float
    subtotal_amount: float
    tax_amount: float
    completeness_ratio: float
    duplicate_collision: bool
    electronic_invoice_attached: bool
    partially_paid: bool
    prior_submitted_count: float
    dispute_count: float
    duplicate_referral_count: float
    recourse_count: float

    @staticmethod
    def from_payload(payload: Mapping[str, Any]) -> "RiskInput":
        """Builds from the API's JSON body, coercing defensively.

        A missing key is taken as its neutral value rather than raising: the
        caller is the API, the API is the only caller, and a 500 here would
        turn a scoring request into an outage when the honest answer is a
        rules-only fallback.
        """

        def num(key: str, default: float = 0.0) -> float:
            value = payload.get(key, default)
            try:
                out = float(value)
            except (TypeError, ValueError):
                return default
            return out if math.isfinite(out) else default

        def flag(key: str) -> bool:
            return bool(payload.get(key, False))

        return RiskInput(
            tenor_days=num("tenorDays"),
            face_value=num("faceValue"),
            subtotal_amount=num("subtotalAmount"),
            tax_amount=num("taxAmount"),
            completeness_ratio=num("completenessRatio", 1.0),
            duplicate_collision=flag("duplicateCollision"),
            electronic_invoice_attached=flag("electronicInvoiceAttached"),
            partially_paid=flag("partiallyPaid"),
            prior_submitted_count=num("priorSubmittedCount"),
            dispute_count=num("disputeCount"),
            duplicate_referral_count=num("duplicateReferralCount"),
            recourse_count=num("recourseCount"),
        )

    def to_vector(self) -> list[float]:
        """Feature values in `FEATURE_NAMES` order.

        Money enters only through `log_face_value` and `tax_ratio`, both of
        which are dimensionless. No JOD amount is ever compared, summed, or
        rounded here — the platform's money arithmetic lives in the API's
        decimal layer, and this file must never become a second one.
        """
        tax_ratio = self.tax_amount / self.subtotal_amount if self.subtotal_amount > 0 else 0.0
        return [
            self.tenor_days,
            math.log10(max(self.face_value, 1.0)),
            tax_ratio,
            self.completeness_ratio,
            1.0 if self.duplicate_collision else 0.0,
            1.0 if self.electronic_invoice_attached else 0.0,
            1.0 if self.partially_paid else 0.0,
            self.prior_submitted_count,
            self.dispute_count,
            self.duplicate_referral_count,
            self.recourse_count,
        ]
