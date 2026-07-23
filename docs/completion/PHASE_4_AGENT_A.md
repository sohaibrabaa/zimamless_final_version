# Phase 4 Completion Report — Agent A

**Phase:** 4 — Risk, Trust Score, and ML
**Agent:** A (backend)
**Sessions spent:** 1 (planned range: 4–6 days)
**Dates:** 2026-07-23
**Phase file:** `docs/plan/phases/PHASE_4_RISK_ML.md`

---

## 1. Delivered vs. planned

| Planned item | Status | Notes |
|---|---|---|
| Deterministic rules engine; hard blockers the ML **cannot** override (ZM-RSK-015) | ✅ done | `rules-engine.ts`. Enforced by ordering — `capForBlockers` runs after the model blend, so no model output can lift a blocked transaction out of CRITICAL. Named test in §3. |
| Synthetic training data generator (deterministic, seeded, labelled — ZM-RSK-016) | ✅ done | `services/ml/app/risk/synthetic.py`, seed `20260723`, 6 000 samples, `PCG64`. Generating process documented in full in `ML_DESIGN.md` §4. |
| Training script producing a simple explainable model (PA-08) with recorded metrics | ✅ done | `tools/train_risk_model.py`. Logistic regression, AUC 0.910 / accuracy 0.851 / Brier 0.107. `--check` asserts byte-identical retraining. |
| Inference endpoint in `/services/ml` | ✅ done | `POST /risk/score`, plus `riskModelAvailable` on `/health`. |
| `RiskModelProvider` adapter with rules-only fallback, `mlUsed=false` + `mlFallbackReason` (ZM-RSK-017) | ✅ done | `risk-model-client.service.ts`. Never throws; transport failure, non-200 and "no artifact" all produce one degraded shape. |
| Composite 0–100 + band (AS-05) + five components + `dataAvailabilityPct` computed separately | ✅ done | `scoring.ts`. Availability is a separate function over the same signals, sharing no code path with the score. |
| The rule of rules: `sourceAvailable=false` never reduces any component (ZM-RSK-005/006, INV-9) | ✅ done | Three independent mechanisms — type system, arithmetic, feature set. `ML_DESIGN.md` §3. |
| Positive factors, risk factors, structured reason codes, per-prediction explainability | ✅ done | `reason-codes.ts` catalogue (four families). Contributions are signed log-odds that **sum to the prediction** — tested to 1e-6. |
| `RiskModelVersion` lifecycle: create-never-edit, single active, audited activation (ZM-RSK-009..011) | ✅ done | `risk-models.service.ts` has no update method and no route reaches one. |
| `GET /transactions/{id}/risk` incl. bilingual disclaimer | ✅ done | Disclaimer EN/AR, selected by the caller's `preferred_language`. |
| `/admin/risk-models` GET/POST | ✅ done | Platform roles only; POST 409s on a duplicate label. |
| Bank-facing exclusions: no raw internals, no weights (ZM-RSK-013) | ✅ done | **Two layers** — API allow-list *and* a database column revoke that closed a real Phase 1 gap (§4.1). |
| `docs/specs/ML_DESIGN.md` | ✅ done | Includes an honest-limitations section placed **first**, and a §9 naming what would make the model real. |
| Tests: INV-9 paired fixture, version immutability, fallback flag | ✅ done | 39 unit + 5 version-lifecycle + 6 live drills. §3. |

**Not in my half:** the risk display components (`TrustScoreGauge`, `ComponentBars`, `FactorList`) are Agent B's.

---

## 2. Endpoints

Conformance gate: **31/82 contract paths served, no drift** on paths, verbs or success status codes (was 29/82).

| Endpoint | Status | Verified how |
|---|---|---|
| `GET /transactions/{id}/risk` | **built-not-deployed** | Live against hosted Postgres + the real ML service in the journey suite: 6 assertions incl. both checkpoint drills. |
| `GET /admin/risk-models` | **built-not-deployed** | Conformance gate; role-guarded to `PLATFORM_SUPER_ADMIN` / `PLATFORM_OPS_ADMIN` / `PLATFORM_AUDITOR`. |
| `POST /admin/risk-models` | **built-not-deployed** | Conformance gate; lifecycle behaviour covered by the version integration suite. |
| `POST /risk/score` (ML service, internal) | **local** | 8 API tests + live use by the journey suite. Not internet-facing by design. |

`built-not-deployed` for the same reason as Phases 1–3: there is still no hosting account. See §6.

---

## 3. Tests added

| Test / suite | Covers | Status |
|---|---|---|
| `scoring.spec.ts › INV-9` (7 tests) | **INV-9** / ZM-RSK-005/006/008 — the paired fixture the phase file names as a Definition-of-Done item | ✅ |
| `scoring.spec.ts › adverse findings DO reduce the score` | ZM-RSK-007 — "struck off" ≠ "did not answer" | ✅ |
| `scoring.spec.ts › AS-05 band thresholds` (8 cases) | AS-05 boundaries at 75/50/25 | ✅ |
| `scoring.spec.ts › ZM-RSK-015` (5 tests) | The model cannot override a blocker; an outage never manufactures one | ✅ |
| `scoring.spec.ts › the clean baseline` (3 tests) | Sanity: integers in range; "new" is not "bad" | ✅ |
| `risk-fallback.spec.ts` (16 tests) | ZM-RSK-017 fallback *and its visibility*; ZM-RSK-013 bank payload; ZM-RSK-002 bilingual disclaimer | ✅ |
| `phase4-risk-versions.integration.spec.ts` (5 tests) | **ZM-RSK-010 immutability**, single-active index, ZM-RSK-011 audited activation | ✅ live |
| `phase3-journey › Trust Score` (6 tests) | The Phase 4 integration checkpoint incl. **both drills** | ✅ live |
| `test_risk_model.py` (19 tests) | Determinism, sign recovery, explainability reconstruction, artifact integrity | ✅ |
| `test_risk_api.py` (8 tests) | `/risk/score` contract incl. the degraded shape | ✅ |
| `db:verify` +2 checks | ZM-RSK-013 column revokes | ✅ |

**Invariant status — INV-9: green.** It is the one invariant this phase owns, and it is tested at three levels: the pure paired fixture, the live drill over facts gathered from the hosted database, and by construction in the ML feature set.

**Totals:** 293 API unit tests (was 254), 96 live integration tests (was 84), 122 ML tests (was 95), `db:verify` 17/17 (was 15).

---

## 4. Deviations and carry-overs

### 4.1 A real ZM-RSK-013 gap in my own Phase 1 work — found and closed

Migration `0003` created `CREATE POLICY risk_models_read ON risk_model_versions FOR SELECT USING (true)`, with a comment reasoning that "weights and training metrics are not secret either — explainability is a requirement."

That conflated two different things. ZM-RSK-013 is explicit: banks must not receive "raw model internals, feature weights, proprietary implementation details". Explainability is discharged by per-prediction contributing factors and reason codes — which the API *does* return — not by publishing the weight vector. As written, **any authenticated bank user could read the entire scoring configuration straight from the Supabase client**, bypassing the bank-facing DTO entirely.

Closed in `0006` with a column revoke, `db:verify` checks for both columns, and a note in `ML_DESIGN.md` §8.

Worth recording the technique, because it is a trap: **a bare `REVOKE SELECT (col)` does nothing while a table-level SELECT grant exists.** Postgres accepts the statement and changes nothing. My first attempt did exactly that, and `db:verify` caught it — the table grant must be dropped and re-issued column by column. This is the same shape as D-02 and the reason 0003 re-asserts it after its blanket grant.

### 4.2 `Math.round` and the money lint rule

The repo bans `Math.round` because money must round half-up at 3 dp. Scores are dimensionless 0–100 integers, not money, so the rule does not apply — but rather than four inline disables that each look like dodging it, the exemption is concentrated in one `roundScore()` helper with one suppression and a written justification. Nothing this file produces is ever added to or compared against a JOD amount.

One related judgement worth flagging: `RiskService.numericInvoiceField` is the **only** place in the API where a JOD amount becomes a JS `number`. It is used solely as a model *feature* — logged, standardized, multiplied by a coefficient — and nothing derived from it is persisted or displayed as money. Routing it through `Money` and immediately calling `.toNumber()` would have been theatre. Flagged here so it is a recorded decision rather than something a later reader finds and assumes was an oversight.

### 4.3 Components can be `null`

A component whose every signal was unavailable scores `null`, not `0` — zero would be a judgement the platform has no basis for, and would violate INV-9 at the component level. **This is a shape Agent B's `ComponentBars` must handle** (render as "not scored", not as an empty bar at zero). In practice every component has at least one always-known signal today, so this is defensive; it is called out in §7 because it is a cross-half surface.

### 4.4 Not attempted

- **`InformationRequest` on an essential missing field** (second clause of ZM-RSK-006). The first clause — availability, not score — is done. Raising the request needs the Phase 2 information-request flow to be driven from scoring, and I did not want to wire a new writer into a table Phase 2 owns without a checkpoint. **Carried to Phase 5.**
- **Recalculation triggers.** A score is calculated on first read and then stored. There is no job that recalculates when the underlying facts change. Adequate for Phase 4 (scores are read after submit, facts do not move underneath) and it makes the immutability property easy to hold, but Phase 5 listings will need an explicit recalculation point. **Carried to Phase 5.**

### 4.5 Prior carry-overs

- **Deployment** — re-carried, unchanged, now four phases old. §6.
- **Q-03 (Arabic digit set)** — the kickoff asked me to flag it again to the product owner. Done in the daily log. Still `OPEN`; needed before Phase 6 Arabic templates. Note that Phase 4 has now shipped the **first Arabic prose the API itself emits** (the disclaimer), which makes the question slightly more pressing than it was.

---

## 5. Open questions raised

None. Every ambiguity this phase had a clear authority: ZM-RSK-004 fixed the five components, AS-05 fixed the thresholds, and the contract fixed the response shape. The one thing the contract under-specifies — whether a component may be null — I resolved conservatively and disclosed in §4.3 and §7 rather than filing a question, because it is my shape to choose and B can accommodate it in one render branch.

---

## 6. Risks observed

**Deployment is now the project's dominant risk and it has grown this phase.** Four phases have completed without a deployed API. Phase 4 adds a *second* service to deploy: the ML service must be running for the model to be used, and the fallback means a misconfigured deployment degrades **silently but visibly** — scores still return, flagged `mlUsed: false`. That is the correct behaviour, and it is also exactly the kind of thing that goes unnoticed in a demo unless someone looks at the flag.

I saw this happen during development, which is the best evidence the mechanism works: the journey suite failed with `mlUsed: false` because the ML process was still serving a build from before `/risk/score` existed. The fallback did its job — a real score came out, and the degradation was visible enough to stop the suite. A silent fallback would have shipped.

`render.yaml` still needs a hosting account I do not have.

---

## 7. Handoff notes for Agent B

Everything material is in the daily-log entry. The seven that most affect the risk components:

1. **`GET /transactions/{id}/risk` is live-shaped now.** `compositeScore` (int 0–100), `band`, `components` (five keys), `dataAvailabilityPct` (**number**, not a string), `positiveFactors[]`, `riskFactors[]`, `reasonCodes[]`, `modelVersion`, `mlUsed`, `calculatedAt`, `disclaimer`.
2. **A component may be `null`** — see §4.3. Render "not scored", never a zero bar. `dataAvailabilityPct` may be `null` only if no signal existed at all, which cannot currently happen.
3. **`dataAvailabilityPct` is a separate number and must be styled neutrally** — the brief is explicit: never a warning colour, never a downward arrow. It is not a score, it is a completeness measure, and a supplier whose registry was down has done nothing wrong.
4. **Reason codes are a catalogue**, `apps/api/src/modules/risk/reason-codes.ts`, four families by prefix: `BLOCK_` (hard blocker), `RISK_` (adverse, lowers a component), `POS_` (positive), `INFO_` (**never moves the score** — an observation about our visibility, not about the supplier). The `INFO_` family in particular should not be rendered in a risk-coloured list. Copy the codes; the strings are yours in both locales.
5. **`mlFallbackReason` is present only when `mlUsed` is false**, and is always non-empty in that case. Surface it — a degraded score a banker cannot tell is degraded is the failure mode ZM-RSK-017 exists to prevent.
6. **`INFO_SYNTHETIC_TRAINING_DATA` is on every score.** ZM-RSK-016 requires the synthetic-data limitation to be disclosed in the UI, and this is the hook for it.
7. **The disclaimer arrives already localized** from `preferred_language` — you do not need to key it. It is a single string per the contract; render it verbatim on every score display (ZM-RSK-002).

**Ownership held:** I touched only `/apps/api`, `/services/ml`, `/db`, `docs/coordination/*`, `docs/specs/ML_DESIGN.md`, and this report. I did not touch `/apps/web`, and I did not edit `03_API_CONTRACT.yaml`, `02_DATABASE_SCHEMA.sql`, or any completion report but my own. Nothing renamed — in particular the eight `checkType` strings are untouched.

---

## 8. Checkpoint countersignature

- [ ] `PHASE_4_CHECKPOINT.md` not yet written — **the checkpoint's server-side half is fully evidenced** (both drills pass live in the journey suite, §3), but the phase file's checkpoint requires the UI to show the degraded flag and the neutral availability display, which needs B's components against a deployed API. Blocked on deployment, not on either half's code.
