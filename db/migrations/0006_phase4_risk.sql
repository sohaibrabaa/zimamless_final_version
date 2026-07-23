-- =====================================================================
-- 0006 — Phase 4: risk model configuration and disclosure hardening
-- =====================================================================
-- Additive only. No column is altered, no constraint is changed, and no
-- response shape moves. Two things happen here:
--
--   1. A column-level REVOKE closing a ZM-RSK-013 gap that migration 0003
--      left open (see §1).
--   2. The baseline risk model version, without which nothing can be
--      scored at all (see §2).
--
-- Both are platform configuration rather than dev fixtures, which is why
-- they live in a migration next to `platform_settings` rather than in
-- db/seed. A hosted database with migrations applied and no seed must still
-- be able to produce a Trust Score.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. ZM-RSK-013 — feature weights are not bank-readable
-- ---------------------------------------------------------------------
-- Migration 0003 wrote `CREATE POLICY risk_models_read ON
-- risk_model_versions FOR SELECT USING (true)` with a comment reasoning
-- that "weights and training metrics are not secret either —
-- explainability is a requirement".
--
-- That conflated two different things, and ZM-RSK-013 is explicit about
-- the difference: banks MUST NOT receive "raw model internals, feature
-- weights, proprietary implementation details". Explainability is
-- discharged by per-prediction contributing factors and reason codes —
-- which the API does return to banks — not by handing over the weight
-- vector. As written, any authenticated bank user could read the whole
-- scoring configuration straight from the Supabase client, bypassing the
-- API's careful bank-facing DTO entirely.
--
-- Closed the same way D-02 closes the supplier floor, using the same
-- technique for the same non-obvious reason: a bare
-- `REVOKE SELECT (col) ... ` does NOT work while a table-level SELECT grant
-- exists, because table-level privileges satisfy a column read on their own.
-- Postgres accepts the statement and changes nothing. So the table grant is
-- dropped and re-issued column by column — every column EXCEPT the two
-- withheld ones.
--
-- The row stays readable (a bank still needs the version label and effective
-- date to display beside a score); the weights and the metrics are not. The
-- API reads with the service role and is unaffected, and
-- `GET /admin/risk-models` remains platform-only at the route layer.
REVOKE SELECT ON risk_model_versions FROM authenticated;
GRANT SELECT (
  id, version_label, model_type, band_thresholds, is_active,
  effective_from, effective_to, activated_by, activation_reason, created_at
) ON risk_model_versions TO authenticated;

-- ---------------------------------------------------------------------
-- 2. The baseline model version (ZM-RSK-009/010)
-- ---------------------------------------------------------------------
-- Created, never edited. If a later phase changes the weights it inserts a
-- NEW row and deactivates this one; the partial unique index
-- `uq_one_active_risk_model` makes two active versions impossible, and
-- every assessment already calculated keeps pointing at the version that
-- produced it.
--
-- `version_label` matches the artifact emitted by
-- `services/ml/tools/train_risk_model.py`, so a stored score can be traced
-- to the exact model file that produced it. `training_metrics` is the
-- verbatim metrics block from that artifact — recorded here rather than
-- fetched at runtime, because ZM-RSK-010 requires a historical score to
-- stay explainable even if the ML service is rebuilt or retired.
--
-- ON CONFLICT so re-running the migrations on a database that already has
-- it is a no-op rather than a unique violation.
INSERT INTO risk_model_versions
  (version_label, model_type, weights, band_thresholds, is_active,
   training_metrics, effective_from, activation_reason)
VALUES (
  'risk-logreg-1.0+seed20260723',
  'HYBRID',
  -- Component weights sum to 1.0. `ml` is the separate share of the
  -- composite the trained model may move — a deliberate minority, because
  -- the model is trained on synthetic data (ZM-RSK-016) and its predictive
  -- validity on real Jordanian receivables is unestablished.
  '{"supplierVerification":0.20,"dataConfidence":0.15,"buyerProfile":0.25,'
  '"invoiceScore":0.30,"platformBehavior":0.10,"ml":0.25}'::jsonb,
  -- AS-05.
  '{"LOW":75,"MEDIUM":50,"HIGH":25}'::jsonb,
  true,
  '{"accuracy":0.851333,"auc":0.90986,"brier":0.107098,"iterations":4000,'
  '"log_loss":0.342912,"positive_rate":0.3165,"samples":6000,'
  '"test_samples":1500,"train_samples":4500,"synthetic":true,'
  '"trainingData":"synthetic, seed 20260723 — see docs/specs/ML_DESIGN.md"}'::jsonb,
  now(),
  'Initial Phase 4 baseline. Rules-weighted composite with a 25% share for '
  'the logistic-regression model trained on synthetic demonstration data.'
)
ON CONFLICT (version_label) DO NOTHING;

COMMIT;

-- =====================================================================
-- Verification
-- =====================================================================
--   SELECT version_label, model_type, is_active FROM risk_model_versions;
--   -- exactly one row with is_active = true
--
--   SELECT has_column_privilege('authenticated','risk_model_versions','weights','SELECT');
--   -- false
-- =====================================================================
