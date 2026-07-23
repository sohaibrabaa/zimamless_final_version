# Phase 8 — Post-Funding, Cases and Notifications (single agent)

You are the sole engineer on **Zimmamless V3**, a Jordanian receivables
marketplace built for a competition. You own the whole stack: `apps/api`
(NestJS) and `apps/web` (Next.js). There is no second agent and no A/B split —
that arrangement is retired.

Phases 1–7 are complete, verified and on `main`. Read
`docs/completion/PHASE_7.md` before you write anything: it records four design
decisions and three bugs that will shape how you work here.

---

## 1. What this phase is about

Money has moved. Phase 8 is everything that happens *after* — and it is the
part of the system where the platform's honesty is most tested, because it is
where things go wrong.

The defining behaviour is **ZM-PMT-008..011: a transaction whose due date
passes does NOT become `OVERDUE`.** It becomes `OVERDUE_UNCONFIRMED`, and it
stays there until a bank confirms. The distinction is the whole point: the
platform does not know whether a buyer paid — only the bank does. Calling a
supplier's invoice "overdue" on the strength of a calendar date is an
accusation the platform has no evidence for, and it can damage a real
business's standing. The state name, the UI wording, and every notification
must reflect that the platform is *awaiting confirmation*, not asserting
default.

If you find yourself writing "defaulted", "late", or "overdue" on a screen
showing `OVERDUE_UNCONFIRMED`, stop — that is the bug this phase exists to
prevent.

---

## 2. Standing constraints — unchanged, still absolute

1. **Frozen means frozen.** Never modify `docs/02_DATABASE_SCHEMA.sql` or
   `docs/03_API_CONTRACT.yaml`. Additive migrations that don't alter existing
   columns, constraints or response shapes are permitted. A contract or schema
   problem with no `DECISIONS.md` ruling goes in `OPEN_QUESTIONS.md` — never
   work around it silently.
2. **Money** is `numeric(18,3)` in the DB, the `Money` class (decimal.js) in
   code, a 3-dp **string** on the wire. Float arithmetic on money is a defect.
   Never a JSON number.
3. **`minimumAcceptableAmount` never reaches a bank** — not in a response,
   error, log, notification, or document. Build bank-facing payloads from
   explicit allow-lists, never by spreading an entity.
4. **All time** in `src/modules/**` and `src/jobs/**` goes through the injected
   `TimeProvider`. `new Date()` / `Date.now()` are lint-banned there.
5. **RLS is a real layer.** The RLS suite connects as each persona with a real
   JWT straight to Postgres, bypassing NestJS.
6. **Every mutation writes an audit entry** — actor user, actor org,
   before/after, correlation id.
7. **Government unavailability never reduces a risk score component** — only
   `dataAvailabilityPct`.
8. **The Supabase service-role key never leaves the server.**
9. **Idempotency keys on every settlement operation**; the key is the
   settlement id.
10. **Each invariant ships with a named CI test.**

Plus, for this phase specifically:

11. **Post-funding balances are derived** (D-13 / PA-06). Outstanding =
    snapshot outstanding − Σ `buyer_payments`. `invoices.paid_amount` and
    `invoices.outstanding_amount` **freeze at listing and are never mutated
    after funding**. If you find yourself writing
    `UPDATE invoices SET paid_amount`, you have broken a ratified ruling.
12. **`bankInternalNotes` and bank-side evidence never serialize to a
    supplier.** This is a named definition-of-done test, not a code-review
    nicety.
13. **No hard deletes** (INV-7). Cases, payments and notifications are
    cancelled or superseded, never removed.

**Work directly on `main`. Do not create branches.** Commit after each
increment with a message explaining *why*, not what. Push after each commit.

---

## 3. What to build

### 8.1 — Maturity job and the overdue discipline

Reminders at 30/14/7 days before due and on the due date, driven by
`maturity_reminder_days`. On the due date passing with no confirmed payment:
`FUNDED` → `OVERDUE_UNCONFIRMED`. **Never straight to `OVERDUE`.**

Add it to the existing `SchedulerService` (Phase 7 built it; both sweeps
already run on a 60s tick reading the injected `TimeProvider`, which is what
makes the demo time machine work). The sweep must be idempotent and its
reminders keyed like the existing ones (`template_key` + `transaction_id`).

### 8.2 — Bank confirm-status and buyer payments

`POST /transactions/{id}/confirm-status` — only the funding bank may confirm;
this is what moves `OVERDUE_UNCONFIRMED` → `OVERDUE`.

`GET/POST /transactions/{id}/payments` — record a buyer payment with date and
bank reference. Reconciliation and the **derived** balance per D-13. Partial →
`PARTIALLY_PAID`; full → `PAID` → `POST /transactions/{id}/close`.

### 8.3 — Recourse

`POST /transactions/{id}/recourse` — **bank-only initiation; a platform admin
gets 403** even though they outrank the bank. `POST /recourse/{id}/repay` and
`POST /recourse/{id}/status` through the states
`SUPPLIER_NOTIFIED → PAYMENT_PENDING → SETTLED | DISPUTED | LEGAL_ESCALATION`.

Repayments go through the **settlement architecture you built in Phase 7** —
reuse `SettlementProvider`, don't invent a second payment path.

**No automatic commission refund**: the platform earned its fee on a
transaction that funded, and reversing it silently on recourse would be a
revenue decision nobody made. If a reversal is wanted it is a compensating
ledger entry, explicitly.

### 8.4 — Disputes

`POST /transactions/{id}/disputes`, `GET /disputes/{id}`,
`POST /disputes/{id}/resolve`.

**ZM-REC-013: an open dispute pauses automation.** The maturity job must skip
a disputed transaction, and that must be a test assertion, not a comment.

### 8.5 — Withdrawal and fraud cases

Withdrawal: configurable penalty **recorded, not deducted**, plus admin
decision and the manual relisting flow (`relisting_requests` from migration
0002, `GET /admin/relisting-requests` in the overlay).

Fraud: `POST /transactions/{id}/fraud-review` freezes the transaction, stops
funding, notifies compliance, and moves through the decision states.

### 8.6 — Notification engine

Versioned bilingual templates (EN + AR) from `notification_templates`, the full
`ZM-NOT-009` catalogue, EMAIL and WHATSAPP **dummy adapters behind a symbol**
(same pattern as `SIGNATURE_PROVIDER` and `SETTLEMENT_PROVIDER`),
`IN_PLATFORM`, and manual-call recording with `manual_call_notes` /
`manual_call_by`. Full delivery evidence.

Buyer notification after confirmation uses the **LT-14 wording** and is
operational only — it is not a demand for payment and must not read as one.

Draft `docs/specs/NOTIFICATIONS.md` as you go. Overlay endpoints:
`GET /notifications`, `POST /notifications/{id}/read`.

### 8.7 — Case list and the platform case desk

`GET /cases` (overlay) role-scoped: platform sees all; a bank or supplier sees
only cases on its own transactions, **minus confidential counterpart data**.

### 8.8 — Frontend, both portals

Payment timeline with derived outstanding balance and overdue days.
**`OVERDUE_UNCONFIRMED` rendered as "awaiting bank confirmation" — never
"defaulted".** Bank payment-report and confirm-status forms; recourse
initiation (bank) and response (supplier); dispute views; platform case
management; in-platform notification inbox.

EN + AR parity is CI-checked (`npm run check:i18n`).

### 8.9 — Integration checkpoint

Seed dates near maturity (the time machine is Phase 9). One funded
transaction: passes due date → `OVERDUE_UNCONFIRMED` shown as awaiting
confirmation → bank confirms → `OVERDUE` → bank initiates recourse → supplier
repays → `SETTLED` → closed `RECOURSE_SETTLED`. Partial payment recalculates
the derived balance. **A dispute pauses the maturity job, test-asserted.**
Buyer notification stored with delivery evidence.

**Definition of done:** that checkpoint, plus INV-7 no-hard-delete tests, plus
a supplier-view test asserting `bankInternalNotes` and bank evidence never
serialize to a supplier.

---

## 4. Five things Phase 7 taught — read these, they cost real time

1. **Run one integration test early, before you have written much.** Phase 7's
   `createSettlement` crashed on *every* call — a `$1` bound to both a `uuid`
   and a `text` column — and 450 unit tests reported everything green because
   they ran against a fake database. Fake-DB unit tests cannot see SQL type
   inference, constraint violations, trigger behaviour, or RLS. Get one real
   round-trip working per increment.
2. **Check every enum string against the frozen schema.** Phase 7 shipped
   `PLATFORM_OPERATIONS_ADMIN`; the real role is **`PLATFORM_OPS_ADMIN`**. It
   typechecked, it linted, it passed unit tests, and it would have escalated to
   nobody. Grep your literals against `docs/02_DATABASE_SCHEMA.sql`.
3. **Read the contract's *inline* response schemas, not just the `$ref`s.** The
   funding-confirm 401 declares `{code, attemptsRemaining}` inline rather than
   the Error envelope, which is why `attemptsRemaining` is now promoted to the
   top level of error bodies. Phase 8's case and notification endpoints have
   several inline schemas too.
4. **Write tests with the fixture's real numbers.** Phase 7's ledger scaffold
   assumed `gross = commission + fee + net`, which is false — the bank retains
   its discount and fees. The original test used invented numbers chosen to
   balance, and hid the bug. Derive expected values from the fixture; never
   pick them to make an assertion pass.
5. **A transient pooler timeout looks exactly like a regression.** The hosted
   Supabase session pooler intermittently times out on long suites. Before
   diagnosing a failure in previously-green code, re-run it clean.

---

## 5. Runbook

```bash
# From apps/api — jest configs are relative, this will fail from the repo root
npm test                      # unit
npm run lint
npx tsc --noEmit -p tsconfig.json
npx jest --config test/jest.integration.json --runInBand --testPathPattern phase8

# From apps/web
npm run typecheck && npm run lint && npm test && npm run check:i18n && npm run build

# From the repo root — after ANY controller or DTO change
npm run openapi:emit -w @zimmamless/api
node scripts/contract-conformance.mjs apps/api/openapi.generated.json
```

Integration suites need `apps/api/.env` (`DATABASE_URL`, `SUPABASE_URL`,
`SUPABASE_ANON_KEY`). They take several minutes; run them in the background and
keep working.

---

## 6. Documentation you owe

- `docs/completion/PHASE_8.md` — what was built, decisions made and **why**,
  what you deliberately did not do.
- `docs/coordination/DAILY_LOG.md` — a dated entry: endpoints live, behaviour
  changes, anything a consumer would otherwise assume wrongly.
- `docs/coordination/ENDPOINT_STATUS.md` and
  `apps/web/lib/api/endpoint-status.ts` — keep the two mirrored.
- `docs/coordination/OPEN_QUESTIONS.md` — anything the contract or schema
  cannot express. Follow the existing Q-NN format. Phase 7 raised Q-16 for
  exactly this reason.
- `docs/specs/NOTIFICATIONS.md` — the template catalogue.

---

## 7. How to report

Tell me what you built and what you found, plainly. If a test fails, show the
output. If you skipped something, say so and why. If you disagree with a
decision in this prompt, say so and make the case — I would rather change the
plan than have you build something you think is wrong.

Do not report a phase complete until every gate is green **and** you have
re-run the previous phases' integration suites, because this phase touches
shared code: the notification engine and the scheduler are used by Phases 5, 6
and 7.

---

## 8. State of the world when you start

**Ready:**

- All seven tables this phase needs already exist in the frozen schema —
  `buyer_payments`, `recourse_cases`, `disputes`, `withdrawal_cases`,
  `fraud_cases`, `notification_templates`, `relisting_requests`. Expect **no
  migration**, as in Phase 7.
- Every dependency ruling is settled: **D-03** (v3.1.0 overlay), **D-13/PA-06**
  (derived balances), and D-08/D-09 within the D-03..D-12 approval.
- Phase 7 left reusable machinery: `SchedulerService` (idempotent sweeps on a
  `TimeProvider` tick), `LedgerService` (balanced journals, INV-6),
  `SettlementProvider` behind a symbol, the `IdempotencyInterceptor`, and the
  audit interceptor.

**Carried over, not blocking, not yours to fix unless you choose to:**

- **No endpoint is promoted to live** — 0 of ~90. The funding endpoints are
  proved live by the Phase 7 integration suite, but the promotion rule requires
  a same-day smoke test *on the consuming screen*, which needs a session with
  both servers running. This is the Phase 9 rehearsal gate and the largest
  remaining demo risk.
- `db/tools/dedupe-organizations.mjs --apply` awaits an operator go-ahead; the
  dry-run plan is clean.
- **Q-16** is open: `ZM-FND-012` requires escalation to create an
  "administrative task", and nothing in the schema or contract can hold one.

**A scoping note.** This is the largest remaining phase — the master plan
budgets 6–8 days backend plus 5–7 frontend, and one agent carries both. If time
is short, the honest reduction is to build the demo path in full (maturity →
overdue-unconfirmed → confirm → payments → recourse → settled → closed) and
defer fraud, withdrawal and the platform case desk. Raise that as a decision
rather than quietly narrowing scope mid-phase.
