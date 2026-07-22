# Zimmamless V3 — Start Here

**Read this first.** It explains what Zimmamless is, what these files are, and how two parallel agents work without colliding.

---

## 1. The product in one paragraph

Zimmamless is a digital receivables marketplace in Jordan. A **supplier** holding an unpaid commercial invoice lists it; **banks** submit competing offers to advance funds against it; the supplier picks one; a contract is signed; the bank funds; Zimmamless deducts its commission during settlement and pays the supplier the net. The **buyer** — the company that owes the invoice — is never a platform user. They are resolved against the companies registry, stored as a debtor record, and notified after the fact. They pay the bank directly at maturity, outside the platform. Zimmamless keeps tracking the receivable through payment, overdue, recourse, and closure, but never lends, never guarantees, never collects, and never adjudicates.

## 2. Five things that make this system unusual

Understanding these prevents most design mistakes.

**It is not an auction.** Banks cannot see each other. No live bidding, no visible competing prices, no automatic winner. The supplier alone compares offers, privately.

**The supplier's floor is secret.** The supplier sets a `minimumAcceptableAmount` — a minimum **net** payout. Banks never see it. If an offer falls below it, the rejection message reveals nothing about the gap.

**The highest offer is not the winner.** The supplier weighs transaction type, recourse type, conditions, and timing against the amount. The system must never sort by amount, mark an offer "best", or auto-select.

**Missing government data is not bad news.** If a registry is down or doesn't publish a field, that reduces a separate *data availability* measure — it must never reduce the risk score. "The source said something adverse" and "the source didn't answer" are structurally different everywhere in the system.

**Funding requires both parties.** The bank marks funding sent and generates an OTP; the supplier enters it. Only OTP verification *plus* settlement evidence produces `FUNDED`. A bank cannot unilaterally declare a transaction funded.

## 3. The files

| File | What it is | Who reads it |
|---|---|---|
| `00_START_HERE.md` | This file | Everyone |
| `01_ZIMMAMLESS_V3_REQUIREMENTS.md` | Full product definition — 288 numbered requirements, state machines, legal register | Everyone |
| `02_DATABASE_SCHEMA.sql` | **FROZEN** — complete PostgreSQL schema, constraints, RLS | Agent A |
| `03_API_CONTRACT.yaml` | **FROZEN** — OpenAPI 3.1 spec; the seam between agents | Both |
| `04_AGENT_A_BACKEND_BRIEF.md` | Backend scope, build order, invariants | Agent A |
| `05_AGENT_B_FRONTEND_BRIEF.md` | Frontend scope, build order, UI rules | Agent B |

## 4. Why two files are frozen

Two agents building in parallel will diverge unless something holds them together. The schema and the API contract are that something.

- **Agent A** implements the API contract.
- **Agent B** consumes it, generating a typed client and mocks from the same file.

Neither may change either file unilaterally. If one is wrong, the agent **stops and raises it** rather than working around it. A silent change on one side breaks the other side's work, silently, and you won't find out until integration.

Additive backend migrations that don't touch existing columns, constraints, or response shapes are fine. Everything else needs approval.

## 5. Sequencing — this part matters

**Auth, organizations, and multi-org context are foundational.** Nearly every other module depends on them. They must be built **once, by Agent A, before parallel work begins in earnest.** Agent B can build the design system and static shells during this window, but cannot wire real data until Phase 1 lands.

Recommended:

```
Week 1        Agent A: Phase 1 foundation (auth, org context, RLS, audit)
              Agent B: design system, i18n scaffolding, RTL, static shells
              ── integration checkpoint: /auth/me works end to end ──

Week 2+       Agent A: Phases 2-9 in order
              Agent B: Phases 2-9 against mocks, swapping to live endpoints
                       as Agent A announces them
              ── daily: A posts endpoints now live; B posts contract gaps ──
```

**What genuinely parallelizes:** onboarding, buyer resolution, invoice submission, marketplace, offers, contracts, funding, cases. Agent B builds each screen against mocks while Agent A builds the endpoint.

**What does not:** anything before auth exists.

## 6. Highest-risk code in the system

Flag these for extra review regardless of which agent touches them.

| Risk | Where | Why |
|---|---|---|
| **Atomic offer acceptance** | Backend, selection module | Concurrent accepts must yield exactly one winner. Get this wrong and an invoice is double-financed. |
| **Floor leakage** | Both sides | The supplier's minimum must never reach a bank — not in a response, not in an error, not in a hidden field. |
| **Cross-bank visibility** | Both sides | Bank A seeing Bank B's offer destroys the product's core promise. Test at the RLS layer, not just the API. |
| **Money precision** | Both sides | Float arithmetic on money is a defect, always. Decimal strings end to end. |
| **Commission timing** | Backend, fees module | Finalized only on completed payout. Not on acceptance, not on signature, not on funding initiation. |
| **Ledger balance** | Backend, fees module | Journals must balance. Reversals are compensating entries, never edits or deletes. |
| **Double payout** | Backend, funding module | Retries must be idempotent. A retried settlement paying twice is the worst possible bug here. |

## 7. Legal status

Nothing legal is settled. Every legal, regulatory, licensing, contractual, privacy, or enforceability question is tagged `LEGAL_TBD_POST_COMPETITION` and listed in Appendix A of the requirements, with the interim technical assumption stated.

**This does not block building.** It shapes *how* you build: legal rules live in configurable policies, provider adapters, versioned templates, and enums — never hard-coded. When the lawyers rule, the system changes by configuration, not redesign.

Two items could alter the operating model rather than just the paperwork, and should be raised with specialists first: **LT-10** (whether routing funds through the platform needs a CBJ payment licence) and **LT-13** (AML obligations).

## 8. Environment

| Layer | Technology |
|---|---|
| Frontend | Next.js, React, TypeScript — responsive, bilingual EN/AR, full RTL |
| Backend | Node.js with NestJS; REST with OpenAPI |
| Database | Supabase PostgreSQL |
| Auth | Supabase Auth |
| Storage | Supabase Storage, private buckets |
| OCR/ML | Python with FastAPI |
| Integrations | Adapter pattern — dummy now, production later |

Hosting: Vercel (web); Render/Railway/Fly.io (services); Supabase (data, auth, storage).

**No native mobile app.** Responsive web only.

All external integrations use dummy adapters in this release — but **every internal workflow must genuinely work.** The demo is not a mockup.

## 9. Demo requirements

Seed 3 banks, 3 suppliers, 6 buyers, 12 invoices, and users for every role. Cover eleven scenarios: successful funding, competing offers, information required, duplicate invoice, fraud review, failed payout, full payment, partial payment, overdue, recourse, bank withdrawal.

A **demo time machine** advances the simulated clock so maturity, overdue, and recourse can be demonstrated live. It must be guarded server-side by environment configuration — hiding the UI is not sufficient.

## 10. When something is unclear

The order of authority:

1. `03_API_CONTRACT.yaml` — for anything about request/response shape
2. `02_DATABASE_SCHEMA.sql` — for anything about data structure and constraints
3. `01_ZIMMAMLESS_V3_REQUIREMENTS.md` — for anything about behaviour and rules
4. The product owner — for anything the above three don't answer

Do not guess, and do not let the two sessions resolve an ambiguity independently. That is exactly how the two halves drift apart.
