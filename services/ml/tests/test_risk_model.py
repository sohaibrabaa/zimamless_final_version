"""Tests for the risk model: determinism, learning, and explainability."""

from __future__ import annotations

import json

import numpy as np
import pytest

from app.risk import synthetic
from app.risk.features import FEATURE_NAMES, RiskInput
from app.risk.model import ARTIFACT_PATH, RiskModel, train, _auc


@pytest.fixture(scope="module")
def model() -> RiskModel:
    return RiskModel.load()


class TestDeterminism:
    def test_the_generator_is_reproducible(self):
        first = synthetic.generate(n=500, seed=7)
        second = synthetic.generate(n=500, seed=7)
        assert np.array_equal(first[0], second[0])
        assert np.array_equal(first[1], second[1])

    def test_a_different_seed_gives_different_data(self):
        a, _ = synthetic.generate(n=500, seed=7)
        b, _ = synthetic.generate(n=500, seed=8)
        assert not np.array_equal(a, b)

    def test_training_twice_yields_an_identical_artifact(self):
        # The property `--check` relies on. Full-batch descent from a zero
        # start has no random element, so this must hold exactly.
        X, y = synthetic.generate(n=800, seed=11)
        first = train(X, y, version="t", seed=11, iterations=200).to_json()
        second = train(X, y, version="t", seed=11, iterations=200).to_json()
        assert first == second

    def test_the_committed_artifact_is_current(self, model: RiskModel):
        X, y = synthetic.generate(n=6000, seed=synthetic.DEFAULT_SEED)
        fresh = train(X, y, version=model.version, seed=synthetic.DEFAULT_SEED)
        assert fresh.to_json() == ARTIFACT_PATH.read_text(encoding="utf-8")


class TestLearning:
    def test_it_recovers_the_sign_of_every_ground_truth_weight(self, model: RiskModel):
        # A real check that training works: the generator encodes known
        # directions, and the fitted coefficients must agree on all of them.
        # It says nothing about real-world validity — the data is synthetic.
        for name, coefficient in zip(model.feature_names, model.coefficients):
            expected = synthetic.TRUE_WEIGHTS[name]
            assert np.sign(coefficient) == np.sign(expected), name

    def test_it_separates_the_classes_better_than_chance(self, model: RiskModel):
        assert model.metrics.auc > 0.8
        assert model.metrics.accuracy > 0.75

    def test_the_metrics_are_recorded_with_the_model(self, model: RiskModel):
        # ZM-RSK-017 requires recorded training metrics, not just a model.
        recorded = json.loads(ARTIFACT_PATH.read_text(encoding="utf-8"))["metrics"]
        assert recorded["samples"] == 6000
        assert 0 < recorded["positive_rate"] < 1
        assert recorded["test_samples"] > 0

    def test_it_is_labelled_synthetic(self, model: RiskModel):
        # ZM-RSK-016. The flag travels with the artifact so nothing can
        # display a score without the limitation attached.
        assert model.synthetic is True

    def test_auc_handles_a_degenerate_single_class(self):
        assert _auc([1.0, 1.0, 1.0], [0.2, 0.5, 0.9]) == 0.5

    def test_auc_averages_tied_scores(self):
        # All predictions identical: no discrimination, exactly 0.5.
        assert _auc([1.0, 0.0, 1.0, 0.0], [0.5, 0.5, 0.5, 0.5]) == 0.5


class TestPrediction:
    def test_a_clean_invoice_scores_lower_risk_than_a_troubled_one(self, model: RiskModel):
        clean = synthetic.example_input()
        troubled = RiskInput(
            **{
                **clean.__dict__,
                "duplicate_collision": True,
                "dispute_count": 2,
                "recourse_count": 1,
                "electronic_invoice_attached": False,
            }
        )
        assert model.probability(clean) < model.probability(troubled)

    def test_probability_stays_in_range_for_extreme_input(self, model: RiskModel):
        extreme = RiskInput(
            tenor_days=100_000,
            face_value=1e12,
            subtotal_amount=1e12,
            tax_amount=0,
            completeness_ratio=0,
            duplicate_collision=True,
            electronic_invoice_attached=False,
            partially_paid=True,
            prior_submitted_count=0,
            dispute_count=99,
            duplicate_referral_count=99,
            recourse_count=99,
        )
        p = model.probability(extreme)
        assert 0.0 <= p <= 1.0

    def test_a_missing_payload_key_falls_back_rather_than_raising(self):
        # The API is the only caller, but a 500 here would turn a scoring
        # request into an outage when a rules-only answer was available.
        features = RiskInput.from_payload({})
        assert len(features.to_vector()) == len(FEATURE_NAMES)

    def test_a_non_numeric_payload_value_is_coerced_not_fatal(self):
        features = RiskInput.from_payload({"tenorDays": "not-a-number", "faceValue": None})
        assert features.tenor_days == 0.0
        assert features.face_value == 0.0


class TestExplainability:
    def test_every_contribution_is_signed_and_labelled(self, model: RiskModel):
        contributions = model.explain(synthetic.example_input())
        assert contributions
        for entry in contributions:
            assert entry["feature"] in FEATURE_NAMES
            assert entry["label"]
            assert entry["direction"] in {"INCREASES_RISK", "DECREASES_RISK"}
            # The sign convention must agree with the word, or a consumer
            # that trusts one and displays the other inverts the meaning.
            if entry["direction"] == "INCREASES_RISK":
                assert entry["contribution"] > 0
            else:
                assert entry["contribution"] < 0

    def test_contributions_are_ordered_by_absolute_effect(self, model: RiskModel):
        contributions = model.explain(synthetic.example_input())
        magnitudes = [abs(e["contribution"]) for e in contributions]
        assert magnitudes == sorted(magnitudes, reverse=True)

    def test_a_duplicate_collision_shows_up_as_a_risk_driver(self, model: RiskModel):
        clean = synthetic.example_input()
        flagged = RiskInput(**{**clean.__dict__, "duplicate_collision": True})
        entry = next(
            e for e in model.explain(flagged) if e["feature"] == "duplicate_collision"
        )
        assert entry["direction"] == "INCREASES_RISK"

    def test_contributions_reconstruct_the_prediction(self, model: RiskModel):
        # The explanation is the model, not a post-hoc approximation of it:
        # intercept plus the contributions must give back the log-odds.
        features = synthetic.example_input()
        total = model.intercept + sum(
            e["contribution"] for e in model.explain(features)
        )
        expected = 1.0 / (1.0 + np.exp(-total))
        assert model.probability(features) == pytest.approx(expected, abs=1e-6)


class TestArtifactIntegrity:
    def test_it_refuses_an_artifact_whose_feature_order_differs(self):
        payload = json.loads(ARTIFACT_PATH.read_text(encoding="utf-8"))
        payload["featureNames"] = list(reversed(payload["featureNames"]))
        # Scoring with transposed columns would produce confident nonsense,
        # which is worse than refusing.
        with pytest.raises(ValueError, match="feature order"):
            RiskModel.from_dict(payload)
