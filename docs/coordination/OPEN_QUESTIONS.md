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
