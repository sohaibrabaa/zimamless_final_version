# Phase 4 — Risk, Trust Score, and ML (A-heavy; B light)

**Objective:** every `ELIGIBLE` transaction carries a real, versioned, explainable Trust Score whose data-availability measure is provably independent of the score. Agent B's calendar time this phase is mostly spent ahead on Phase 5 screens; its Phase 4 scope is the risk display components.

## Agent A tasks

- [ ] Deterministic rules engine: hard eligibility + hard fraud blockers that the ML model **can never override** (ZM-RSK-015).
- [ ] Synthetic training data generator (deterministic, seeded, clearly labelled — ZM-RSK-016); training script producing a simple explainable model (per PA-08) with recorded metrics.
- [ ] Inference endpoint in `/services/ml`; `RiskModelProvider` adapter in the API with **rules-only fallback** when the service is down, `mlUsed=false` + `mlFallbackReason` set (ZM-RSK-017).
- [ ] Scoring: composite 0–100 + band (AS-05 thresholds) + five components (supplier verification, data confidence, buyer profile, invoice score, platform behavior) + `dataAvailabilityPct` computed **separately**.
- [ ] The rule of rules: `sourceAvailable=false` and unpublished fields **never reduce any component** — they reduce `dataAvailabilityPct` and, where essential, raise an `InformationRequest` (ZM-RSK-005/006, INV-9).
- [ ] Positive factors, risk factors, structured reason codes, per-prediction explainability (contributing features + direction).
- [ ] `RiskModelVersion` lifecycle: create-never-edit; single active version (schema index); activation audited with rationale; historical scores keep their version and never change (ZM-RSK-009..011).
- [ ] `GET /transactions/{id}/risk` incl. bilingual disclaimer text; `/admin/risk-models` GET/POST.
- [ ] Bank-facing exclusions: no raw internals, no weights (ZM-RSK-013).
- [ ] Write `docs/specs/ML_DESIGN.md` (data, features, model, metrics, explainability method, honest-limitations text for the UI).
- [ ] Tests: INV-9 paired-fixture (identical facts ± source availability → identical components, lower availability); score immutability across version activation; fallback flag test.

### Endpoints in scope (A)

`/transactions/{id}/risk` · `/admin/risk-models` GET/POST

## Agent B tasks

- [ ] `TrustScoreGauge` (composite + band), `ComponentBars` (five components), `FactorList` (positive/risk factors + reason codes).
- [ ] **Data availability displayed separately** from the score with explanatory tooltip — neutral styling: never a warning color, never a downward arrow (brief §5).
- [ ] Disclaimer visible on every score display, both languages (ZM-RSK-001/002).
- [ ] Model version + calculation date + `mlUsed`/fallback flag display; synthetic-data limitation notice (ZM-RSK-016).
- [ ] Remaining B capacity this phase: begin Phase 5 screens on mocks (marketplace feed, offer form skeletons).

### Screens/components in scope (B)

Risk display component set (used in Phase 5's underwriting view) — mock-driven until `/transactions/{id}/risk` goes live.

## Ownership & collision guard

Disjoint trees; ML service is A's alone.

## Dependencies

Phase 3 checkpoint (real transactions to score).

## Integration checkpoint

Live score with explanation factors on an eligible transaction. Two drills: (1) stop the ML container → recompute → rules-only score with visible degraded flag; (2) ZM-RSK-005 drill — mark a government source unavailable, recompute → **all five components unchanged, `dataAvailabilityPct` lower**, UI shows it neutrally.

## Definition of done

Checkpoint met; INV-9 test in CI; version-immutability test in CI; `ML_DESIGN.md` written.

## Effort

Agent A: 4–6 days · Agent B: 1–2 days on risk components (rest of the window on Phase 5 screens).

## Completion reports

`docs/completion/PHASE_4_AGENT_A.md` · `PHASE_4_AGENT_B.md` · `PHASE_4_CHECKPOINT.md`.
