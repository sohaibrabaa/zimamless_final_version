# Phase 5 Completion Report — Agent A

**Phase:** 5 — Marketplace + Offers
**Agent:** A (backend)
**Sessions spent:** 1 (planned range: 6–8 days)
**Dates:** 2026-07-23
**Phase file:** `docs/plan/phases/PHASE_5_MARKETPLACE_OFFERS.md`
**Branch:** `a/phase5` (off `a/phase4`)

This phase carries three of the product's five defining behaviours — **no
auction**, **secret floor**, **confidential offers**. Each of the three is
enforced in more than one place, and §4 explains why that redundancy is not
belt-and-braces nervousness but a response to how these particular failures
happen.

---

## 1. Delivered vs. planned

| Planned item | Status | Notes |
|---|---|---|
| Listing activation `POST /transactions/{id}/listing` from `ELIGIBLE`; fee obligation + ledger receivable; eligibility for **every** active bank with `rules_applied`; bank notifications; window opens; state → `OPEN_FOR_OFFERS` | ✅ done | `listings.service.ts`. **One database transaction** covers all seven effects — §4.3. |
| Deadline jobs on `TimeProvider`: auto-close, 50%/15% reminders, selection lapse → `EXPIRED` + transaction back to `ELIGIBLE` | ✅ done | `listing-deadlines.service.ts`, written as an idempotent **sweep** rather than a cron — §4.4. |
| Policy filters GET/POST + v3.1.0 `PATCH` (edit/deactivate, D-12) | ✅ done | Deactivation is a flag, never a delete: eligibility rows cite the filter that produced them. |
| Offers: create / revise (new version, lineage kept) / withdraw (pre-acceptance, no penalty, audited); one current offer per bank per listing; window enforced | ✅ done | `offers.service.ts`. The one-current-offer rule is the schema's partial unique index; the service returns 409 with "revise it instead" rather than racing it. |
| Server-side money: recompute net, reject mismatch; inject commission (active tier on gross) and listing fee | ✅ done | `offer-math.ts` + `commission.service.ts`. `Money` throughout — **no `number` appears in `offer-math.ts` at all**. |
| Floor check: 422 `OFFER_BELOW_SUPPLIER_REQUIREMENT`, generic, zero numeric detail | ✅ done | `meetsFloor()` returns a **bare boolean** — §4.1. |
| Maker/approver: approval only by a different user with the approver role; 403 `SELF_APPROVAL_FORBIDDEN` at the service layer, DB CHECK as backstop | ✅ done | Both layers tested separately — §3, and the test that was initially wrong is described in §5.4. |
| Confidentiality serializers, allow-lists only; role-split `/listings/{id}/offers`; `offerCount` supplier-only; `BankListingView` excludes floor/count/competitors; sentinel scan wired | ✅ done | `describeForBank` is built additively from an empty object. Sentinel scan is `FLOOR_SENTINEL = '8675.309'` — §4.2. |
| v3.1.0: `GET /offers?status=` · `GET /marketplace/listings/{id}` · `GET /transactions/{id}/listing-current` | ✅ done | D-08 / D-07 / D-06. |
| RLS additions verified for `bank_offers`, `bank_eligibility`, `bank_policy_filters`, `listings` | ✅ done | Direct-SQL drill under bank A's real JWT with NestJS out of the picture. |
| Seed: a listing with two approvable draft offers | ✅ done | Delivered as `db/tools/scenario-phase5.mjs`, **not as SQL** — §4.5 explains why, and it is a deliberate deviation from the word "seed" in the phase file. |

Commission tiers arrived as migration `0007` rather than a seed, for the same
reason the Phase 4 baseline model version did: `ZM-FEE-011` prices every
offer from the active tier, so a migrated database with no dev seed could not
price an offer at all. That is platform configuration, not demonstration
data.

**Not in my half:** every screen in the phase file's Agent B list, including
the offer comparison screen.

---

## 2. Endpoints

Conformance gate: **44/82 contract paths served, no drift** on paths, verbs
or success status codes (was 31/82 at the end of Phase 4).

| Endpoint | Status | Verified how |
|---|---|---|
| `POST /transactions/{id}/listing` | **built-not-deployed** | Live: activation, fee obligation, balanced journal, eligibility rows, state change, second-activation 409. |
| `GET /transactions/{id}/listing-current` (D-06) | **built-not-deployed** | Live; visibility derived from the transaction, so a bank cannot enumerate listings it cannot see. |
| `GET /listings/{id}` | **built-not-deployed** | Live, both audiences. |
| `GET /listings/{id}/offers` | **built-not-deployed** | Live; the INV-11 drill is exactly this endpoint under two identities. |
| `GET /marketplace/eligible` | **built-not-deployed** | Live; filtered by a **join**, not a post-fetch discard. |
| `GET /marketplace/listings/{id}` (D-07) | **built-not-deployed** | Live, incl. the 403 for a bank found ineligible. |
| `GET/POST /banks/policy-filters` | **built-not-deployed** | Live; POST is `BANK_ADMIN` only. |
| `PATCH /banks/policy-filters/{id}` (D-12) | **built-not-deployed** | Live; deactivation verified to preserve the filter row. |
| `POST /listings/{id}/offers/create` | **built-not-deployed** | Live: happy path, net mismatch, forbidden server-computed fields, duplicate 409, below-floor 422. |
| `GET /offers` (D-08) | **built-not-deployed** | Live; scoped to the active bank org in SQL. |
| `GET/PATCH /offers/{id}` | **built-not-deployed** | Live incl. cross-bank 404. |
| `POST /offers/{id}/approve` | **built-not-deployed** | Live; INV-12 both ways. |
| `POST /offers/{id}/withdraw` | **built-not-deployed** | Live. |

`built-not-deployed` for the same reason as Phases 1–4: there is still no
hosting account. Everything above ran against the hosted Supabase database
and the local API and ML processes. See §6.

---

## 3. Tests added

| Test / suite | Covers | Status |
|---|---|---|
| `offer-math.spec.ts` (18 tests) | ZM-OFR-002 net formula; gross ≤ outstanding; net > 0; **reject-don't-correct** on client net mismatch; `meetsFloor` | ✅ |
| `eligibility.spec.ts` (16 tests) | ZM-MKT-003 rule evaluation and `rules_applied`; an **unscored** listing never fails a trust-score rule | ✅ |
| `phase5-marketplace.integration.spec.ts` (33 tests, 7 groups) | The phase file's checkpoint, end to end, live | ✅ live |
| ↳ `INV-8 — the supplier floor is invisible to banks` | **INV-8**. Byte scan of every bank-facing response for the sentinel | ✅ |
| ↳ `INV-11 — bank A can never see bank B` | **INV-11**, two ways: API response, and **direct SQL under bank A's JWT** with NestJS bypassed | ✅ |
| ↳ `INV-12 — maker/approver separation` | **INV-12** at the service layer *and* the `chk_maker_approver_differ` DB backstop | ✅ |
| ↳ `the submission window (ZM-MKT-009)` | No create/revise/withdraw after the window closes, decided on listing **status** not a clock comparison | ✅ |
| `transaction-state.spec.ts › allows listing now that Phase 5 can perform it` | The `ELIGIBLE → OPEN_FOR_OFFERS` assertion Phase 3 deliberately set to `false`, now flipped — §5.5 | ✅ |

Totals after this phase: **328 API unit** (was 293) · **128 live
integration** (was 96) · **122 ML** (unchanged — Phase 5 adds no ML).

---

## 4. Decisions worth the reader's time

### 4.1 `meetsFloor` returns a bare boolean, and that is the whole point

ZM-MKT-012 says a below-floor refusal must carry no numeric detail. The
obvious implementation returns a shortfall and then remembers not to log it,
not to include it in the error, not to put it in a metric. Every one of those
is a place a later edit can go wrong.

So the function refuses to compute the number at all:

```ts
export function meetsFloor(net: Money, floor: Money | null): boolean {
  if (floor === null) return true;
  return net.greaterThanOrEqual(floor);
}
```

There is no shortfall anywhere in the process to leak. The floor check also
lives in the service rather than in `validateOffer`, deliberately, so no
caller can fold a floor breach into a detailed validation error alongside the
numbers that caused it.

### 4.2 The sentinel technique

The supplier's floor in the checkpoint fixture is `8675.309` — a value that
appears nowhere else in the fixture. That makes a single `includes()` over
the serialized response a **complete** test rather than a spot check of the
fields someone remembered to look at. A test that asserts `expect(body.floor)
.toBeUndefined()` only proves the leak is not in the field you thought of.

### 4.3 Activation is one transaction, or it is a lie

Listing activation has seven effects: the listing row, the fee obligation, a
balanced double-entry journal, an eligibility decision per active bank, the
notifications, the status history, and the transaction state change. If the
fee obligation commits and the ledger journal does not, the platform has
charged for a service with no record of the receivable. All seven are in one
`db.transaction`.

### 4.4 A sweep, not a cron

Every clock reading in `listing-deadlines.service.ts` comes from the injected
`TimeProvider`, which carries the demo offset (ZM-DEMO-003). A wall-clock
cron would be **actively wrong**: when a demo jumps the clock forward three
days, the deadlines in between must process immediately, not three days later
in real time. `sweep()` asks "what is overdue as of the provider's now?",
which handles the real case and the demo case with the same code and is
idempotent — safe from an interval, from the time-travel handler, and from a
test.

The 50%/15% reminders use `template_key` as the idempotency key. Without it a
sweep running every minute would send a reminder every minute for the whole
second half of the window.

### 4.5 The "seed" is a script that calls the API — deviation, stated plainly

The phase file asks for a **seed**: "a listing with two approvable draft
offers for the checkpoint." I did not write it as SQL, and the deviation is
worth defending rather than burying.

A listing is not a row. Activating one produces a fee obligation, a balanced
ledger journal, an eligibility decision per bank *with the rules that
produced it*, notifications and a state change. An offer is not a row either:
its commission comes from the active tier, its listing-fee component from the
unpaid obligation, and its net is recomputed server-side and re-checked by a
database CHECK. Hand-written SQL would produce a listing that **looks right
in the UI and was never priced, never evaluated, and never audited** — which
is precisely the failure the Phase 2 audit found in the opposite direction,
where residue from hand-run scripts had been described as seeded fixtures.

So `db/tools/scenario-phase5.mjs` logs in as the real personas over Supabase
and calls the real endpoints. Run it with `npm run db:scenario:phase5`. It is
idempotent (fixed ids in the unused `0e900000` block, re-runs report and
leave things alone) and has `--status` and `--purge`.

Two details in it are themselves decisions:

- **The two offers are left in `PENDING_INTERNAL_APPROVAL`.** Approving them
  in the seed would consume the checkpoint's most important moment — the
  maker's own approval being refused and a different user approving. That is
  demonstrated, not seeded.
- **The numbers are chosen so gross and net rank differently.** Bank B
  advances more gross (9 200.000 vs 9 000.000) but nets less (8 337.000 vs
  8 390.000). The comparison screen's entire thesis is that net payout is the
  anchor and the biggest headline number is not automatically the best deal;
  the fixture should not accidentally make those two rankings agree.

Both figures came back from the server matching the arithmetic in the script's
comment to the millifils, which is a small independent confirmation that the
commission tier and listing-fee injection do what §1 claims.

### 4.6 What the ineligible rows are for

`bank_eligibility` gets a row for **every** active bank, not just the eligible
ones. The ineligible rows with their `rules_applied` are the audit trail that
answers "why did bank C never see this listing?" — a question that has no
answer if exclusion is expressed by the absence of a row.

---

## 5. Problems found and fixed

### 5.1 A test that could not delete what it created (INV-7, working)

The first version of the Phase 5 fixture used a fixed transaction id and
deleted it in teardown. It could not: activation writes a balanced ledger
journal, `ledger_entries` is append-only by database rule (INV-7), and the
transaction row is referenced by it. The `DELETE` ran and did nothing.

The right response was **not** to weaken the invariant. Each run now uses its
own `randomUUID()` transaction, cleans up everything that *is* erasable, and
leaves the journal and its transaction behind as the permanent entries they
are meant to be. A financial record a test can erase is not a financial
record.

### 5.2 `ON CONFLICT DO NOTHING` on a table with no unique constraint

Migration `0007`'s first draft guarded the tier insert with `ON CONFLICT DO
NOTHING`. That clause only suppresses unique and exclusion violations, and
`commission_tiers` has neither — so a second run would have inserted a
duplicate set and left the tier lookup ambiguous about which row priced a
transaction. Replaced with an explicit `WHERE NOT EXISTS`.

### 5.3 A parameter that was both a uuid and a text

`INSERT … VALUES ($1, 'ZM-P5-' || substr($1::text, 1, 8), …)` fails with
*"inconsistent types deduced for parameter $1"*. The reference number is now
computed in JavaScript and passed as its own parameter.

### 5.4 The INV-12 test was testing the wrong thing

My first self-approval test used a plain `BANK_OFFER_MAKER` and asserted a
403. It passed — for the wrong reason. A plain maker lacks
`BANK_OFFER_APPROVER`, so the **route guard** stopped it with
`INSUFFICIENT_ROLE` and the self-approval check never ran. The invariant was
untested and the test was green.

Fixed with a `BANK_ADMIN`, who holds both capabilities and therefore reaches
the service check, plus a separate test that drives the DB
`chk_maker_approver_differ` constraint directly. Two layers, two tests, and
neither can pass on the other's behalf.

### 5.5 A Phase 3 assertion that Phase 5 made false, twice

`transaction-state.spec.ts` asserted `ELIGIBLE → OPEN_FOR_OFFERS` was
**false**, with a comment saying "that is Phase 5 to add". Phase 5 added it,
so the assertion flipped to `true` and the comment now records when the
capability arrived — the pair reads as history rather than as a deletion.

The same thing happened in `rls-phase3.integration.spec.ts`, which asserted a
bank sees **zero** transactions "because Phase 3 creates no listings". Phase 5
made that premise false in a way that is *correct behaviour*: a bank now
legitimately sees a transaction it was found eligible for. Narrowed to the
claim it was always about — a bank sees nothing of this suite's own
never-listed fixture.

---

## 6. Still blocked, five phases running

**Deployment.** There is no hosting account, so nothing is deployed and every
endpoint above is `built-not-deployed`. Per the product owner's instruction
this is now a deliberate deferral rather than an impediment: verify locally
first, deploy when the account exists. The consequence to keep in view is
that the phase files' "live on deployed stack" checkpoints are being met
against the hosted database with locally-running processes, which is the same
code and the same data but not the same network boundary.

**Q-03 (Arabic digit set)** remains open and is now genuinely pressing —
Phase 6 ships Arabic contract templates.

---

## 7. Verification

Everything below was run to completion on 2026-07-23:

| Check | Result |
|---|---|
| API unit tests | **328 passed** (18 suites) |
| Live integration tests | **128 passed** (5 suites) |
| ML tests | **122 passed** |
| `db:verify` | **17/17** |
| Contract conformance | **44/82 paths, no drift** |
| Lint (all workspaces) | clean |
| Typecheck (all workspaces) | clean |
| `scenario-phase5.mjs` | scenario created, then re-run to confirm idempotency |

---

## 8. For Agent B

The handover notes are in `docs/coordination/DAILY_LOG.md` under 2026-07-23
(Phase 5). The short version: the floor and the offer count do not exist in
any bank-facing response, `netSupplierPayout` is the server's number and
never yours, and the below-floor 422 carries no numbers on purpose — render
it as written.
