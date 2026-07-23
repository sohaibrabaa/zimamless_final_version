# Phase 7 — Funding, Settlement and the Ledger

Defining behaviour #5: **funding requires both parties**. A bank saying it sent
the money is one fact; a supplier saying they received it is another; and the
platform treats the transaction as funded only when it holds both.

Everything in this phase follows from that, including the parts that look like
plumbing. The ledger exists so the money the platform touches is accounted for
rather than asserted. The settlement idempotency key exists so a retry after a
timeout cannot pay a supplier twice. The escalation job exists because a
transaction waiting on a human is the one state that can stall silently.

---

## What was built

| Increment | What it is |
|---|---|
| 7.1 | Double-entry ledger — `post()` refuses an unbalanced journal before writing |
| 7.2 | `mark-sent`: settlement from the immutable snapshot, funding-received journal, → `FUNDING_CONFIRMATION_PENDING` |
| 7.3/7.4 | OTP generation and cross-party confirmation; the `FUNDED` gate |
| 7.5 | Payout execution behind a provider symbol, retry, `MANUAL_REVIEW` |
| 7.6 | Commission `CALCULATED` at acceptance, `FINALIZED` on payout |
| 7.7 | Stalled-confirmation reminders and escalation; the scheduler that runs every sweep |
| 7.8 | Funding, OTP and settlement screens in both portals |
| 7.9 | Integration checkpoint against the hosted database |

## Named invariant tests

| Invariant | Where it is proved |
|---|---|
| **INV-5** — commission finalized only on `PAYOUT_COMPLETED` | `phase7-funding.integration.spec.ts` — both halves, and `finalized_at IS NULL` before |
| **INV-6** — every journal balances | Summed per `journal_id` in SQL; clearing accounts net to exactly `0` |
| **INV-7** — the ledger is append-only | An `UPDATE` on a posted entry changes nothing |
| **INV-10** — `FUNDED` needs both parties | The transaction's state read from the database after the bank has done everything it can |
| **INV-13** — a settlement never pays twice | 5 rounds of two simultaneous retries; attempt count unmoved |
| **INV-8** — the supplier's floor never reaches a bank | Absent by name *and* by value from every funding response |
| **AS-04** — escalation goes to Operations Admin | Every recipient asserted to hold `PLATFORM_OPS_ADMIN` |

**25/25** integration tests pass against the live database. **450** API unit
tests, **217** frontend tests, lint and typecheck clean on both workspaces,
contract conformance reports no drift.

---

## Four decisions worth recording

### The ledger has no cash account, and that is the design

The frozen `ledger_account_kind` enum contains clearing accounts and two
platform revenue accounts — and no cash account at all. That is not an
omission. It structurally forces the model `ZM-FEE-018` requires: the platform
is an **agent**, not a principal. Money passes through clearing and out; the
platform recognises only its commission and listing fee as its own. A cash
account would have permitted a design where the platform holds supplier funds
on its own balance sheet, which is a different regulated business.

The test that matters is that clearing nets to exactly zero once a payout
completes. A non-zero clearing balance means the platform is holding money it
does not know about.

### The ledger posts what moves, not the headline

The scaffold assumed `gross = commission + listingFee + net`. The real numbers
do not work that way. On the fixture: gross 9,000, less the bank's discount
(300) and fees (150), less commission (135) and listing fee (25), leaves the
supplier 8,390. The bank retains 450 — it never reaches the platform at all.

Posting the headline 9,000 would have stranded 450 in clearing **forever**,
and the clearing-nets-to-zero test would have failed on every real
transaction. The distributable amount is 8,550, and `distributableFrom()`
computes it explicitly rather than letting the difference hide in a subtraction.

This was caught by writing the test with the fixture's real numbers instead of
numbers chosen to make the assertion pass.

### `mark-sent` is idempotent by observation, not by error

A bank that clicks twice has not made a mistake worth a 409. The second call
returns the existing settlement unchanged, and the integration test asserts
what actually matters: one settlement row, and **no second ledger journal**.
The `409` remains for the genuinely wrong case — a transaction that was never
contracted.

### Tier drift at acceptance is charged at the committed figure

`CommissionService.record()` had existed since Phase 5 and had never been
called; Phase 6 accepted offers without recording the charge they implied. The
retrofit wires it inside the acceptance transaction, so the charge and the
snapshot that justifies it commit together.

Where the live tier disagrees with the offer's committed commission, the
**committed** figure wins. The supplier accepted a net computed from it, and
charging them the current tier would charge them something other than the deal
they agreed to — precisely what the immutable snapshot exists to prevent. The
divergence is audited as `COMMISSION_TIER_DRIFT` rather than silently
reconciled, because it means the tier table moved under a live offer.

---

## Three bugs the live database found that unit tests could not

**`inconsistent types deduced for parameter $1`.** `createSettlement` uses one
parameter for both `id` (uuid) and `idempotency_key` (text) — which is INV-13's
entire mechanism, the key *being* the id. Postgres cannot deduce one type for a
parameter used as two and refused the statement outright. Every unit test
passed because they ran against a fake database. Fixed with explicit
`::uuid` / `::text` casts, and the reason is written next to them.

**`PLATFORM_OPERATIONS_ADMIN` does not exist.** The frozen enum's name is
`PLATFORM_OPS_ADMIN`. The escalation query and the retry authorization both
named a role no user can hold, so AS-04's escalation would have found nobody
and logged an error about it. Found by cross-checking every role string in the
funding code against the enum after a seed persona failed to match.

**`attemptsRemaining` was in the wrong place.** The contract declares the
funding-confirm 401 with an *inline* schema (`{code, attemptsRemaining}`), not
a `$ref` to the Error envelope — so the field belongs beside `code`, not under
`details`. The filter now promotes one named field to the top level while
leaving it in `details`, so both readings work and the envelope stays uniform.

---

## Deliberately not done

**Live endpoint promotion.** The funding screens are built and tested against
mocks that reproduce the API's invariants — mark-sent cannot fund, every OTP
failure has one shape, a completed payout does not re-pay. Flipping the
endpoint-status map to `live` requires a same-day smoke test **on the consuming
screen**, and a scripted HTTP check is not that. The endpoints are proved live
by the integration suite; the screens have not been driven against them by
hand. That is a Phase 9 rehearsal gate, and it is recorded as outstanding
rather than claimed.

**ZM-FND-012's "administrative task."** Neither the frozen schema nor the
contract has anywhere to put one (the overlay's `/cases` covers FRAUD, DISPUTE,
WITHDRAWAL and RECOURSE — a stalled confirmation is none of them). The
escalation is delivered through notifications plus a full-context audit entry,
which an Operations Admin can actually see, and the gap is filed as **Q-16**
rather than worked around silently.

## Fixed on the way past

`ListingDeadlinesService` was written in Phase 5, made carefully idempotent,
and **never invoked by anything**. Listing deadlines had never actually passed
outside a test. `SchedulerService` now ticks both it and the funding sweep on
an interval — an interval rather than a cron expression, because the sweeps
read the injected `TimeProvider` and a demo that jumps the clock forward must
process the deadlines in between on the next tick, not a day later.
