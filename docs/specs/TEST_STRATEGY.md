# Test Strategy — Backend

**Owner:** Agent A · **Status:** living (started Phase 1, grows each phase)
**Source:** Master Plan Part 5, expanded into suites and CI wiring.

---

## 1. Principle

Three properties in this system are **absence** properties — the supplier's
floor never reaching a bank, a bank never seeing a competitor, government
silence never lowering a score. Absence cannot be demonstrated by using the
feature; it has to be attacked deliberately, from the layer an attacker
would use. That shapes everything below:

- confidentiality is tested **at the database**, not through the API
- the floor is tested by **byte-scanning responses**, not by reading DTOs
- the availability rule is tested with **paired fixtures**, not one run

## 2. Suites

| Suite | Command | Needs DB | Runs |
|---|---|---|---|
| Unit | `npm run test` | no | every push, every PR |
| Frozen-schema check | `node db/tools/build-0001.mjs --check` | no | every push |
| Contract conformance | `node scripts/contract-conformance.mjs …` | no | every push |
| Schema verification | `npm run db:verify` | yes | after every migration |
| RLS personas | `npm run test:rls -w @zimmamless/api` | yes | every push touching api/db |
| Concurrency (INV-1) | Phase 6 | yes | on merge + nightly |
| Sentinel scan (INV-8) | Phase 5 | yes | on merge + nightly |
| Playwright demo path | Agent B, Phase 5 onward | yes | nightly |

## 3. What Phase 1 delivers

**40 unit tests**, all green:

- `Money` (25) — float-error cases, the `numeric(18,3)` ceiling, trailing
  zeros, HALF_UP at the half case, the INV-2 boundary, JSON serializing as a
  string, and the rejection of JavaScript numbers at construction.
- `AuthGuard` (15) — the 403 semantics of cross-cutting rule 1, including
  that a malformed org id and a non-member org are **indistinguishable** to
  the caller, and that roles resolve per-membership rather than globally.

**RLS persona suite** — written, and blocked only on a reachable database.
It covers INV-11 (cross-bank invisibility including the `count(*)` inference
path), the D-02 floor revoke from *both* banks and the owning supplier,
`otp_hash` and `bank_internal_notes`, supplier-to-supplier isolation, and
the refusal of all direct-SQL writes.

**Schema verification** — 13 checks asserting the database *is* what the API
expects rather than that a migration exited 0.

## 4. The RLS suite bypasses NestJS entirely

ZM-ARC-005 is explicit that a policy passing only because NestJS filtered
first is a defect. `test/helpers/persona-db.ts` connects to Postgres, sets
the `request.jwt.claims` GUC that PostgREST would set from a bearer token,
and switches to the `authenticated` role — the same path a Supabase client
takes. Each query runs in a transaction that is always rolled back, so no
test can leave state for the next.

Column revokes are asserted as **permission errors**, not as zero rows:
"zero rows" is also what an empty table returns, which would make the test
pass on a database where the column was never protected at all.

CI runs this against plain Postgres via `db/ci/000_supabase_compat.sql`, so
the most security-critical tests in the build never depend on network access
or shared state.

## 5. Invariant coverage

Each invariant gets a named test **in the phase that implements it** — not
deferred to Phase 9.

| Inv | Status | Where |
|---|---|---|
| INV-8 (floor absent) | **partial** — D-02 RLS layer proven; serializer + sentinel scan land with the first bank-facing payload | Phase 1 / Phase 5 |
| INV-11 (cross-bank) | **partial** — policies proven on empty tables; re-run with real offers | Phase 1 / Phase 5 |
| INV-7 (no hard delete) | **partial** — append-only rules and write revokes verified | Phase 1 |
| INV-1,2,3,4 | not started | Phase 6 |
| INV-5,6,10,13 | not started | Phase 7 |
| INV-9 | not started | Phase 4 |
| INV-12 | not started | Phase 5 |

"Partial" is deliberate wording: the policies are proven correct, but a
policy proven correct against an **empty table** has only been proven not to
crash. Each must be re-run once the phase that creates the rows lands. That
re-run is listed in the Phase 5 and 6 task lists, not left to memory.

## 6. Money precision

- ESLint bans `parseFloat`, `Number()`, and arithmetic operators on
  money-typed values in `apps/api`.
- `Money.from()` throws on a JavaScript number, so the ban is not merely
  cosmetic.
- Every serialized money field must match `^-?\d+\.\d{3}$`.
- Round-trip through Postgres `numeric(18,3)` for `0.001`,
  `999999999999999.999`, and `1250.000` (no trailing-zero loss).
- Rounding is HALF_UP at 3 dp, defined once and asserted identically in
  commission calculation, offer validation, and the settlement split.

## 7. CI gates

| Job | Fails the build on |
|---|---|
| `static` | lint (incl. both bans), typecheck, or a failing unit test |
| `frozen-schema` | migration `0001` diverging from the frozen schema, or `0002` from the approved amendment |
| `contract` | a served path absent from the contract + overlay, or a wrong verb |
| `database` | migrations not applying, `db:verify` failing, or any RLS persona test failing |
| `migrations-rerun` | migrations or the seed not being idempotent |

Contract conformance reports **missing** paths as progress (3/82 in Phase 1)
and fails only on **extra** ones — an endpoint Agent B cannot generate a
client for. From Phase 9 it runs with `--strict`, where missing paths fail
too.

## 8. Deliberately not yet covered

Stated plainly so it is not mistaken for coverage:

- No e2e HTTP test of the four live endpoints — needs a reachable database.
- The RLS suite has never executed. It is written against the seeded persona
  ids and unverified until a database is reachable.
- No load or performance testing (p95 < 2s is a Phase 9 target).
- No test asserting the service-role key is absent from client bundles —
  belongs with Agent B's build.
