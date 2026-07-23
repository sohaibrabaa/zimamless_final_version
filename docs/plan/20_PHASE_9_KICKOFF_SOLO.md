# Phase 9 — Demo Readiness: Admin, Time Machine, Seed, Arabic, and the Live Path (single agent)

You are the sole engineer on **Zimmamless V3**, a Jordanian receivables
marketplace built for a competition. You own the whole stack: `apps/api`
(NestJS) and `apps/web` (Next.js). There is no second agent and no A/B split.

Phases 1–8 are complete, verified and on `main`. Before you write anything,
read `docs/completion/PHASE_8.md` and the last several entries of
`docs/coordination/DAILY_LOG.md` — the tail of that log is where Phase 8's
live-promotion work and the defects it found are recorded, and they set the
tone for this phase.

This is the last phase. Its job is not to add a lot of surface — most of the
product exists. Its job is to make the product **demonstrable, honest under a
moving clock, and coherent in Arabic**, and to close the small set of admin and
lifecycle endpoints still unserved. The single largest risk you inherit is not
a missing feature; it is that **82 of ~90 endpoints have never been driven
through a screen against the real API**, and every time one is, something real
turns up.

---

## 1. What this phase is about

Three things, in priority order.

1. **The demo path must run end to end against the live API, by hand, in both
   languages.** This is the rehearsal gate. Everything else is subordinate to
   it. If you do nothing else well, do this.
2. **The demo must survive a moving clock.** A judge will want to see an
   invoice mature, a reminder fire, a confirmation stall and escalate — without
   waiting real days. That is the time machine (`POST /demo/time-travel`),
   guarded so it can never move a production clock.
3. **The product must be coherent in Arabic and RTL**, not merely
   key-complete. EN/AR parity is already CI-checked; what is not checked is
   whether the Arabic actually reads correctly, lays out right-to-left, and
   never shows a raw key or a Latin-numeric amount where it should not.

Everything else in §3 is real work, but it serves those three.

---

## 2. Standing constraints — unchanged, still absolute

These have held for eight phases. They do not relax because it is the last one.

1. **Frozen means frozen.** Never modify `docs/02_DATABASE_SCHEMA.sql` or
   `docs/03_API_CONTRACT.yaml`. Additive migrations that don't alter existing
   columns, constraints or response shapes are permitted. A contract or schema
   problem with no `DECISIONS.md` ruling goes in `OPEN_QUESTIONS.md` — never
   work around it silently. New endpoints go in the **v3.1.0 overlay** with a
   `DECISIONS.md` ruling first, exactly as D-16 did this session; the
   conformance gate will reject an undeclared path, and that is correct.
2. **Money** is `numeric(18,3)` in the DB, the `Money` class (decimal.js) in
   code, a 3-dp **string** on the wire. Float arithmetic on money is a defect.
   Never a JSON number. The frontend uses the `@/lib/money` functions, never a
   coercion — the lint rule that bans `Number(...)` on money is blunt on
   purpose; do not weaken it.
3. **`minimumAcceptableAmount` never reaches a bank** — not in a response,
   error, log, notification, or document. This is proved live now
   (`apps/web/test/live/floor.live.spec.tsx`); any new bank-facing surface you
   add must keep that spec green.
4. **All time** in `src/modules/**` and `src/jobs/**` goes through the injected
   `TimeProvider`. `new Date()` / `Date.now()` are lint-banned there. This is
   the reason the time machine works at all — respect it in every new sweep or
   handler.
5. **RLS is a real layer.** The RLS suite connects as each persona with a real
   JWT straight to Postgres, bypassing NestJS. Any new table gets a policy and
   a coverage-checklist entry, or `db:verify` fails.
6. **Every mutation writes an audit entry** — actor user, actor org,
   before/after, correlation id.
7. **Government unavailability never reduces a risk score component** — only
   `dataAvailabilityPct`.
8. **The Supabase service-role key never leaves the server.**
9. **Idempotency keys on every settlement operation**; the key is the
   settlement id.
10. **Each invariant ships with a named CI test.**
11. **Post-funding balances are derived** (D-13/PA-06). Never mutate
    `invoices.paid_amount`/`outstanding_amount` after listing.
12. **`bankInternalNotes` and bank-side evidence never serialize to a
    supplier.**
13. **No hard deletes** (INV-7).

**Work directly on `main`. Do not create branches.** Commit after each
increment with a message explaining *why*. Push after each commit.

---

## 3. What to build

### 9.1 — Promote the demo path to live, screen by screen

This is the centrepiece, and it comes first because it is where the real
problems are. The mechanism already exists: `apps/web/test/live/` renders a
real component against the real API over a real Supabase JWT with no MSW
installed (`npm run test:live` from `apps/web`). Eight endpoints are already
promoted this way — copy that pattern, do not invent a new one.

Walk the demo path in order and promote each endpoint only when a live test
renders its consuming screen and passes:

```
onboarding → invoice wizard → risk → listing activation → marketplace/offers
→ acceptance → contract + signatures → funding + OTP + settlement
→ maturity → payments → the case types → notifications
```

Rules, learned the hard way in Phase 8:

- **Promote on evidence, never on optimism.** A broken demo is worse than a
  mocked one. An endpoint flips to `live` in `endpoint-status.ts` only when a
  `test/live` spec covers it, and the note records which file.
- **Expect to find real defects, not just wire them up.** Phase 8's promotion
  pass found an N+1 that made `GET /transactions` take 9 seconds and 500 a
  quarter of the time — invisible to 540 unit tests (they mock the DB) and to
  the integration suite (it pages small). Assume each screen has one of these
  waiting, and run the list endpoints at realistic page sizes.
- **A failing live assertion is a hypothesis, not a verdict.** Three times in
  Phase 8 a live failure looked like a product defect and was a test
  assumption that only held against a mock (a paging artifact, a disabled hook,
  a shared-state read). Diagnose before you "fix". But the fourth was real —
  do not swing the other way and dismiss them all.
- **Keep the API dev server clean.** `nest start --watch` recompiles on your
  edits and can orphan a process on port 3000 (EADDRINUSE), leaving a stale
  server answering with old code. If live results look strange, restart it
  clean before diagnosing anything.

**Definition of done for 9.1:** the whole demo path above renders live in EN,
and the endpoint-status board and its markdown mirror reflect exactly what is
promoted — no optimistic flips.

### 9.2 — The demo time machine (`POST /demo/time-travel`)

A server-side day-offset applied inside `SystemTimeProvider.now()`, changed via
`POST /demo/time-travel`, so the whole system — every sweep, every maturity
check, every deadline — moves together when the demo jumps the clock forward.

- **Guarded twice, both required** (ZM-DEMO-003/004): the
  `DEMO_TIME_MACHINE_ENABLED` env var **and** the `demo_time_machine_enabled`
  platform setting. In production the offset is never read. Hiding the control
  in the UI is explicitly *not* sufficient. **Never add a third way to move the
  clock.**
- Measured in **whole days** (`offsetDays`). It expresses "tomorrow", not
  "twenty minutes from now" — OTP-expiry demos still belong to
  `FixedTimeProvider` in unit tests, not this.
- A small platform-only control in the UI to set/clear the offset, showing the
  current effective date.
- **Test that a forward jump actually drives the sweeps**: set the offset past
  a seeded invoice's due date, let the maturity sweep run on its tick, and
  assert the transaction became `OVERDUE_UNCONFIRMED` — the headline Phase 8
  behaviour, now demonstrable live.

### 9.3 — The demo seed

A dedicated, idempotent seed that stages the demo path so a judge sees a live
system with history, not empty tables. It must:

- Refuse to run with `NODE_ENV=production`.
- Stage transactions at **every** demo-relevant state, with dates positioned
  near maturity so the time machine has something to move.
- Populate `notification_templates` (EN + AR) for the `ZM-NOT-009` catalogue —
  until now the render path degrades to caller text; the seed is where the real
  bilingual rows land.
- Be safe to re-run: it heals rather than duplicates.

### 9.4 — The admin surface (the 7 unserved contract paths)

All declared in the frozen contract or the v3.1.0 overlay already — implement
them exactly, no invented shape:

- `GET/PATCH /admin/settings` — platform settings, including the time-machine
  and reminder-day keys. PATCH is platform-admin only and audited.
- `GET/POST /admin/commission-tiers` — read and create tiers; POST creates,
  never edits, mirroring the risk-model pattern.
- `GET /admin/audit-logs` — the audit trail, platform-only, paginated. This is
  where every mutation this project has recorded finally becomes visible.
- `POST /admin/relisting-requests/{id}/approve` — the decision the Phase 8
  queue (`GET /admin/relisting-requests`) was built to feed. Requires the seven
  ZM-REC-018 verification outcomes before it may approve.
- `POST /transactions/{id}/cancel` — cancellation as a recorded state, never a
  delete (INV-7).
- `POST /transactions/{id}/relist-request` — the supplier-side request that
  raises a `REQUESTED` relisting row (never an approval — ZM-MKT-016).

Each is money- or state-moving where the contract says so; carry `@Idempotent()`
and audit accordingly.

### 9.5 — The full Arabic / RTL pass

Parity is already green at 802 keys; that is necessary and not sufficient.

- Drive the demo path **in Arabic** and read it. No raw keys, no English
  leaking through, no broken bidi where an amount or a Latin reference sits
  inside Arabic prose (ZM-I18N-006).
- Confirm RTL layout: direction, alignment, mirrored chrome.
- Resolve **Q-03** first (Western vs Arabic-Indic digits for money) — it bakes
  into every Arabic amount and into the seeded Arabic templates, so it cannot
  stay open once 9.3 writes those rows. Raise it for a ruling at the start of
  this phase, not the end.
- The `OVERDUE_UNCONFIRMED` wording is already asserted in both languages
  (`payments-domain.spec.ts` and the live payments spec) — keep that green; it
  is the phase-8 rule that most needs to survive translation.

### 9.6 — Loose ends that need a ruling, not code

Raise these at the **start** so they don't block the end:

- **Q-16** — ZM-FND-012's "administrative task" still has no home; escalation
  rides on `notifications`. Decide whether the notification delivery is
  sufficient for the demo or whether an `admin_tasks` surface is wanted.
- **`BUYER_PAYMENT_CONFIRMATION` (LT-14)** — catalogued, not sent. Needs
  product-owner wording sign-off before it goes out: operational only, never a
  demand for payment, to a buyer who never contracted with Zimmamless.
- Provisional catalogues from earlier phases (consent Q-09, reason-codes Q-06,
  declarations Q-13) — ratify or adjust before the demo shows them.
- **`db/tools/dedupe-organizations.mjs --apply`** — clean dry run, awaits an
  operator go-ahead. Decide whether to run it before the demo seed.

### 9.7 — PDF contracts (PA-09, nice-to-have)

HTML contract documents with a hash already exist. PA-09 rates a PDF a Phase 9
nice-to-have, not a requirement. Do it only if 9.1–9.5 are solid; never at
their expense.

---

## 4. What the last three sessions taught — read before you start

1. **The live harness earns its keep by finding real bugs, not by turning
   entries green.** Its whole value is that it exercises the one thing unit and
   integration tests structurally cannot: a real component reading a real
   response over a real pooler. Treat every promotion as a bug hunt.
2. **Green suites are not a clean bill of health.** Three sessions running, a
   phase reported complete had real defects found on the next pass — a
   backfilled false reminder, an evidence-overwriting call, a demo-killing N+1.
   Re-read the requirement against the code, not the code against itself.
3. **Check every enum and column name against the frozen schema.** The
   recurring bug class in this project is a plausible name that typechecks,
   lints, passes fake-DB unit tests, and is wrong (`PLATFORM_OPERATIONS_ADMIN`,
   `id` vs `listingId`). Grep the literal against the schema.
4. **A transient pooler timeout looks exactly like a regression.** The hosted
   Supabase session pooler intermittently drops connections and fails DNS on
   long runs. Before diagnosing a failure in previously-green code, re-run it
   clean.
5. **Raise contract/schema gaps; don't paper over them.** Q-17 → D-16 this
   session is the model: record the ruling, add the overlay path, then the
   code. The conformance gate is a friend, not an obstacle.

---

## 5. Runbook

```bash
# From apps/api — jest configs are relative; these fail from the repo root
npm test                      # unit (mocks the DB)
npm run lint
npx tsc --noEmit -p tsconfig.json
npx jest --config test/jest.integration.json --runInBand --testPathPattern phase9

# From apps/web
npm run typecheck && npm run lint && npm test && npm run check:i18n && npm run build
npm run test:live             # the live screen suite — needs the API up + seed + network

# The live suite needs both servers and the seed:
#   apps/api:  npm run start:dev        (port 3000)
#   root:      npm run db:seed
# Only the Supabase browser SDK is stubbed in those specs; everything else is real.

# From the repo root — after ANY controller or DTO change
npm run openapi:emit -w @zimmamless/api
node scripts/contract-conformance.mjs apps/api/openapi.generated.json
# and mirror the client types the web app reads:
npm run generate:contract -w @zimmamless/web   # (or from apps/web)
```

Integration and live suites hit the hosted DB and take several minutes; run
them in the background and keep working. Do not mistake a pooler timeout for a
regression.

---

## 6. Documentation you owe

- `docs/completion/PHASE_9.md` — what was built, what was found, what you
  deliberately did not do, and an honest final statement of demo readiness.
- `docs/coordination/DAILY_LOG.md` — dated entries as you promote endpoints and
  land the seed/time-machine.
- `docs/coordination/ENDPOINT_STATUS.md` and
  `apps/web/lib/api/endpoint-status.ts` — keep mirrored; this is the board that
  says what is actually live, and it must stay honest.
- `docs/coordination/DECISIONS.md` — a ruling for every new overlay path and
  for Q-03/Q-16 before you build on them.
- `docs/coordination/OPEN_QUESTIONS.md` — update statuses as they are ruled.

---

## 7. How to report

Tell me what you built and what you found, plainly. If a test fails, show the
output. If you skipped something, say so and why. If a screen is not truly live
end to end, do not tell me it is — that is the one claim this phase exists to be
able to make truthfully.

Do not report the phase complete until:

- the demo path renders live in **EN and AR**, by hand, with the endpoint board
  reflecting exactly what is promoted;
- the time machine drives a maturity sweep to `OVERDUE_UNCONFIRMED` in a test;
- the demo seed stages the full path and is re-run-safe;
- the 7 admin/lifecycle paths are served with conformance passing and no drift;
- every prior phase's integration suite has been re-run green (this phase
  touches the scheduler, the settings, and shared read paths);
- `db:verify`, typecheck, lint, unit, integration, `check:i18n`, `test:live`
  and `next build` are all green on both workspaces.

---

## 8. State of the world when you start

**Ready:**

- Phases 1–8 complete and on `main`. 8 of ~90 endpoints promoted live via
  `apps/web/test/live/` (`/auth/me`, `GET /transactions`,
  `GET /transactions/{id}/payments`, `GET /marketplace/eligible`, `GET /cases`,
  `GET /admin/relisting-requests`, `GET /notifications`,
  `POST /notifications/{id}/read`).
- The reusable machinery: `SchedulerService` (idempotent sweeps on a
  `TimeProvider` tick), `MaturityService`, `LedgerService`, the settlement and
  signature and notification adapters behind symbols, the `IdempotencyInterceptor`,
  the audit interceptor, and the live-test harness in `apps/web/test/live/`.
- `AllExceptionsFilter` logs every 500 with a full stack and returns a bare
  `INTERNAL_ERROR` with a correlation id — never a stack, driver message, or SQL
  to a client.

**Carried over — yours to close in this phase:**

- **82 of ~90 endpoints still on mocks.** The demo path is the priority order.
  This is the largest demo risk, full stop.
- The 7 unserved contract paths listed in §9.4.
- **Q-03** (Arabic money digits), **Q-16** (administrative task home),
  **LT-14** buyer wording, and the provisional catalogues — all need a ruling,
  raised at the start.
- `dedupe-organizations.mjs --apply` awaits a go-ahead.

**A scoping note.** This is the last phase and the temptation is to polish
breadth. Resist it. A demo that runs the core path flawlessly in two languages
under a moving clock beats one that serves ninety endpoints and stumbles on
screen three. If time is short, cut 9.7 (PDF) and trim 9.4 to the paths the
demo actually shows, and say so — do not quietly narrow 9.1.
```
