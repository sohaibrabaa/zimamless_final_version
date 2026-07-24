# Phase 9 — Admin, Seed, Time Machine, and Demo Hardening

The phase where the product stops being a green test suite and becomes a
thing a judge can click. Its defining discovery: **a green suite is not a
demo.** Every increment of this phase found real defects that eight phases
of passing tests had never executed — an API that could not boot with its
own demo flag on, a cancel that crashed on the first actually-open listing,
a notification engine no sender used, an underwriting screen that showed
CRITICAL on every staged receivable for three different correct reasons.

---

## What was built

| Increment | What it is |
|---|---|
| 9.2 | Demo time machine: `POST /demo/time-travel`, double-guarded (env flag AND platform setting), audited, offset applied in exactly one place; platform UI control |
| 9.4 | The admin surface: settings GET/PATCH, commission tiers, audit-log search, relisting approval, supplier cancel + relist-request — contract coverage **83/83 paths** |
| 9.3 | The demo seed (`db/tools/scenario-demo.mjs`): 9 fixtures at every demo state, 17 bilingual template keys, real e-invoice uploads, honest trust scores |
| D-21 | The notification retrofit: all senders route through `NotificationsService.send()` — templates and `preferred_language` finally decide what recipients read |
| 9.1 | The promotion sweep: **8 → 36 endpoints live**, every demo-path screen proven against the real API by `apps/web/test/live/` (15 files / 45 tests) |
| 9.4b | The admin *screens*: platform/audit (paginated, entity filter), settings editor (whitelist edit, audited), commission tiers table — EN + AR |
| 9.5 | Arabic, proven: AR templates served to AR-preferring users live (constraint wording intact), AR screens over live data with zero key leaks |

## The seed's doctrine, and what it caught

Anything that moves money or state goes through the API as the entitled
persona; SQL stages only inert pre-states. `OVERDUE_UNCONFIRMED` and
`RECOURSE_ACTIVE` are not even API-stageable — a receivable already past due
cannot be contracted (`INVOICE_PAST_DUE`, correctly) — so the seed matures
them **through the demo time machine itself**: armed via the admin API,
jumped +2 days, marked by the real sweep, bank confirms, recourse opens, and
the clock returns to zero in a `finally`. The staging run therefore
exercises 9.2's endpoint end to end every time it runs.

Defects the seed found that no suite had:

1. **`main.ts` could not boot with the time-machine env flag on** — the
   boot-time `refresh()` ran before `init()` created the pool. The same
   ordering bug sat in five phase suites. Unreachable from Phase 1 until
   9.2 armed the flag; two "transient infrastructure" failures were this.
2. **Cancel crashed on an open listing** — the closing UPDATEs named an
   `updated_at` column neither `listings` nor `bank_offers` has. Eighteen
   green tests around cancel; none had staged an open listing.
3. **`recipient()` selected a nonexistent column** (`users.language`;
   the schema says `preferred_language`) — dormant because `send()` had no
   callers until D-21.
4. **All-CRITICAL trust scores** — three correct blockers in sequence
   (no e-invoice document → unfinalized hash → sub-7-day tenor, AS-08).
   Fixed honestly: real PDFs uploaded and finalized per fixture; the
   maturity target restaged at due +8 (`ZM-DEMO-MATURING`, 86/LOW).

## D-21 — the engine nobody used

`NotificationsService.send()` — the only code reading
`notification_templates`, honouring `preferred_language`, recording
`template_version` — had **zero callers**. All eight senders wrote raw
`INSERT INTO notifications`, English hardcoded. Seeding the bilingual
catalogue would have been decoration and 9.5 structurally impossible for
notifications. All eight senders now route through `send()`, previous
literal text preserved as the fallback (ZM-NOT-004's degrade direction), and
`OFFER_RECEIVED` — catalogued as built, sent by nothing — dispatches at
offer approval, naming no bank and no amount.

## Named proofs added this phase

| Rule | Where it is proved |
|---|---|
| ZM-DEMO-003/004 — forward jump drives the sweeps | `phase9-demo.integration` (7/7): jump → sweep → `OVERDUE_UNCONFIRMED`, never `OVERDUE` |
| Double guard — hiding the UI is not the protection | 404 disarmed even to a platform admin; 403 to a supplier when armed |
| INV-1/INV-4 as the client experiences them | `acceptance.live`: second call on one attempt replays the identical snapshot (id, hash, capturedAt) |
| INV-8 — the floor, on real bodies | `floor.live` (recursive sweep) + `listing.live` (the freshly activated listing, as a bank) |
| ZM-FND-005/009 — the OTP discipline | `funding.live`: plaintext in one response; wrong code → `attemptsRemaining` and nothing else |
| ZM-BUY-009 — candidates, never a selection | `wizard.live`: real registry search rendered by `BuyerStep`, nothing pre-selected |
| ZM-RSK-013 — no model internals serialize | `risk.live`: no weight/coefficient/probability anywhere in the body |
| ZM-I18N/ZM-NOT-004 — Arabic end to end | `phase9-notifications.integration` (3/3) + `arabic.live` |
| §16.8 — cancel closes the listing and its offers | `phase9-admin` (19/19), staged open listing + live offer |

## Demo-day runbook

1. **Morning of:** start the ML service (`services/ml`, venv,
   `python -m uvicorn app.main:app --port 8000`), start the API, then
   re-run `node db/tools/scenario-demo.mjs`. It heals: a lapsed OPEN
   listing (the offer window follows the real deadline settings, ~24h)
   returns its transaction to ELIGIBLE and the seed stages a fresh round
   with fresh approved offers. `--status` shows the board.
2. **The time machine** is armed from platform/settings (the arm switch is
   a real `PATCH /admin/settings`; the jump control is beside it). Jump
   ≥ +9 days to mature the maturing fixture live on stage; return to zero
   and disarm when done. The maturing fixture is **generational**
   (`ZM-DEMO-MATURING`, `-2`, `-3`, …): any test run or rehearsal that
   jumps the shared clock matures the current one permanently (INV-7,
   correctly), so the seed detects a consumed generation and stages the
   next — the morning re-run always leaves a fresh FUNDED chain one jump
   short of maturity. `--status` names the live generation.
3. **Production drill:** with `DEMO_TIME_MACHINE_ENABLED` unset,
   `/demo/time-travel` is 404 and boot refuses the offset entirely.

## Deliberately not in this phase

- **~50 endpoints still mock** — none on the demo path. They are the
  Phase 2 onboarding wizard screens, bank offer creation/approval screens,
  case *action* forms (dispute/fraud/withdrawal decisions), manual-call
  recording, and admin POSTs without screens. Each stays mock because
  nothing has exercised it live yet — never because it is assumed to work.
- **Manual Arabic/RTL walkthrough** — the automated pass proves Arabic is
  present and key-leak-free on live data; reading the prose and judging
  the bidi layout needs eyes (RTL_CHECKLIST.md).
- **PDF contracts (PA-09)** — nice-to-have, explicitly not at 9.1–9.5's
  expense. HTML + hash stands.
- The old two-agent phase file's full list (11 scenarios, twins,
  Playwright E2E, WCAG audit, deploy runbook) exceeds the solo Phase 9
  kickoff's scope; the deltas are recorded here rather than silently
  dropped.

## Rulings

D-17 (Western digits), D-18 (escalation rides notifications), D-19
(`BUYER_PAYMENT_CONFIRMATION` stays unsent), D-20 (dedupe before seed —
ran clean), D-21 (the sender retrofit). Q-18 (relisting approval's
seven-check gap) remains open for a product ruling.
