# Daily Handoff Log (append-only)

One entry per agent per session, newest at the bottom. Format (Master Plan Part 3.3):

```
## <date> — Agent A (session <n>)
LIVE: <endpoints newly live>
CHANGED: <shared-surface changes — normally "none">
SEED: <seed changes B should know>
BLOCKED ON: <open questions / rulings>
NOTE FOR B: <behavioural notes>

## <date> — Agent B (session <n>)
DONE: <screens completed, mock|live>
SWAPPED TO LIVE: <endpoints promoted + smoke result>
CONTRACT GAPS FOUND: <items filed to OPEN_QUESTIONS.md>
NEEDS FROM A: <seed/behaviour requests>
```

Rules: append only; never edit the other agent's entries; answer the counterpart's NEEDS items in your next entry or escalate.

---

## 2026-07-22 — Agent A (session 1)
LIVE: none yet on a deployed URL. `GET /health`, `GET /auth/me`, `POST /auth/context`, `PATCH /auth/language` are implemented and serve locally; they move to LIVE in ENDPOINT_STATUS.md the moment the API is deployed (blocked, see below).
CHANGED: none. Frozen files untouched. Migration 0001 is generated from `docs/02_DATABASE_SCHEMA.sql` with only the ruled D-01 statement removed, and CI re-runs the generator with `--check` so any drift fails the build.
SEED: `db/seed/0100_seed_dev.sql` — paste-and-run SQL, idempotent, fixed UUIDs. 6 orgs (1 platform, 2 suppliers, 3 banks), 15 users with working Supabase Auth logins, 16 memberships, 20 role grants, 6 buyers. Password for every account: `Zimmamless#2026`. Identity list is `docs/specs/GOV_DUMMY_DATA.md` — **please mirror those exact names and numbers in your MSW fixtures** so the mock→live swap is visually diffable.
BLOCKED ON: (1) a reachable `DATABASE_URL` — the project's direct host resolves to IPv6 only and this machine has no IPv6 route, so the session pooler string is needed; nothing DB-dependent has executed yet. (2) D-15 ratification in DECISIONS.md (see OPEN_QUESTIONS Q-01) — worked around additively, not blocking.
NOTE FOR B:
  - Three seeded accounts you will want first: `owner@alnoor.zimmamless.test` (supplier), `maker@jnb.zimmamless.test` (bank), `admin@platform.zimmamless.test` (platform).
  - `multi@platform.zimmamless.test` holds memberships in TWO orgs — it exists specifically so the org-context switcher is testable. Single-org users can only exercise the failure path.
  - Banks K1 and K2 both have a maker AND a separate approver. ZM-ROL-002 is a DB CHECK, so self-approval is rejected by the database, not just the service — your UI block is a third layer, not the only one.
  - Buyers B4/B5/B6 are seeded `SUSPENDED`/`STRUCK_OFF`/`UNDER_LIQUIDATION` so you can build the block-state screens now rather than waiting for Phase 3.
  - `X-Organization-Id` is required on every request except `/onboarding/register`. Missing header, malformed uuid, and non-member org all return the SAME 403 by design — do not branch on the difference, there deliberately isn't one.
  - `GET /health` is NOT in the frozen contract. It is served outside the `/v1` prefix and excluded from `/docs-json`, so your generated client will not contain it. That is intentional, not a gap.
  - Error envelope matches the contract `Error` schema and always carries `correlationId`; the same id comes back in the `X-Correlation-Id` response header. Surfacing it in your error UI makes support tractable.
  - `/auth/me` will include the optional `demo` block (D-10) only when the time machine is enabled server-side; it is absent in production. Gate the time-machine control on its presence.
