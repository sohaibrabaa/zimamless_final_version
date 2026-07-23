# Decisions Log (product-owner rulings — binding addenda to the frozen pack)

Both agents treat entries here as authoritative additions to `02_DATABASE_SCHEMA.sql`, `03_API_CONTRACT.yaml`, and the requirements. Only the product owner adds rulings; agents may draft proposals below the line for approval.

Format:

```
## <date> — RULING <ref>
Subject: <D-xx defect | Q-xx question | PA-xx assumption | PHASE_<n> CLOSED>
Ruling: <the decision>
Consequence: <amendment file / migration / behaviour>
```

## 2026-07-22 — RULING D-01
Subject: Invalid partial index `uq_active_invoice_fingerprint` (frozen schema does not execute).
Ruling: **APPROVED as proposed.** Migration 0001 = frozen schema with that one statement omitted; the behaviour-identical replacement (trigger-maintained `invoices.is_active_fingerprint` + partial unique index) ships in migration 0002.
Consequence: `docs/amendments/DB_MIGRATION_0002_ADDITIVE.sql` §D-01.

## 2026-07-22 — RULING D-02
Subject: RLS row-grant exposes `minimum_acceptable_amount` to eligible banks via direct SQL.
Ruling: **APPROVED as proposed.** Table-wide SELECT revoked from `authenticated`/`anon`; explicit column-list grant excluding the floor; supplier/platform floor reads go through the NestJS API (service role).
Consequence: `docs/amendments/DB_MIGRATION_0002_ADDITIVE.sql` §D-02; INV-8 RLS test required (Test Strategy 5.4).

## 2026-07-22 — RULING D-03..D-12 (API Amendment v3.1.0)
Subject: Additive endpoints for relisting, bootstrap, application list, listing links, offer collection, case management, notifications, demo flag, policy-filter edit, cancellation.
Ruling: **APPROVED as proposed.** Contract version becomes 3.1.0 = frozen 3.0.0 + overlay. Agent A implements the overlay paths exactly (including the two suffixed paths `/onboarding/applications-list` and `/transactions/{id}/listing-current`); Agent B generates its client from base + overlay. `/docs-json` conformance gate diffs against the merged contract.
Consequence: `docs/amendments/API_v3.1.0_OVERLAY.yaml` + `DB_MIGRATION_0002_ADDITIVE.sql` (relisting_requests, webhook_events, settings keys).

## 2026-07-22 — RULING D-13 / PA-06
Subject: Invoice CHECK constraints vs. post-funding repayment.
Ruling: **RATIFIED.** Post-funding outstanding balance is derived from `buyer_payments` (snapshot outstanding − Σ payments); `invoices.paid_amount`/`outstanding_amount` freeze at listing and are never mutated after funding.

## 2026-07-22 — RULING PA-01..PA-09
Subject: Master Plan Part 0 standing assumptions.
Ruling: **ALL CONFIRMED as written** — bank onboarding seed-only (PA-01); user/role management seed-only (PA-02); reports as client-side aggregates (PA-03); Supabase-direct registration with lazy user sync (PA-04); TimeProvider from day one (PA-05); derived balances (PA-06); Vercel+Render+Supabase with scripted local fallback (PA-07); synthetic-data ML per design (PA-08); HTML contract documents with hash, PDF as Phase 9 nice-to-have (PA-09).

## 2026-07-22 — NOTE D-14
Subject: Minor inconsistencies (OTP default status, Money regex allowing negatives, 401-for-bad-OTP, settings keys).
Ruling: Acknowledged; no schema/API change. Settings keys added in migration 0002. Frontend branches on error `code`, not HTTP status, for OTP failures.

---

## 2026-07-23 — RULING D-16 (Q-17)
Subject: `ZM-NOT-007` requires a manual call record with its recording user and outcome; `notifications.manual_call_notes`/`manual_call_by` exist in the frozen schema, `MANUAL_CALL` is a channel enum member, and no path in `03_API_CONTRACT.yaml` or the v3.1.0 overlay can write them. The requirement had storage and no input.
Ruling: **APPROVED — Option 1 of Q-17.** Additive `POST /notifications/{id}/manual-call` taking `{ notes }`, restricted to platform staff. Deliberately **not** folded into `POST /notifications/{id}/read`: a recipient opening their inbox and an operator attesting to a phone conversation are different claims by different people, and one route would let the first write the second.
Consequence: `docs/amendments/API_v3.1.0_OVERLAY.yaml` gains the path; `NotificationsService.recordManualCall()` (already built and audited) becomes reachable. The previous notes are retained in the audit entry's `previousValue` — the column holds one value, so a second operator's call would otherwise overwrite a colleague's account of a conversation with no trace, which is a hard delete of evidence (INV-7). `docs/specs/NOTIFICATIONS.md` moves ZM-NOT-007 from *partially met* to met.

## 2026-07-23 — RULINGS D-17..D-20 (Phase 9 kickoff)
Subject: The four product-owner decisions the Phase 9 prompt required raising at the start.
Ruling:
- **D-17 (Q-03):** Money renders in **Western digits** (1,250.000) in both locales. Ratifies current `lib/money.ts` behaviour; consistent with IBANs, establishment numbers and invoice references, which are Latin-numeric everywhere. Arabic notification/contract templates seeded in 9.3 use Western digits for amounts.
- **D-18 (Q-16):** A stalled funding confirmation **escalates through `notifications`** (a row to the ops admin + audit entry), not a new `admin_tasks` table. The interim behaviour from Phase 7 is ratified as the final one. No new table or endpoint.
- **D-19 (LT-14):** `BUYER_PAYMENT_CONFIRMATION` stays **catalogued but not sent**. The buyer never contracted with Zimmamless; a message from the platform risks reading as a demand. The template remains defined in `docs/specs/NOTIFICATIONS.md`; nothing dispatches it.
- **D-20 (dedupe):** Run `db/tools/dedupe-organizations.mjs --apply` **before** the Phase 9 demo seed, so the demo starts from a clean org set. Dry run was clean; affects no test or demo path.
Consequence: Q-03, Q-16 marked RULED in OPEN_QUESTIONS.md. `lib/money.ts` keeps Western formatting (already the case). Phase 9 seed writes Western-digit Arabic templates. No `admin_tasks`. No buyer dispatch. Dedupe applied ahead of the seed.

## 2026-07-23 — RULING D-21 (Phase 9 — notification senders route through the engine)
Subject: `NotificationsService.send()` — the only code that reads `notification_templates`, honours `users.preferred_language`, records `template_version` and dispatches through a channel adapter — had **zero callers**. All eight senders (maturity, listings, acceptance, funding, funding-deadlines ×2, recourse, fraud, listing-deadlines) wrote `INSERT INTO notifications` directly with hardcoded English and `language='EN'`. Seeding the bilingual catalogue (9.3) would have been decorative: nothing read the table, and an Arabic-preferring user got English regardless — making 9.5's Arabic pass impossible for notifications.
Ruling: **Retrofit the senders through `send()`**, passing the previous literal text as `fallbackSubject`/`fallbackBody` (behaviour-identical when no template row exists, the degrade direction ZM-NOT-004 requires) and the interpolated values as `variables`. In-platform rows now record `SENT` with a provider reference instead of resting at `QUEUED` — the catalogue's documented semantics for `IN_PLATFORM`. Also under this ruling: `OFFER_RECEIVED` (catalogued as built; no code sent it) is now sent to the supplier at offer **approval** — not creation, which is the bank's internal state — naming no bank and no amount.
Consequence: First real execution of `send()` exposed a dormant defect — `recipient()` selected `users.language`, a column that does not exist (`preferred_language` is the schema's name); fixed. The two constrained bodies (`PAYMENT_OVERDUE_UNCONFIRMED`, `OFFER_NOT_SELECTED`) carry their constraints into both languages; the not-selected template takes no placeholders at all so no future edit can leak competitive information through one. `docs/specs/NOTIFICATIONS.md` catalogue keys aligned to the code's names (`LISTING_AVAILABLE`, `OFFER_SELECTED`) — the database already carries them, and renaming a `template_key` retroactively would orphan every notification row written under it.
