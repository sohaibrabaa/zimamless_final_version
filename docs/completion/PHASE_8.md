# Phase 8 — Post-Funding, Cases and Notifications

Money has moved. This phase is everything after — and it is where the
platform's honesty is most tested, because it is where things go wrong.

The defining behaviour is **ZM-PMT-008..011: a transaction whose due date
passes does not become `OVERDUE`.** It becomes `OVERDUE_UNCONFIRMED`, and it
stays there until a bank confirms. The platform cannot see a buyer's bank
account; only the funding bank can. Calling a supplier's invoice overdue on the
strength of a calendar is an accusation with nothing behind it, and it can
damage a real Jordanian business.

---

## What was built

| Increment | What it is |
|---|---|
| 8.1 | Maturity sweep, reminders, and the `OVERDUE_UNCONFIRMED` discipline |
| 8.2 | Buyer payments, `confirm-status`, closure — derived balances (D-13) |
| 8.3 | Recourse: bank-only, capped at the advance, no automatic refund |
| 8.4 | Disputes: automation pauses; the platform does not adjudicate |
| 8.5 | Withdrawal penalties (recorded, never deducted) and fraud review |
| 8.6 | Notification engine with real delivery evidence; the inbox |
| 8.7 | `GET /cases` — role-scoped across all four case types |
| 8.8 | Supplier/bank payment screens, case desk, inbox — both languages |
| 8.10 | `GET /admin/relisting-requests` — added in review; see below |

**63/63** integration tests against the hosted database. **539** API unit
tests, **232** frontend tests, lint/typecheck clean on both workspaces, i18n
parity at 802 keys, contract conformance reports no drift. **No migration** —
every table this phase needed was already in the frozen schema.

## Named invariant tests

| Rule | Where it is proved |
|---|---|
| **ZM-PMT-008..011** — a date never produces `OVERDUE` | Three independent layers, below |
| **D-13/PA-06** — balances derived, never stored | `invoices.paid_amount` asserted unchanged after a payment lands |
| **ZM-PMT-018** — supplier never sees `bankInternalNotes` | Asserted by name *and* by value, live |
| **ZM-REC-013** — a dispute pauses automation | Pause **and resume**, both through the real sweep |
| **ZM-REC-004** — a claim cannot exceed the advance | Face value 11,600 vs advance 9,000 |
| **ZM-FEE-016** — no automatic commission refund | `commissionRefundOnRecourse()` returns null, tested |
| **LT-12** — penalty recorded, never deducted | `penaltyDeduction()` returns null; zero ledger entries asserted |
| **ZM-FRD-004** — only compliance records a finding | Bank refused 403 on the case it reported |
| **INV-7** — closure keeps everything | Payments, notifications, history all still present |

---

## The overdue rule, three ways

Stating it once would have been a comment. It is enforced in three independent
places so no single change can quietly undo it:

1. **The state machine declares no `FUNDED → OVERDUE` edge at all.** The
   transition does not exist, so no future code can take it by accident.
2. **`maturityAction()`'s return type is `'OVERDUE_UNCONFIRMED' | null`.** The
   function cannot *name* the state, let alone return it.
3. **A test loops every sweepable state at 1, 7, 30, 365 and 3650 days past
   due** and asserts `OVERDUE` never appears.

The live test then checks the whole `status_history`, not just the current
state, so even a transient flip through `OVERDUE` would fail.

**And the wording is tested, not just the state.** The status-history reason
line, the supplier notification body, and the EN *and* AR UI labels are all
asserted not to contain "default", "failed to pay", or their Arabic
equivalents. Those lines get read by humans and quoted in disputes. The
notification says in as many words: *this is not a record of non-payment*.

---

## Five decisions worth recording

### `confirm-status` refuses `PAID` while money is outstanding

Not in the contract; added because the derived-balance ruling makes the
contradiction possible. A bank could otherwise mark an invoice paid while the
computed balance still showed 6,600 outstanding, and the supplier would see the
state and the money telling two different stories about the same invoice.

### A platform admin gets 403 on recourse

Recourse is a commercial claim between two counterparties. A platform that
could file one on a bank's behalf would be taking a position in a dispute it
exists to mediate. The 403 is the requirement (ZM-REC-002), not an oversight to
tidy up later. Likewise, a supplier may move a claim to `DISPUTED` and nothing
else — letting the debtor mark a claim `SETTLED` would let them discharge their
own debt.

### The seeded withdrawal policy was honoured, not reinvented

I had drafted a percentage-based penalty model. Migration 0002 already ships a
per-reason object with flat amounts and `applicable: null`. That null is the
interesting value: it means *the platform has no default opinion, send it to a
human*. `INVOICE_CHANGED` could be an honest correction or a bad-faith rewrite,
and an engine that always produced an answer would be inventing certainty
nobody has. A malformed or missing policy degrades to manual review — never to
a wrong charge.

The admin decision then takes `penaltyApplicable` **verbatim**. The policy is a
default to consider, never an answer that overrides a human who can see the
commercial context. Tested by having the admin waive the 500.000 the policy
proposed.

### Freezing is cheap; labelling is not

Opening a fraud review freezes the transaction immediately and concludes
nothing. Only a compliance decision records a confirmed status (ZM-FRD-004).
The asymmetry is the reasoning: stopping a payout is reversible — if the review
clears, the money moves a day later. Recording an organization as fraudulent
follows a business around forever. So the cheap reversible action happens on
suspicion, and the expensive irreversible one waits for a qualified human.

Fraud cases are also invisible to the parties. Telling a supplier that a review
naming them exists, before anything is concluded, turns an unproven suspicion
into an accusation they have to answer.

### An eligible relisting raises a *request*, not an approval

ZM-REC-018 requires seven verification outcomes before a receivable returns to
the marketplace. "This bank may not hold you to the collapsed deal" does not
certify that the invoice is still unpaid, unfinanced elsewhere, and unchanged
weeks later. So the withdrawal decision writes a `REQUESTED` row, not an
`APPROVED` one.

---

## Three bugs the live database found

Consistent with Phase 7: every one passed the unit suite first.

**`listing_status` has no `CLOSED`**, `accepted_offer_snapshots` keys off
`selection_id`/`source_offer_id` rather than `offer_id` and needs an
`offer_selections` row first, and `audit_logs` orders by `occurred_at` not
`created_at`. All three were me guessing a name instead of reading the schema —
the exact failure mode the phase prompt's lesson 2 warns about, committed
within an hour of my writing it down. Running the integration probe at 8.2
rather than at the end meant 8.3 onward landed first-time green.

**`closed_at = CASE WHEN … THEN $5 ELSE $5 END`** — a parameter used only
inside an expression gives Postgres nothing to infer from and defaults to
text. Same class as Phase 7's `$1`-as-two-types. Fixed with `::timestamptz`,
and the pointless `CASE` collapsed to an assignment.

**A bind-count error in `GET /cases`** — the platform branch uses a literal
`true` and never references `$1`, so binding the org id anyway is "supplies 1
parameter, requires 0", not a harmless extra.

## And one my own test found

The notification template renderer resolved `{{constructor}}` up the prototype
chain and rendered `function Object() { [native code] }` into a message body.
Fixed with an own-property check. The placeholder pattern now also matches a
leading underscore — deliberately, so `{{__proto__}}` is *recognised* and
renders empty rather than being left visible as machinery in a message to a
real person.

---

## Found in review, after this report first claimed the phase complete

Three defects and one scope miss, all found by re-reading both kickoff prompts
against the code rather than against this document.

**Reminders backfilled false due dates.** The sweep returned *every* reached
threshold, so an invoice funded five days before maturity had reached 30, 14
and 7 at once and the supplier received three notifications in the same minute
saying it was due in 30, 14 and 7 days. Phase 8's own checkpoint seeds dates
near maturity, so this fired in the demo. The unit test asserting it called the
behaviour "catching up" — but a reminder is a factual claim about a date, and a
late one is not a reminder. Only the nearest threshold fires now, and the
subject quotes the real days remaining rather than the bucket.

**`recordManualCall` destroyed evidence.** `manual_call_notes` is a single
column, so a second operator's call silently overwrote the first operator's
account of a conversation that happened offline and cannot be reconstructed —
a hard delete in a system that forbids them (INV-7), and with no audit entry at
all. Now audited with the previous notes in `previousValue`, under a row lock.

**`GET /admin/relisting-requests` was never built**, though §8.5 of the phase
prompt names it explicitly. The withdrawal flow was already writing `REQUESTED`
rows that nothing could read, which made the write pointless — the queue is the
only thing that turns a recorded request into a reviewable one. Now served,
platform-only, and the seven ZM-REC-018 checks report `null` when unrecorded
rather than being omitted: "checked and failed" and "not yet checked" mean
opposite things to a reviewer, and an absent key reads as the first when it is
the second. Contract coverage went 74 → 75 of 82 paths with no drift.

**A mock that disabled a screen element.** `overdueDays` was hardcoded to `0`,
so `PaymentTimeline`'s overdue-days line could never render. With no endpoint
promoted to live, the mock is what the demo shows, and a fixture that silently
switches off a feature is worse than no fixture — the code looks built and
never appears.

`ZM-NOT-007` was declared **partially met** — the manual-call record had
storage and audit and no route could create it — and raised as **Q-17** rather
than worked around. The product owner ruled Option 1 the same day
(**D-16**), so `POST /notifications/{id}/manual-call` is now in the v3.1.0
overlay and served, platform staff only, and the requirement is met.

## Deliberately not done

**Live endpoint promotion — started, not finished.** It was 0 of ~90; it is now
8, and the mechanism that was missing exists. `apps/web/test/live/` renders the
real component against the real API over a real Supabase JWT with no MSW
installed, which is what the promotion rule has always required and what
nothing satisfied before. Eight endpoints are promoted on that evidence and
every other entry stays `mock` — not assumed broken, simply not yet exercised
through a screen.

The suite also carries **INV-8 live**, which is the highest-value thing in it.
`minimumAcceptableAmount` never reaching a bank is enforced in four places — an
API allow-list, a column-level RLS `REVOKE`, and two redaction lists — and none
of those is what a bank actually *receives*. The spec walks the whole response
body recursively over a real bank token across the marketplace feed, each
listing, every readable transaction and its own offers, and separately asserts
that the supplier still sees the figure it set. A mock cannot leak what it was
never given, so no mock-based test could have proved this at all.

The remaining 82 are the Phase 9 rehearsal gate, and the demo path
(onboarding → invoice → risk → listing → offers → acceptance → contract →
funding) is the order to take them in. Until then the integration suite and the
demo still test two different systems for most of the product, which remains
the largest demo risk.

Building the harness produced four findings, and the pattern in them is the
point: **every one was an assumption that held against a mock and not against
the real system.**

1. A Phase 8 test asserted `items[0].read === false` on the inbox, quietly
   depending on nobody having ever opened a supplier notification. The live
   suite reads one, exactly as a person would, and it failed. A test that
   breaks because the product was used is testing the wrong thing.
2. A supplier appeared to receive `200` on another party's transaction. It was
   page two of 89 — the test asked for 50.
3. A transaction list rendered empty with no error, looking exactly like broken
   scoping. The hook is *disabled* until the provider derives an active
   organization, and a disabled resource is also not loading, so waiting on the
   loading flag resolved during the gap.
4. The marketplace feed keys off `listingId`, not `id`. The first draft
   assumed `id` and React rendered a column of `undefined` keys without
   complaint.

Three false alarms and one real test defect — and the two shape mismatches
(#4, plus `SessionProvider` needing a `locale` prop that only `tsc` objected
to) are precisely what would have surfaced as an empty screen in a live demo.

**`BUYER_PAYMENT_CONFIRMATION` (LT-14).** The buyer notification is catalogued
in `docs/specs/NOTIFICATIONS.md` with its constraint — operational only, never
a demand for payment — but not sent. The buyer never contracted with
Zimmamless; a message from a platform they have no relationship with, phrased
as a demand, would be both legally unfounded and a good way to damage the
supplier's relationship with its own customer. The wording needs PO sign-off
before Phase 9 sends it.

**Arabic notification bodies as template rows.** The rendering path and the
version selection are built and tested; the `notification_templates` table is
populated by Phase 9's seed. Until then a missing template degrades to the
caller's literal text, which is the correct failure direction — the message
still goes out.
