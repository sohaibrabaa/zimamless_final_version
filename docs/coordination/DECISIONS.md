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
