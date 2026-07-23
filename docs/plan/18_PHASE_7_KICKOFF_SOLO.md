# Phase 7 Kickoff — Funding, Cross-Party OTP, Settlement, Ledger

> **Single agent.** Phases 0–6 were built by two agents (A: backend, B: frontend)
> coordinating through a frozen contract. From Phase 7 that split is retired:
> **you own the whole stack.** There is no counterpart to hand off to, no
> `NOTE FOR B`, and no waiting on anyone.
>
> Paste into a fresh session with repository access.
> Attach: `01_ZIMMAMLESS_V3_REQUIREMENTS.md`, `02_DATABASE_SCHEMA.sql`,
> `03_API_CONTRACT.yaml`, `docs/plan/phases/PHASE_7_FUNDING_SETTLEMENT_LEDGER.md`.

---

You are building **Zimmamless V3**, a Jordanian receivables marketplace, for a
competition submission. Phase 7 is the phase that makes the product's fifth
defining behaviour real: **funding requires both parties.**

## 1. Where the build actually is

Everything below is verified, on `main`, and passing:

| Area | State |
|---|---|
| Phases 0–6 | Complete: auth/RLS, onboarding+government, buyers/documents/invoices, risk+ML, marketplace/offers, selection/contracts/signatures |
| Backend | 393/393 unit, Phase 6 integration 36/36 against the hosted DB |
| Frontend | 187/187 vitest, typecheck+lint clean, i18n parity 678/678 EN/AR |
| Database | migrations 0000–0009 applied, `db:verify` 20/20, RLS on 63/63 tables |
| Contract | conformance passes, **no drift**; 50 of 82 paths served |
| Repo | single branch `main`, synced with origin |

**The 32 unserved contract paths are Phases 7–9.** Phase 7 is the first and
largest slice of them.

Two known, deliberate gaps you inherit:

1. **The demo dead-ends at `CONTRACTED`.** Nothing exists past a fully-signed
   contract. That is what this phase fixes.
2. **The frontend runs entirely on MSW mocks — zero endpoints promoted to
   live.** See §6; with one agent this is now a defect you can and should stop
   reproducing.

One piece of outstanding housekeeping, unrelated to this phase but yours now:
the hosted database still carries duplicate bank and platform organizations
from an old seed bug (the seed itself is fixed). The merge tool is written and
its dry run is clean — run `node db/tools/dedupe-organizations.mjs` to see the
plan and `--apply` to execute. It affects no test and no demo path; do it when
convenient, and don't rediscover the duplicates and assume they are new.

## 2. Non-negotiables

These carried through six phases. They do not relax because the team shrank.

1. **Frozen means frozen.** Never modify `docs/02_DATABASE_SCHEMA.sql` or
   `docs/03_API_CONTRACT.yaml`. Additive migrations that do not alter existing
   columns, constraints, or response shapes are permitted. A contract or schema
   problem with no ruling in `DECISIONS.md` → stop and record it in
   `OPEN_QUESTIONS.md`; never work around it silently.
2. **Money** is `numeric(18,3)` in the database, the `Money` class (decimal.js)
   in code, and a 3-dp string on the wire. Float arithmetic on money is a
   defect, and lint bans it. Never a JSON number.
3. **`minimumAcceptableAmount` never reaches a bank** — not in a response, an
   error, a log, a notification, or a document. Build bank-facing payloads from
   explicit allow-lists, never by spreading an entity.
4. **All time** in `src/modules/**` and `src/jobs/**` goes through the injected
   `TimeProvider`. `new Date()` / `Date.now()` are lint-banned there.
5. **RLS is a real layer.** The RLS suite connects as each persona with a real
   JWT straight to Postgres, bypassing NestJS. A policy that only passes
   because the API already filtered is a defect.
6. **Every mutation writes an audit entry** — actor user, actor org,
   before/after, correlation id.
7. **Government unavailability never reduces a risk score component** — only
   `dataAvailabilityPct`.
8. **The Supabase service-role key never leaves the server.**
9. **Idempotency keys on every settlement operation**; the key is the
   settlement id.
10. **Each invariant ships with a named CI test.**

The `Idempotency-Key` header is now enforced by `IdempotencyInterceptor`
(`src/common/idempotency/`). Every money-moving endpoint you add in this phase
**must** carry `@Idempotent()` — the contract marks the header `required: true`
on `funding/mark-sent`, `funding/confirm`, `settlements/{id}/retry`,
`transactions/{id}/payments`, and `recourse/{id}/repay`.

## 3. The ledger ruling — already decided, do not relitigate

This was the one open design question. It is settled, and the frozen schema
settles it for you.

Under `ZM-CON-013` funding moves **bank → supplier directly**; the platform
never takes custody of the gross. A ledger that debited a "platform cash"
account for it would be balanced, clean, and entirely fictional.
`ZM-FEE-018` requires the opposite: records of money the platform did not hold
"MUST NOT imply that Zimmamless ever held those funds. The ledger must make
this distinction structurally obvious."

Read the frozen `ledger_account_kind` enum:

```
BANK_FUNDING · SUPPLIER_PAYABLE · PLATFORM_COMMISSION_REVENUE ·
PLATFORM_LISTING_FEE_REVENUE · SUPPLIER_RECEIVABLE ·
SETTLEMENT_CLEARING · RECOURSE_CLEARING
```

**There is no cash account.** The schema gives clearing accounts instead. So:

- Money the platform **earns** (commission, listing fee) → a `PLATFORM_*_REVENUE`
  account. Real platform books.
- Money that merely **passes between other parties** (gross funding, supplier
  payout) → pivots through `SETTLEMENT_CLEARING`, which **must net to zero**
  once a settlement completes.
- A non-zero clearing balance on a completed settlement is a reconciliation
  defect — it means the books claim money stopped somewhere it did not.
- Nothing may present a clearing balance as platform funds.

**Scaffolding already exists** on `main` (commit `e81b923`) — it typechecks but
is unwired and untested, so treat it as a starting point, not gospel:
`src/modules/ledger/ledger.accounts.ts`, `ledger.service.ts`,
`settlement-postings.ts`. They encode the three journals: funding-received →
distribution → payout-completed. Review them critically, finish them, and test
them; discard them if you have a better shape.

## 4. Scope — backend

- **`POST /transactions/{id}/funding/mark-sent`** (BANK_OPERATIONS, idempotent):
  records evidence + provider reference, state → `FUNDING_CONFIRMATION_PENDING`.
  **Never sets `FUNDED`.**
- **`POST /transactions/{id}/funding/otp`** — bank generates. Plaintext returned
  **exactly once** in that response; **hash-only** storage. 15-minute validity,
  5 attempts, 3 resends, all from `platform_settings`. Bound to the transaction
  and the issuing user. 429 on the resend cap. Every event in
  `funding_otp_events` with actor and IP (`ZM-FND-004..009`).
- **`POST /transactions/{id}/funding/confirm`** — supplier verifies. Generic
  failure message plus `attemptsRemaining` only: the response must not reveal
  wrong-vs-expired-vs-used. Rate-limited. `FAILED_MAX_ATTEMPTS` at the cap.
- **The `FUNDED` gate (INV-10)** — requires OTP `VERIFIED` **and** settlement
  evidence. Neither alone suffices (`ZM-FND-003`). Find and close every path
  that could reach `FUNDED` with only one.
- **Settlement** — dummy `SettlementProvider` adapter behind a symbol, with
  split support: gross in → commission + unpaid listing fee withheld → net
  payout (`ZM-FND-013/014`). `settlements` row built from the accepted-offer
  snapshot with **stable idempotency key = settlement id** (INV-13).
  `settlement_attempts` log. `PAYOUT_FAILED` → auto-retry with backoff (max 3,
  AS-03) → `MANUAL_REVIEW`. **`POST /settlements/{id}/retry` never double-pays.**
- **Commission** — `CommissionCalculation` prepared at acceptance
  (`CALCULATED`, tier snapshot per `ZM-FEE-012`); **`FINALIZED` only on
  `PAYOUT_COMPLETED`** (INV-5, `ZM-FEE-013..015`). Reversals are compensating
  records only, never edits.

  > **Heads-up: this one reaches backwards.** "Prepared at acceptance" means
  > `AcceptanceService` — Phase 6 code that is already built, already atomic,
  > and covered by 36 passing integration tests. You are retrofitting a money
  > path that currently works. Write the commission record inside the existing
  > acceptance transaction (so it commits or vanishes with the snapshot), and
  > re-run the full Phase 6 integration suite afterwards, not just your new
  > tests. Do not loosen an existing Phase 6 assertion to accommodate it.
- **Listing fee** — an unpaid obligation becomes `DEDUCTED` in the split.
- **Ledger** — a balanced journal for every leg (funding received, commission,
  listing fee, supplier payout, reversal). Journals balance (INV-6), append-only
  is enforced by the frozen RULEs, and bank-reported buyer collections never
  enter platform-fund accounts (`ZM-FEE-018`).
- **`GET /transactions/{id}/settlement`**.
- **Stalled-confirmation job** — reminders while pending; escalate to an
  Operations Admin task after 24h (`ZM-FND-011/012`, AS-04). Must be idempotent
  and safe if two instances run.

## 5. Scope — frontend

- Bank funding screen: prerequisites checklist (contract signed, conditions
  done) → mark-sent with evidence attach → generate OTP with a
  **display-once, "copy this now"** affordance, expiry countdown, resends
  remaining.
- Supplier OTP entry: attempts remaining, **generic failure messaging only**
  (no hint of wrong vs expired vs used), expired/regenerate states.
- `FUNDING_CONFIRMATION_PENDING` views for both sides; escalation banner past
  the threshold.
- Settlement timeline: gross → deductions (commission, listing fee) → net
  payout, with provider reference and `PAYOUT_FAILED` / `RETRYING` /
  `MANUAL_REVIEW` states. The platform view gets the retry action.
- `FUNDED` confirmation state with `fundedAt`.
- Commission status on the platform view: `CALCULATED` vs `FINALIZED`.

**The OTP plaintext exists in exactly two places: the one API response and one
component's memory.** Never persist it — not to localStorage, not to a store,
not to a log, not to a URL.

Money renders as 3-dp JOD strings, from the server's value. Never reformat with
`toFixed`, never parse into a `number`. EN and AR must stay at full key parity,
English default, no locale auto-detection (`ZM-I18N-003`).

## 6. Build these screens against the LIVE API

This is the biggest change from the two-agent era, and the most important
instruction in this document.

The existing frontend talks to MSW mocks for all ~90 endpoints, because Agent B
had to build before Agent A's endpoints existed. That is no longer true: you
write both sides. Reproducing the pattern would mean writing every Phase 7 rule
twice — once properly in the service, once loosely in a mock — and demoing the
loose one.

So: **build Phase 7's screens against the real API from the start.** Add the
new endpoints to the live-promotion map rather than the mock handlers. Keep
mocks only where you genuinely need an unreachable state (a forced payout
failure, an expired OTP) and label them as fixtures, not as the default path.

Then, as a distinct task, **promote the already-built Phase 5–6 endpoints
(offer listing, acceptance, contract generation and signing) to live** and fix
whatever that surfaces. Note that `offers/{id}/accept` now requires an
`Idempotency-Key` header — send a fresh uuid per logical acceptance.

## 7. Integration checkpoint

Against the hosted database, end to end:

**Happy path:** `mark-sent` → OTP generated and shown once → supplier enters it
→ with settlement evidence present the state flips to `FUNDED` → the settlement
panel shows the three legs.

**Failure drill:** force the adapter to fail the payout → `PAYOUT_FAILED` →
auto-retries logged → manual retry succeeds → **the ledger shows exactly one
payout leg and every journal balances** → commission is verifiably `CALCULATED`
before completion and `FINALIZED` after.

**OTP drill:** 5 wrong attempts → `FAILED_MAX_ATTEMPTS`, all events audited;
regenerate works within the resend cap; the 4th resend is refused with 429.

**Ledger drill:** after a completed settlement, `SETTLEMENT_CLEARING` for that
transaction nets to **exactly zero**.

## 8. Definition of done

- Checkpoint above met against the hosted DB.
- **INV-5, INV-6, INV-10, INV-13 each have a named, passing CI test.**
- INV-13 proven with a *concurrent* retry drill, not a sequential one — two
  simultaneous retries must produce one payout.
- OTP event trail complete; escalation task creation tested.
- `db:verify` passes; contract conformance passes with no drift; typecheck,
  lint, unit and integration suites green on both workspaces.
- Phase 7 endpoints promoted to live in the frontend and exercised by the UI.
- Completion report at `docs/completion/PHASE_7.md`, and a `DAILY_LOG.md` entry.
- **All work committed and pushed to `main`**, with `main` and `origin/main` in
  sync and the working tree clean. See §9.

## 9. Git workflow — read this before your first commit

**Work directly on `main`. Do not create branches.**

The repository was deliberately consolidated to a single branch: the phase
branches (`a/phase*`, `b/phase*`, `integration/consolidate`) existed only to
keep two agents out of each other's way, and every one of them has been merged
and deleted, locally and on the remote. With one agent there is nothing to
isolate. `main` is the only branch, and it should stay that way.

- **Commit as you complete each increment**, not once at the end of the phase.
  A phase-sized commit is unreviewable and unbisectable.
- **Push after each commit** so `main` and `origin/main` never drift.
- Commit messages explain *why*, not just what. If you changed a test, say why
  the old one was wrong.
- Never commit with failing tests. If you must checkpoint mid-repair, say so
  explicitly in the message.
- Do not commit secrets, `.env`, or generated artefacts.

## 10. Running things

There is no `CLAUDE.md` in this repo, so nothing below is discoverable without
reading it here. Config comes from `.env` at the repo root (`DATABASE_URL` is
the Supabase **session pooler** string, not the direct host — the direct host
is IPv6-only and will not resolve).

**Database** — from the repo root:

```
npm run db:migrate     # apply pending migrations (currently 0000-0009)
npm run db:verify      # 20 structural checks; MUST pass before you call anything done
npm run db:seed        # personas, orgs, buyers. Idempotent. Refuses NODE_ENV=production
```

**Backend** — from `apps/api` (the jest configs are relative; running these
from the repo root fails with a confusing "can't find config" error):

```
npm run typecheck
npm run lint
npm run test                 # unit — fast, no database
npm run test:integration     # hosted DB, --runInBand, ~8 minutes
npm run test:rls             # RLS suite: connects as each persona, bypassing Nest
npm run start:dev
```

**Frontend** — from `apps/web`:

```
npm run typecheck
npm run lint
npm run test          # vitest
npm run check:i18n    # EN/AR key parity — must stay at 100%
npm run dev           # port 3001
```

**ML service** (needed by the risk paths; not by Phase 7 itself, but the
Phase 3 journey suite fails hard if it is down):

```
services/ml/.venv/Scripts/python -m uvicorn app.main:app --app-dir services/ml --port 8000
```

**Contract conformance** — two steps, and the second fails unhelpfully without
the first:

```
npm run openapi:emit -w @zimmamless/api
node scripts/contract-conformance.mjs apps/api/openapi.generated.json
```

## 11. Testing time-dependent behaviour — read before writing an expiry test

Phase 7 is full of clocks: a **15-minute** OTP validity and a **24-hour**
stalled-confirmation escalation. You cannot test either by waiting, and you
must not test them by back-dating rows with raw SQL — that proves the query
works, not that the domain logic reads the clock correctly.

There are two instruments, and picking the wrong one is the trap:

- **`FixedTimeProvider`** (`common/time/time.provider.ts`) — a frozen clock for
  unit tests, with `setTo(date)` and `advanceDays(n)`. **This is the only tool
  with minute resolution.** Use it for everything about OTP expiry: valid at 14
  minutes, expired at 16, and the boundary.
- **The demo time machine** — a server-side offset applied inside
  `SystemTimeProvider.now()`, changed via `/demo/time-travel`. It is measured
  in **whole days** (`offsetDays`), so it can express "tomorrow" but not
  "twenty minutes from now". Use it for the 24-hour escalation, and for
  demonstrating the flow live.

So: **OTP expiry belongs in unit tests against `FixedTimeProvider`; the 24h
escalation can use either.** Do not try to drive a 15-minute expiry through the
time machine — advancing a day will expire the OTP, but you will have proved
nothing about the 15-minute boundary.

The time machine is guarded twice server-side and both must be true: the
`DEMO_TIME_MACHINE_ENABLED` env var **and** the `demo_time_machine_enabled`
platform setting. Hiding the control in the UI is explicitly not sufficient
(ZM-DEMO-003/004). In production the offset is never read. Never add a third
way to move the clock.

## 12. How to work

- Build in verifiable increments; run the suites as you go rather than at the
  end. The integration suite runs ~8 minutes against the hosted pooler — run it
  in the background, and do not mistake a transient pooler timeout for a
  regression (it has happened; re-run before diagnosing).
- Money-critical code gets tests before it gets endpoints.
- When something is genuinely ambiguous in the frozen pack, record it in
  `OPEN_QUESTIONS.md` with your chosen assumption and proceed — do not stall,
  and do not silently invent contract surface.
- Do not weaken a test to make it pass. If a test is wrong, say why in the
  commit.

Start with the ledger: everything in this phase posts to it, and it is the one
piece that is expensive to change once settlement and commission are written on
top of it.
