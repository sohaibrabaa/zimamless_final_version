# Open Questions (escalation queue — append-only)

Ambiguities the frozen documents don't resolve, awaiting product-owner ruling. Order of authority first: `03_API_CONTRACT.yaml` → `02_DATABASE_SCHEMA.sql` → `01_..REQUIREMENTS.md` → product owner.

Format:

```
## Q-<seq> — <short title>
Raised by: Agent A|B, <date>, blocking: <phase/task or "not blocking">
Question: <what is ambiguous, with document references>
Options considered: <1..n>
Recommendation: <the agent's preferred answer>
Needed by: <date/phase>
Status: OPEN | RULED (see DECISIONS.md D-ref)
```

Rules: raising a question means you STOP that thread and switch tasks — never work around it. Rulings land in `DECISIONS.md`; update the Status line here to point at them.

---

## Q-01 / D-15 — `citext` is used by the frozen schema but never enabled; the file does not execute
Raised by: Agent A, 2026-07-22, blocking: Phase 1 migration 0001 (worked around additively — see below)
Question: `docs/02_DATABASE_SCHEMA.sql` declares three columns as `citext` (`users.email` L112, `organizations.contact_email` L133, `supplier_buyer_relationships.contact_email` L318) but its extension block (L14-15) creates only `uuid-ossp` and `pgcrypto`. `citext` is **not** enabled by default on Supabase, so the frozen file aborts at its first `CREATE TABLE` with `ERROR: type "citext" does not exist`. This is the same class of defect as D-01 — the schema does not load as written — but Master Plan Part 7 did not catch it and no ruling covers it.
Options considered:
1. Add `CREATE EXTENSION IF NOT EXISTS citext;` to a **prerequisite migration `0000`** that runs before `0001`. Frozen file untouched; `0001` stays byte-faithful; purely additive (no column, constraint, or response shape altered), which the pack permits without a ruling.
2. Amend the frozen file's extension block (L14-15) to include `citext` and regenerate `0001`. Cleanest to read, but edits a frozen file — needs a ruling and a schema version bump.
3. Change the three columns to `text` with a lower-case functional unique index. Rejected: alters frozen column types and case-insensitive comparison semantics platform-wide.
Recommendation: **Option 1**, already implemented as `db/migrations/0000_prerequisites.sql` on the grounds that it is additive and therefore pre-authorised. Ratify it as a ruling (or direct me to Option 2) so the disposition is recorded rather than inferred. Work was not blocked and no frozen file was touched.
Needed by: before the hosted migration run is treated as final (cheap to switch either way).
Status: OPEN

## Q-02 — RLS coverage in the frozen schema is 8 tables of 59, with zero GRANTs
Raised by: Agent A, 2026-07-22, blocking: not blocking (Phase 1 task, additive)
Question: The frozen schema enables RLS on 8 tables, writes 2 policies, and issues no `GRANT`/`REVOKE` at all. On hosted Supabase the default privileges grant `anon`/`authenticated` full table access, so the **51 tables with no RLS are readable and writable by any authenticated user** through the Supabase client API — including `users` (emails, phone numbers), `bank_policy_filters`, `bank_eligibility`, `funding_otps` (`otp_hash`), `accepted_offer_snapshots` (competitor amounts), `commission_calculations`, `ledger_entries`, and `audit_logs`. Separately, 6 tables have RLS **enabled with no policy** (`invoices`, `listings`, `documents`, `settlements`, `buyer_payments`, `supplier_buyer_relationships`), making them deny-all. D-02 closes one column on one table while this is open. The schema anticipates the gap ("Every tenant table gets RLS. Pattern shown; apply to all.") and Phase 1 assigns me the completion, so this is a **notice, not a request** — but it is a materially larger hole than Part 7 implies and the product owner should know it exists.
Options considered: n/a — completing the policy set is an assigned Phase 1 task and is additive.
Recommendation: No ruling needed. Implemented in `db/migrations/0003_rls_policies.sql`: deny-by-default posture (revoke all writes and `anon` reads across `public`), per-table SELECT policies for every tenant table, column-level revokes on `funding_otps.otp_hash` and `buyer_payments.bank_internal_notes` (ZM-PMT-018) following the D-02 pattern, and a coverage checklist in `docs/specs/ARCHITECTURE.md` enforced by a CI test that fails when a new table appears without a policy entry.
Needed by: n/a
Status: OPEN (informational)

## Q-03 — Which digit set does Arabic use for money amounts?
Raised by: Phase 1 unification session, 2026-07-23, blocking: not blocking (current behaviour preserved)
Question: `ZM-I18N-004` requires dates, numbers, and currency to be "localized", and mandates JOD with three decimal places — but it does not say whether the Arabic locale renders amounts in Western digits (1,250.000) or Arabic-Indic digits (١٬٢٥٠٫٠٠٠). `apps/web/lib/money.ts` currently formats with `en-US` grouping in both locales. That was not a decision so much as a leftover: the code contained a dead ternary (`numeralLocale === "ar-JO" ? "en-US" : "en-US"`) whose two branches were identical, so the Arabic branch had never actually been reachable.
Options considered:
1. Western digits in both locales (current behaviour). Consistent with IBANs, establishment numbers and invoice references, which are Latin-numeric everywhere in the product; avoids bidi complications when an amount sits inside Arabic prose (ZM-I18N-006).
2. Arabic-Indic digits when `locale === "ar"`. More faithfully "localized", but changes every amount on every Arabic screen and in generated Arabic documents, and interacts with the contract's canonical-English rule (ZM-I18N-003b).
Recommendation: **Option 1**, i.e. ratify what ships today, on the grounds that money strings are compared against contract and ledger values that are Latin-numeric everywhere else. The dead branch has been removed and the choice is now stated explicitly in `lib/money.ts` with a pointer here. Cheap to reverse — one `Intl.NumberFormat` locale argument — until Arabic contract/notification templates are written in Phase 6+.
Needed by: before Arabic document templates are authored (Phase 6), after which the choice is baked into rendered PDFs.
Status: OPEN

## Q-04 — `POST /auth/context` returns a response body the contract does not declare
Raised by: Phase 1 unification session, 2026-07-23, blocking: not blocking
Question: The frozen contract declares `POST /auth/context` → `200 { description: Context switched }` with **no content**. The implementation (`apps/api/src/modules/auth/auth.controller.ts`) returns `{ organizationId }`. Because the contract declares no schema, `openapi-typescript` generates `content?: never`, so Agent B's typed client cannot read the field without casting past its own types — the body is invisible to the consumer it was presumably added for. This is undeclared-but-harmless drift rather than a defect: nothing breaks, but the two documents disagree, and the new status-code check in the conformance gate does not compare response *bodies*.
Options considered:
1. Drop the body; return an empty 200. Matches the contract exactly, costs nothing — the client already re-reads context from `/auth/me`, and the accepted id is the id it just sent.
2. Amend the overlay to declare the body. Makes the field usable and typed, but is a contract amendment needing a ruling for a field with no established consumer.
3. Leave as is. Rejected: an undeclared body is exactly the silent divergence the conformance gate exists to prevent, and it teaches that the contract is approximate.
Recommendation: **Option 1** unless a consumer for the field is identified. The web client has been written not to depend on it either way (`SessionProvider.switchOrganization` uses the requested id), so this can be settled without blocking anyone. Worth noting the gate compares paths, verbs, and now success status codes — but not response schemas; extending it to bodies is the durable fix and is a candidate for Phase 5, when payloads start carrying money.
Needed by: before Phase 5, when response-shape drift starts to matter financially.
Status: OPEN
