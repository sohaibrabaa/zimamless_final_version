"""Model loading and the scoring entry point used by the HTTP layer.

The model is loaded once, lazily, behind a lock — the same pattern the OCR
engine uses, for the same reason: uvicorn serves requests on a thread pool,
and two simultaneous first requests would otherwise each parse the artifact.

If the artifact is missing or malformed the service reports the model as
unavailable rather than raising on every request. That is not defensive
padding: the API's contract with this service is that an unreachable or
unhealthy model produces a rules-only score with `mlUsed=false`
(ZM-RSK-017), and a service returning 500 forever is indistinguishable from
one that is down — so it may as well say so honestly at /health.
"""

from __future__ import annotations

import logging
import threading
from typing import Any

from .features import RiskInput
from .model import RiskModel

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_model: RiskModel | None = None
_load_attempted = False
_load_error: str | None = None


def get_model() -> RiskModel | None:
    """Returns the loaded model, or None if the artifact cannot be used."""
    global _model, _load_attempted, _load_error

    if _load_attempted:
        return _model

    with _lock:
        if _load_attempted:
            return _model
        try:
            _model = RiskModel.load()
            logger.info("risk model loaded version=%s", _model.version)
        except Exception as exc:  # noqa: BLE001 — reported, never raised onward
            _load_error = str(exc)
            _model = None
            logger.warning("risk model unavailable: %s", exc)
        finally:
            _load_attempted = True

    return _model


def model_available() -> bool:
    return get_model() is not None


def load_error() -> str | None:
    get_model()
    return _load_error


def reset_for_tests() -> None:
    """Clears the cached model. Test-only."""
    global _model, _load_attempted, _load_error
    with _lock:
        _model = None
        _load_attempted = False
        _load_error = None


def score(payload: dict[str, Any]) -> dict[str, Any]:
    """Scores one transaction.

    Returns `modelAvailable: false` rather than raising when there is no
    usable artifact, so the API sees the same shape either way and its
    fallback path is a branch on a field rather than an exception handler.
    """
    model = get_model()
    if model is None:
        return {
            "modelAvailable": False,
            "unavailableReason": load_error() or "No trained model artifact is present.",
            "modelVersion": None,
            "riskProbability": None,
            "contributions": [],
            "synthetic": True,
        }

    features = RiskInput.from_payload(payload)
    probability = model.probability(features)

    return {
        "modelAvailable": True,
        "unavailableReason": None,
        "modelVersion": model.version,
        "trainerVersion": model.trainer_version,
        # Rounded at the boundary so two callers computing from the same
        # response cannot disagree in the sixth decimal place.
        "riskProbability": round(probability, 6),
        "contributions": model.explain(features),
        "metrics": model.metrics.to_dict(),
        # ZM-RSK-016: the limitation travels WITH the prediction, so no
        # consumer can display a score without having been told.
        "synthetic": model.synthetic,
    }
