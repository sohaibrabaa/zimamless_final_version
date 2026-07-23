"""Logistic regression: training, metrics, inference, and explanation.

Written out rather than imported from scikit-learn, for three reasons that all
point the same way:

  1. **Explainability is the requirement** (ZM-RSK-017), and a linear model in
     standardized space gives it exactly: the contribution of feature *j* to a
     prediction is `coef[j] * z[j]`, a signed number in log-odds that sums —
     with the intercept — to the prediction itself. Nothing is approximated,
     nothing is sampled, and there is no separate explainer library whose
     output could disagree with the model.
  2. **Determinism.** Full-batch gradient descent from a zero start has no
     random initialisation, no shuffling, and no early-stopping heuristic, so
     the artifact is reproducible from the seed alone.
  3. **The pure-wheel constraint** the OCR work already established for this
     service. scikit-learn would be a large dependency for ~60 lines of
     arithmetic.

`ZM-RSK-018` applies to how this is described: these are anomaly and risk
*estimates* from synthetic training data. It is not forensic detection and
must never be labelled as such.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np

from .features import FEATURE_LABELS, FEATURE_NAMES, RiskInput

ARTIFACT_PATH = Path(__file__).with_name("model_artifact.json")

#: Bumped when the training procedure or feature set changes in a way that
#: makes older artifacts incomparable. Recorded in the artifact and checked at
#: load time.
TRAINER_VERSION = "risk-logreg-1.0"


@dataclass(frozen=True)
class TrainingMetrics:
    """Recorded with the version (ZM-RSK-017) and surfaced to admins."""

    samples: int
    train_samples: int
    test_samples: int
    positive_rate: float
    accuracy: float
    auc: float
    brier: float
    log_loss: float
    iterations: int

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class RiskModel:
    version: str
    trainer_version: str
    feature_names: tuple[str, ...]
    means: np.ndarray
    stds: np.ndarray
    coefficients: np.ndarray
    intercept: float
    metrics: TrainingMetrics
    synthetic: bool
    seed: int

    # -- inference ----------------------------------------------------

    def probability(self, features: RiskInput) -> float:
        """P(the receivable goes bad), 0..1."""
        z = self._standardize(np.array(features.to_vector(), dtype=float))
        return float(_sigmoid(self.intercept + float(z @ self.coefficients)))

    def explain(self, features: RiskInput) -> list[dict[str, Any]]:
        """Per-prediction contributions, largest absolute effect first.

        Each entry's `contribution` is in log-odds and is signed:
        positive pushes toward "goes bad", negative toward "performs".
        `direction` states that in words so a consumer never has to infer the
        sign convention — which is the kind of thing that gets inverted once
        and then believed for a year.
        """
        z = self._standardize(np.array(features.to_vector(), dtype=float))
        contributions = self.coefficients * z

        entries = [
            {
                "feature": name,
                "label": FEATURE_LABELS.get(name, name),
                "contribution": round(float(value), 6),
                "direction": "INCREASES_RISK" if value > 0 else "DECREASES_RISK",
            }
            for name, value in zip(self.feature_names, contributions)
            # A feature sitting exactly at the training mean contributed
            # nothing; listing it as a factor would be noise.
            if abs(value) > 1e-9
        ]
        entries.sort(key=lambda e: abs(e["contribution"]), reverse=True)
        return entries

    def _standardize(self, x: np.ndarray) -> np.ndarray:
        return (x - self.means) / self.stds

    # -- persistence --------------------------------------------------

    def to_json(self) -> str:
        payload = {
            "version": self.version,
            "trainerVersion": self.trainer_version,
            "featureNames": list(self.feature_names),
            "means": [round(float(v), 10) for v in self.means],
            "stds": [round(float(v), 10) for v in self.stds],
            "coefficients": [round(float(v), 10) for v in self.coefficients],
            "intercept": round(float(self.intercept), 10),
            "metrics": self.metrics.to_dict(),
            "synthetic": self.synthetic,
            "seed": self.seed,
        }
        # sort_keys so two runs produce byte-identical files — the same
        # discipline the seed e-invoice generator needed.
        return json.dumps(payload, indent=2, sort_keys=True) + "\n"

    @staticmethod
    def from_dict(payload: Mapping[str, Any]) -> "RiskModel":
        names = tuple(payload["featureNames"])
        if names != FEATURE_NAMES:
            # Refusing beats silently scoring with the columns transposed.
            raise ValueError(
                "Artifact feature order does not match this build. "
                f"artifact={names} expected={FEATURE_NAMES}"
            )
        return RiskModel(
            version=payload["version"],
            trainer_version=payload.get("trainerVersion", "unknown"),
            feature_names=names,
            means=np.array(payload["means"], dtype=float),
            stds=np.array(payload["stds"], dtype=float),
            coefficients=np.array(payload["coefficients"], dtype=float),
            intercept=float(payload["intercept"]),
            metrics=TrainingMetrics(**payload["metrics"]),
            synthetic=bool(payload.get("synthetic", True)),
            seed=int(payload.get("seed", 0)),
        )

    @staticmethod
    def load(path: Path = ARTIFACT_PATH) -> "RiskModel":
        return RiskModel.from_dict(json.loads(path.read_text(encoding="utf-8")))


def _sigmoid(z: np.ndarray | float) -> np.ndarray | float:
    """Numerically stable logistic function.

    The naive form overflows for large negative z and returns nan rather than
    0.0 — which then propagates into the metrics and looks like a broken
    model rather than a broken sigmoid.
    """
    return np.where(
        np.asarray(z) >= 0,
        1.0 / (1.0 + np.exp(-np.abs(z))),
        np.exp(-np.abs(z)) / (1.0 + np.exp(-np.abs(z))),
    )


def train(
    X: np.ndarray,
    y: np.ndarray,
    *,
    version: str,
    seed: int,
    iterations: int = 4000,
    learning_rate: float = 0.35,
    l2: float = 1e-3,
    test_fraction: float = 0.25,
) -> RiskModel:
    """Full-batch gradient descent on the log-loss, with L2 regularisation.

    The train/test split is a deterministic slice, not a random one: the data
    is already generated in random order, so taking the tail is as unbiased as
    shuffling and does not add a second seed to reason about.
    """
    n = X.shape[0]
    split = int(n * (1 - test_fraction))
    X_train, y_train = X[:split], y[:split]
    X_test, y_test = X[split:], y[split:]

    means = X_train.mean(axis=0)
    stds = X_train.std(axis=0)
    stds[stds == 0] = 1.0

    Z = (X_train - means) / stds
    weights = np.zeros(Z.shape[1], dtype=float)
    intercept = 0.0

    for _ in range(iterations):
        predictions = _sigmoid(intercept + Z @ weights)
        error = predictions - y_train
        grad_w = (Z.T @ error) / len(y_train) + l2 * weights
        grad_b = float(error.mean())
        weights -= learning_rate * grad_w
        intercept -= learning_rate * grad_b

    Z_test = (X_test - means) / stds
    test_probabilities = np.asarray(_sigmoid(intercept + Z_test @ weights), dtype=float)

    metrics = TrainingMetrics(
        samples=n,
        train_samples=len(y_train),
        test_samples=len(y_test),
        positive_rate=round(float(y.mean()), 6),
        accuracy=round(float(((test_probabilities >= 0.5) == (y_test == 1)).mean()), 6),
        auc=round(_auc(y_test, test_probabilities), 6),
        brier=round(float(np.mean((test_probabilities - y_test) ** 2)), 6),
        log_loss=round(_log_loss(y_test, test_probabilities), 6),
        iterations=iterations,
    )

    return RiskModel(
        version=version,
        trainer_version=TRAINER_VERSION,
        feature_names=FEATURE_NAMES,
        means=means,
        stds=stds,
        coefficients=weights,
        intercept=float(intercept),
        metrics=metrics,
        synthetic=True,
        seed=seed,
    )


def _auc(y_true: Sequence[float], scores: Sequence[float]) -> float:
    """ROC AUC via the rank-sum identity, with ties averaged.

    Equivalent to the Mann-Whitney U statistic over the two label groups, and
    exact rather than trapezoid-approximated.
    """
    y = np.asarray(y_true, dtype=float)
    s = np.asarray(scores, dtype=float)
    positives = int(y.sum())
    negatives = int(len(y) - positives)
    if positives == 0 or negatives == 0:
        return 0.5

    order = np.argsort(s, kind="mergesort")
    ranks = np.empty(len(s), dtype=float)
    ranks[order] = np.arange(1, len(s) + 1, dtype=float)

    # Average ranks within tied score groups, or AUC is biased by ordering.
    sorted_scores = s[order]
    start = 0
    for end in range(1, len(s) + 1):
        if end == len(s) or sorted_scores[end] != sorted_scores[start]:
            if end - start > 1:
                ranks[order[start:end]] = ranks[order[start:end]].mean()
            start = end

    rank_sum = ranks[y == 1].sum()
    return float((rank_sum - positives * (positives + 1) / 2) / (positives * negatives))


def _log_loss(y_true: Sequence[float], probabilities: Sequence[float]) -> float:
    y = np.asarray(y_true, dtype=float)
    p = np.clip(np.asarray(probabilities, dtype=float), 1e-12, 1 - 1e-12)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))
