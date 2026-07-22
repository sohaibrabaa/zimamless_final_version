# Phase 1 Completion Report — Agent A

**Phase:** 1 — Foundation (A) ∥ Shell (B)
**Agent:** A (backend)
**Sessions spent:** 1 (planned: 4–6 days)
**Dates:** 2026-07-22 → 2026-07-22
**Phase file:** `docs/plan/phases/PHASE_1_FOUNDATION_SHELL.md`

> **Status: NOT COMPLETE.** Every deliverable is built, but the phase's
> integration checkpoint has not been met and cannot be until the API can
> reach the database. This report is filed as an honest interim record —
> the phase gate stays shut. See §4.

## 1. Delivered vs. planned

| Planned item | Status | Notes |
|---|---|---|
| Migration `0001` = frozen schema with the D-01 fix; `0002` = approved additive; both apply cleanly to fresh local **and** hosted | 🔶 partial | Written; **applied to hosted by the product owner**. Local not possible (no Docker). `0001` is generated from the frozen file so fidelity is mechanical. Also added `0000` (citext / D-15) and `0003` (RLS completion). **Not verified by me** — `db:verify` has never connected. |
| Supabase Auth JWT validation; `users` row sync on first request (PA-04) | 🔶 partial | Implemented for both HS256 and JWKS projects. **Never executed against a real token.** |
| `X-Organization-Id` context guard: 403 when missing or non-member; role checks | ✅ done | 15 unit tests green, including that malformed and non-member are indistinguishable. |
| RLS: helpers + policies for **every** tenant table + coverage checklist | ✅ done | 58 policies across all 61 tables, deny-by-default grants, 3 column revokes. Checklist in `ARCHITECTURE.md` §4.2, enforced by `db:verify`. **Never executed.** |
| Audit-log interceptor on every mutation | ✅ done | Global, opt-out only for richer in-transaction writes. **Never written a row.** |
| Error envelope per contract `Error`; correlation IDs; structured logging | ✅ done | `AsyncLocalStorage`; redaction over floor/OTP/IBAN/keys. |
| `TimeProvider` via DI; lint ban on `new Date()`/`Date.now()` in `modules/**`, `jobs/**` | ✅ done | Ban verified firing. Two-part demo guard; refuses to boot enabled in production. |
| Money: decimal library + lint ban on float arithmetic | ✅ done | 25 unit tests. `Money.from()` rejects JS numbers so the ban is not cosmetic. |
| Endpoints live: `/health`, `/auth/me` (+D-10 demo block), `/auth/context`, `/auth/language` | 🔶 built-not-deployed | Implemented and registered; **not deployed, never served a request.** |
| Dev seed: one user per persona | ✅ done | `db/seed/0100_seed_dev.sql`, pure SQL, idempotent, fixed UUIDs. |
| First RLS persona test in CI | 🔶 partial | Suite written (`rls-personas.integration.spec.ts`), CI job written. **Never executed.** |
| Serve OpenAPI at `/docs-json`; CI conformance diff | ✅ done | Gate passes: 3/82 paths, no drift. Emitter shares the document builder with the server. |
| Deploy api; draft `DEPLOY_RUNBOOK.md` | ⛔ carried over | Blocked on a reachable `DATABASE_URL`. |

## 2. Endpoints

| Endpoint | Status | Verified how |
|---|---|---|
| `GET /health` | built-not-deployed | Registered outside `/v1`; excluded from the OpenAPI doc |
| `GET /auth/me` | built-not-deployed | Compile + guard unit tests only |
| `POST /auth/context` | built-not-deployed | Compile + guard unit tests only |
| `PATCH /auth/language` | built-not-deployed | Compile + guard unit tests only |

**Conformance gate: green.** 3 documented paths served, zero not in the
contract, no verb mismatches. (`/health` is absent from the contract by
design — served outside `/v1` and excluded from the document, recorded as an
explicit allowance in the gate.)

`ENDPOINT_STATUS.md` is **not** updated to `live` for any endpoint, because
none is.

## 3. Tests added

| Test / suite | Covers | Status |
|---|---|---|
| `money.spec.ts` (25) | Money precision, HALF_UP, INV-2 boundary, JSON-as-string | ✅ green |
| `auth.guard.spec.ts` (15) | Cross-cutting rule 1, 403 indistinguishability, per-membership roles | ✅ green |
| `rls-personas.integration.spec.ts` | INV-11, D-02 floor revoke, `otp_hash`, `bank_internal_notes`, write refusal | ⚠️ **never run** |
| `db:verify` (13 checks) | RLS coverage, grants, D-01/D-02, helpers, append-only rules | ⚠️ **never run** |
| `build-0001.mjs --check` | Migration 0001 has not drifted from the frozen schema | ✅ green |
| Contract conformance | Served routes vs. contract + overlay | ✅ green |

**40 unit tests green. Zero database-dependent tests have executed.**

Invariants scheduled for Phase 1: none are fully closable this phase, since
INV-8 and INV-11 need rows that only Phase 5 creates. The Phase 1 portions
(D-02 column revoke, cross-bank policies, append-only rules) are written and
unverified. Per the phase gate's own rule — *any invariant scheduled for
this phase without a green test means the phase is not done* — this is
recorded as not done rather than as partial credit.

## 4. Deviations and carry-overs

**The blocker.** `DATABASE_URL` is unusable: the value points at the direct
host `db.<ref>.supabase.co`, which resolves to IPv6 only
(`2406:da14:311:1500:…`), and this machine has no IPv6 route — so every
connection fails `ENOTFOUND`, which reads like a wrong hostname rather than
a routing problem. The password placeholder is also unreplaced. The fix is
the **session pooler** string (`aws-1-<region>.pooler.supabase.com:5432`,
user `postgres.<ref>`), which answers on IPv4 and still permits DDL.

Consequences, stated plainly:

- The API has **never started**.
- The migrations were applied by the product owner, not by me, and I have
  **not verified what actually landed**. "The migrations ran" and "the
  schema is correct" are different claims; `db:verify` exists to settle the
  second and has not run.
- The RLS suite — the most security-critical code in this phase — is
  **unexecuted**. It is written against seeded persona ids and could fail on
  first contact.

**Deviations:**

- **Migration `0000` added** (not in the phase plan) for D-15. Additive,
  frozen file untouched. Awaiting ratification.
- **Migration `0003` added** for RLS completion. The phase file assigns the
  work; a separate migration keeps `0001`/`0002` byte-faithful to their
  sources.
- **`db/ci/000_supabase_compat.sql` added** — not a migration. Lets CI run
  the RLS suite on plain Postgres rather than skipping it.
- **Seed delivered as SQL rather than the Node script**, at the product
  owner's request. Both exist; the SQL is authoritative.
- **`/health` excluded from the OpenAPI document.** Required by the phase
  file, absent from the frozen contract. Including it would make the
  conformance gate fail on Agent A's own endpoint; excluding it keeps the
  gate meaningful. Recorded rather than assumed.
- **Build layout fixed** — `rootDir` sent output to `dist/src/`, so
  `start:prod` and the emitter both pointed at nonexistent paths; a stale
  `.tsbuildinfo` also let `tsc` "succeed" while emitting nothing.

**Carried to Phase 2:** deploy the API; run `db:verify`; run the RLS suite;
execute CI once; `DEPLOY_RUNBOOK.md`; `/services/ml` scaffold (Phase 3).

## 5. Open questions raised

| Ref | Subject | Status |
|---|---|---|
| Q-01 / D-15 | `citext` never enabled — frozen schema does not execute | OPEN, needs ratification |
| Q-02 | RLS 8/59 with zero GRANTs — 51 tables open on Supabase | OPEN (informational), closed by `0003` |

## 6. Risks observed

- **R-13 (Supabase coupling) is now the top risk.** Its stated mitigation is
  "deploy the stack in Phase 1, not Phase 9" — and that is exactly what has
  not happened. Every Supabase-specific assumption (JWT algorithm,
  `auth.users` column set, `auth.uid()` behaviour, pooler DDL) is currently
  unverified.
- **R-04 (RLS gap) was larger than assessed** — 59 tables, not ~40; no
  GRANTs at all. Closed in code, unverified in practice.
- **R-01 understated.** Two execution-blocking defects in the frozen schema,
  not one.
- **New: verification debt.** A phase built entirely without a database
  accumulates work that all comes due at once. The longer it runs, the more
  likely several things fail together and interact.

## 7. Handoff notes for the other agent

- Seed personas, the multi-org account, the maker/approver split, the
  blocked buyers, the uniform 403, `/health`'s absence from the client, and
  the `demo` block on `/auth/me` — all detailed in today's `DAILY_LOG.md`
  entry.
- **Do not flip anything to `live` in `ENDPOINT_STATUS.md` yet.** Nothing is
  deployed. I will announce in the daily log when it is.
- Nothing was renamed; no frozen file, and nothing under `/apps/web`, was
  touched.

## 8. Checkpoint countersignature

- [ ] **Not run.** The Phase 1 checkpoint requires the deployed stack:
  seeded login → live `/auth/me` memberships → context switch → language
  persistence → audit rows → RLS smoke green. None of it is executable
  without a reachable database. No `PHASE_1_CHECKPOINT.md` is filed, and no
  `phase-1-checkpoint` tag exists, because claiming either would be false.
