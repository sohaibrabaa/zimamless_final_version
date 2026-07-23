"""Synthetic training data — clearly labelled as such (ZM-RSK-016).

There is no historical Jordanian receivables-default dataset available to this
project, and inventing one silently would be worse than having none. So the
data is generated here, from an explicit ground-truth process written in the
open below, and every artifact trained on it records `"synthetic": true`. The
UI carries the limitation notice, the completion report repeats it, and
`ML_DESIGN.md` states the generating process in full.

What this data can and cannot support is worth being blunt about: a model
trained here has learned the relationships this file encodes, and nothing
else. It demonstrates that the pipeline is real, executable, versioned, and
explainable — which is what ZM-RSK-014 asks for. It does not demonstrate
predictive validity on real receivables, and no report should say it does.

Determinism is a hard requirement: the same seed must produce byte-identical
training data and therefore a byte-identical artifact, so that a model version
in the database can be regenerated and checked years later. `numpy.random.
Generator(PCG64(seed))` is stable across numpy versions in a way the legacy
`RandomState` global is not.
"""

from __future__ import annotations

import numpy as np

from .features import FEATURE_NAMES, RiskInput

#: Fixed so the shipped artifact is reproducible. Change it and the model
#: changes, which is why it lives here rather than in a CLI default.
DEFAULT_SEED = 20260723

#: The ground-truth log-odds relationship the generator encodes. These are the
#: things a receivables underwriter would actually worry about, expressed as
#: weights on the standardized features. The model's job is to recover them;
#: the test suite asserts that it recovers their SIGNS, which is a meaningful
#: check that training works and a meaningless one about the real world.
TRUE_WEIGHTS: dict[str, float] = {
    "tenor_days": 0.45,  # longer money is out, more can go wrong
    "log_face_value": 0.35,  # bigger tickets default harder
    "tax_ratio": 0.05,
    "completeness_ratio": -0.60,  # sloppy paperwork predicts trouble
    "duplicate_collision": 1.40,  # the strongest single signal
    "electronic_invoice_attached": -0.80,
    "partially_paid": 0.30,
    "prior_submitted_count": -0.55,  # a track record is protective
    "dispute_count": 0.95,
    "duplicate_referral_count": 1.10,
    "recourse_count": 0.85,
}

TRUE_INTERCEPT = -1.15


def generate(n: int = 6000, seed: int = DEFAULT_SEED) -> tuple[np.ndarray, np.ndarray]:
    """Returns (X, y): feature matrix and binary "went bad" labels.

    The marginal distributions are chosen to look like the platform's own
    seeded population rather than like a textbook: most invoices are clean,
    most suppliers have short histories, disputes are rare.
    """
    rng = np.random.Generator(np.random.PCG64(seed))

    tenor_days = np.clip(rng.gamma(shape=4.0, scale=22.0, size=n), 1, 365)
    face_value = np.clip(rng.lognormal(mean=9.0, sigma=1.0, size=n), 100, 5_000_000)
    subtotal = face_value / 1.16
    tax_ratio = np.clip(rng.normal(0.16, 0.02, size=n), 0.0, 0.30)
    completeness = np.clip(rng.beta(9.0, 1.2, size=n), 0.0, 1.0)

    # Rare adverse events, at roughly the rates a working platform sees.
    duplicate_collision = (rng.random(n) < 0.04).astype(float)
    einvoice_attached = (rng.random(n) < 0.94).astype(float)
    partially_paid = (rng.random(n) < 0.12).astype(float)

    prior_submitted = rng.poisson(3.0, size=n).astype(float)
    disputes = rng.poisson(0.18, size=n).astype(float)
    duplicate_referrals = rng.poisson(0.10, size=n).astype(float)
    recourse = rng.poisson(0.08, size=n).astype(float)

    columns = {
        "tenor_days": tenor_days,
        "log_face_value": np.log10(np.maximum(face_value, 1.0)),
        "tax_ratio": tax_ratio,
        "completeness_ratio": completeness,
        "duplicate_collision": duplicate_collision,
        "electronic_invoice_attached": einvoice_attached,
        "partially_paid": partially_paid,
        "prior_submitted_count": prior_submitted,
        "dispute_count": disputes,
        "duplicate_referral_count": duplicate_referrals,
        "recourse_count": recourse,
    }
    X = np.column_stack([columns[name] for name in FEATURE_NAMES])

    # Labels are drawn from the standardized ground truth, so the intercept
    # controls the base rate independently of each feature's scale.
    standardized = (X - X.mean(axis=0)) / _safe_std(X)
    weights = np.array([TRUE_WEIGHTS[name] for name in FEATURE_NAMES])
    log_odds = TRUE_INTERCEPT + standardized @ weights
    probability = 1.0 / (1.0 + np.exp(-log_odds))
    y = (rng.random(n) < probability).astype(float)

    return X, y


def _safe_std(X: np.ndarray) -> np.ndarray:
    """Standard deviation with zero-variance columns neutralized to 1.

    A constant column would otherwise divide by zero and poison the whole
    matrix with NaN — and a constant column is exactly what a small synthetic
    draw can produce for a rare binary feature.
    """
    std = X.std(axis=0)
    std[std == 0] = 1.0
    return std


def example_input() -> RiskInput:
    """A representative clean transaction, used by the tests and the README."""
    return RiskInput(
        tenor_days=90,
        face_value=12354.0,
        subtotal_amount=10650.0,
        tax_amount=1704.0,
        completeness_ratio=1.0,
        duplicate_collision=False,
        electronic_invoice_attached=True,
        partially_paid=False,
        prior_submitted_count=4,
        dispute_count=0,
        duplicate_referral_count=0,
        recourse_count=0,
    )
