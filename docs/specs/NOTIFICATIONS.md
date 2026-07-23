# Notification Template Catalogue

Every message the platform sends. Owner: Agent A (drafts), PO (wording).

Templates live in `notification_templates`, keyed by
`(template_key, channel, language, version)`. The version used is written onto
every `notifications` row, so a message can be reconstructed exactly as it was
sent even after the template has been edited.

---

## Two rules that govern this whole document

**A status the platform cannot observe is never recorded.** The email and
WhatsApp gateways mark `SENT`. Handing a message to a provider is not the same
as it reaching a person, and writing `DELIVERED` for something we did not see
would manufacture the evidence this table exists to provide. `DELIVERED` is
written in exactly two places: an in-platform message the user opened
(`POST /notifications/{id}/read`), and a phone call an operator recorded making.

**Wording is part of the requirement, not decoration.** Two templates below
carry constraints that a rewrite must not break, and both are marked ⚠️. The
`PAYMENT_OVERDUE_UNCONFIRMED` body must not assert non-payment, and the buyer
notification must not read as a demand for payment. Both have tests.

---

## Channels

| Channel | Adapter | Terminal status it can produce |
|---|---|---|
| `IN_PLATFORM` | `InPlatformChannel` | `SENT` → `DELIVERED` on read |
| `EMAIL` | `DummyEmailChannel` | `SENT`, `BOUNCED` on a malformed address |
| `WHATSAPP` | `DummyWhatsappChannel` | `SENT`, `BOUNCED` on a non-Jordanian MSISDN |
| `MANUAL_CALL` | `ManualCallChannel` | `QUEUED` until a human records the call |

All four sit behind the `NOTIFICATION_CHANNELS` symbol. Nothing in the domain
names a concrete adapter, so swapping a dummy for a real gateway is a one-line
change in `app.module.ts`.

**`MANUAL_CALL` leaves `QUEUED` only when a human says so**, through
`POST /notifications/{id}/manual-call` — added additively under **D-16** after
Q-17 found that `ZM-NOT-007` had storage (`manual_call_notes`, `manual_call_by`)
and no route to write it. Platform staff only, including compliance: an officer
telephoning a supplier during a fraud review is exactly the call this record
exists for.

It is deliberately **not** folded into `/read`. A recipient opening their inbox
and an operator attesting to a phone conversation are different claims by
different people, and one route would let the first write the second. A blank
outcome is refused: a record asserting that a conversation happened while
saying nothing about it is worse than no record, and would satisfy the column
while defeating the requirement.

The previous notes are kept in the audit entry's `previousValue`. The column
holds one value, so a second operator's call overwrites a colleague's account
of a conversation that happened offline and cannot be reconstructed — a hard
delete of evidence in a system that forbids them (INV-7).

---

## The ZM-NOT-009 catalogue

`ZM-NOT-009` names fifteen things the platform must notify. Status is against
Phase 8; keys marked **built** are sent by live code today.

### Onboarding and applications (Phase 2)

| Key | Recipient | Trigger | Status |
|---|---|---|---|
| `APPLICATION_STATE_CHANGED` | Supplier | Application moves state | built |
| `INFORMATION_REQUESTED` | Supplier | Reviewer requests information | built |
| `SLA_WARNING` | Reviewer | Decision SLA approaching | built |

### Marketplace (Phases 5–6)

| Key | Recipient | Trigger | Status |
|---|---|---|---|
| `NEW_ELIGIBLE_LISTING` | Bank | A listing the bank is eligible for opens | built |
| `OFFER_RECEIVED` | Supplier | A bank submits an offer | built |
| `OFFER_ACCEPTED` | Bank | Its offer was selected | built |
| `OFFER_NOT_SELECTED` | Bank | Another offer was selected — and **nothing about which** | built |
| `SELECTION_REMINDER_50` / `_15` | Supplier | AS-02 selection window points | built |
| `CONTRACT_READY_FOR_SIGNATURE` | Both | Contract generated | built |

### Funding (Phase 7)

| Key | Recipient | Trigger | Status |
|---|---|---|---|
| `FUNDING_MARKED_SENT` | Supplier | Bank records the transfer | built |
| `FUNDING_CONFIRMATION_REMINDER` | Supplier | Halfway through the escalation window | built |
| `FUNDING_CONFIRMATION_ESCALATED` | Ops Admin | AS-04 — stalled past the window | built |
| `PAYOUT_COMPLETED` | Supplier | Settlement reaches `PAYOUT_COMPLETED` | Phase 9 |
| `PAYOUT_FAILED` | Bank, Ops | Settlement fails | Phase 9 |

The OTP itself is **not** a notification and never will be. It is returned once
in an API response and passed to the supplier out of band by the bank
(ZM-FND-005). A template that emailed it would defeat the control.

### Post-funding (Phase 8)

| Key | Recipient | Trigger | Status |
|---|---|---|---|
| `MATURITY_REMINDER_30` / `_14` / `_7` / `_0` | Supplier | Pre-maturity points | built |
| ⚠️ `PAYMENT_OVERDUE_UNCONFIRMED` | Supplier | Due date passed, no bank report | built |
| `RECOURSE_INITIATED` | Supplier | Bank opens a recourse claim | built |
| `RECOURSE_SUPPLIER_NOTIFIED` | Supplier | Claim progresses to notified | built |
| `FRAUD_REVIEW_OPENED` | Compliance | A fraud review freezes a transaction | built |
| ⚠️ `BUYER_PAYMENT_CONFIRMATION` | Buyer | Bank confirms payment (LT-14) | Phase 9 |

---

## ⚠️ The two constrained templates

### `PAYMENT_OVERDUE_UNCONFIRMED`

**Constraint:** must not assert that the buyer failed to pay.

The platform cannot see a buyer's bank account; only the funding bank can. A
due date passing is not evidence of anything except a date passing. This
message goes to a real Jordanian SME, and telling them their invoice is "in
default" on the strength of a calendar would be an accusation with nothing
behind it.

**Banned in the body:** "default", "defaulted", "failed to pay", "overdue"
as an assertion about the buyer's conduct. Tested in
`maturity.service.spec.ts` and again in the integration suite.

**Current EN body:**

> Invoice {{invoiceNumber}} passed its due date on {{dueDate}} and the bank has
> not yet reported whether the buyer paid. This is not a record of
> non-payment — it means we are waiting for the bank to confirm. No action is
> needed from you.

### `BUYER_PAYMENT_CONFIRMATION` (LT-14)

**Constraint:** operational only. Not a demand for payment, not a legal notice,
and not an assertion of any obligation between the buyer and the platform.

The buyer never contracted with Zimmamless. They owe the supplier, and after
assignment they pay the bank. A message from a platform they have no
relationship with, phrased as a demand, would be both legally unfounded and a
good way to damage the supplier's commercial relationship with its own
customer.

**Wording to be ratified by the PO before Phase 9 sends it.** Draft posture:
state that a payment was recorded, name the invoice, name nothing about
amounts owing, and give the supplier's contact rather than the platform's as
the route for questions.

---

## Open items

- `PAYOUT_COMPLETED` / `PAYOUT_FAILED` templates are named here but sent from
  Phase 9; Phase 7 records the settlement without notifying.
- Arabic bodies exist for the built keys as literal text inside the sending
  services, not yet as `notification_templates` rows. Phase 9's seed populates
  the table so the rendering path is exercised end to end; until then a
  missing template degrades to the caller's literal text, which is the correct
  failure direction (the message goes out).
- `BUYER_PAYMENT_CONFIRMATION` wording needs PO sign-off (LT-14).
