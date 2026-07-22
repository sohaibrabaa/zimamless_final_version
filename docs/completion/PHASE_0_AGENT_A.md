# Phase 0 Completion Report — Agent A

**Phase:** 0 — Rulings, Scaffold, and Ground Rules
**Agent:** A (backend)
**Sessions spent:** 1 (planned: 0.5–1 day, shared with the product owner)
**Dates:** 2026-07-22 → 2026-07-22
**Phase file:** `docs/plan/phases/PHASE_0_RULINGS_SCAFFOLD.md`

## 1. Delivered vs. planned

| Planned item | Status | Notes |
|---|---|---|
| Monorepo scaffold: `/apps/api`, `/services/ml`, `/db/migrations`, `/db/seed`, `/apps/web` placeholder | 🔶 partial | api, db, and root config done. `/services/ml` not scaffolded — first needed in Phase 3, and Python is not installed on this machine (see §4). `/apps/web` is Agent B's, created in their worktree. |
| CI: lint + typecheck + unit tests per workspace on every PR; protected `main` | 🔶 partial | Workflow written with 5 jobs (`.github/workflows/ci.yml`). **Never executed** — no push has happened. Branch protection is a repo setting the product owner must apply. |
| Supabase project created (hosted) + CLI local stack | 🔶 partial | Hosted project exists (`mryiqprvofulsencpsrx`) and the product owner applied all four migrations. Local CLI stack not usable — no Docker on this machine; CI substitutes plain Postgres + a compatibility shim instead. |
| `.env` conventions + `docs/specs/ENVIRONMENTS.md` started | ✅ done | `.env.example`, a filled `.env` skeleton, and a full variable reference. |
| Draft `docs/specs/GOV_DUMMY_DATA.md` identity list | ✅ done | 3 suppliers, 6 buyers, 3 banks, 5 failure-injection keys, 15 users with roles. |

**Rulings status** (product owner's half of this phase): D-01, D-02,
D-03..D-12, D-13/PA-06, and PA-01..PA-09 are all recorded in `DECISIONS.md`.
Neither agent hit an unresolved blocking defect on day one — the phase's
definition of done. One *new* defect was found that Part 7 missed (D-15,
§5).

## 2. Endpoints / screens

None — Phase 0 is scaffold only.

## 3. Tests added

| Test / suite | Covers | Status in CI |
|---|---|---|
| `db/tools/build-0001.mjs --check` | Migration 0001 has not drifted from the frozen schema | ✅ passes locally; CI job written, unrun |
| 0002-vs-amendment diff | Migration 0002 has not drifted from the approved amendment | ✅ passes locally; CI job written, unrun |

## 4. Deviations and carry-overs

- **`/services/ml` not scaffolded.** Python is not installed here
  (`python --version` fails). Not needed until Phase 3. **Carried to Phase 3**,
  where it must be resolved before OCR work starts.
- **No local Supabase stack.** Docker is unavailable, so `supabase start`
  cannot run. Mitigated: CI uses plain Postgres 15 plus
  `db/ci/000_supabase_compat.sql`, which supplies the roles, `auth` schema,
  and `auth.uid()`. This is arguably better for CI — no shared state, no
  network — but it means the *hosted* project is the only place Supabase's
  real Auth behaviour is exercised. **Risk noted in §6.**
- **CI has never run.** Written against the repo's actual layout and
  commands verified locally one by one, but the workflow itself is unproven
  until a push. **Carried to Phase 1 close.**
- **PA-07's "scripted local fallback"** (docker compose) is not startable
  here for the same reason. Carried to Phase 9, where the demo fallback
  matters.

## 5. Open questions raised

| Ref | Subject | Status |
|---|---|---|
| Q-01 / **D-15** | `citext` is used by three frozen columns but never enabled, so the frozen schema does not execute. Same class as D-01; missed by Part 7. Worked around additively in migration `0000` without touching the frozen file. | **OPEN** — needs ratification, not blocking |
| Q-02 | RLS covers 8 of 59 tables with zero GRANTs; on Supabase this leaves 51 tables read/write to any authenticated user. Informational — completing the set is an assigned Phase 1 task. Closed by migration `0003`. | OPEN (informational) |

D-15 deserves emphasis: **the frozen schema had two defects preventing
execution, not one.** Part 7 called D-01 "not a judgement call — the SQL
does not execute"; the same sentence applies to citext.

## 6. Risks observed

- **R-01 (frozen-contract defects) is worse than assessed.** Part 7 found
  one execution-blocking defect; there were two. The Part 7 review was
  evidently a read rather than an execution. Recommendation: treat any
  future frozen-file change as unverified until applied to a real database.
- **New risk — no local Supabase parity.** Migrations and RLS are verified
  against plain Postgres in CI and against the hosted project by hand.
  Supabase-specific behaviour (GoTrue's exact `auth.users` columns, storage
  signed URLs) is only exercised on the hosted project. This is Master Plan
  R-13 ("Supabase coupling surprises") with a higher probability than
  assessed, since the mitigation named there — deploy in Phase 1 — is now
  the *only* verification path.
- **R-04 (RLS policy gap) was real and larger than described.** The Master
  Plan estimated "~40 tenant tables" with 8 covered; the actual figure is 59
  tables, 8 covered, and no GRANTs at all.

## 7. Handoff notes for the other agent

- Identity list is frozen at `docs/specs/GOV_DUMMY_DATA.md`. Mirror the
  exact establishment numbers and names in MSW fixtures — that is what makes
  a mock→live swap visually diffable rather than a guess.
- Root config (`package.json` workspaces, tsconfig, CI) is mine by
  ownership. Request changes via the daily log.
- Nothing was renamed. No frozen file was touched.

## 8. Checkpoint countersignature

- [x] Phase 0 has no joint checkpoint. Its definition of done — "both
  kickoff prompts can be pasted and neither agent's first day hits an
  unresolved blocking defect" — held for Agent A: D-15 was found on day one
  but was additively workable without a ruling and without touching a frozen
  file, so no thread was blocked.
