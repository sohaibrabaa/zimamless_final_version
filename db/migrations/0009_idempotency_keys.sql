-- =====================================================================
-- 0009 — Idempotency keys
-- =====================================================================
-- Additive only: one new table, its RLS, and its grants. No existing
-- column, constraint, or response shape is touched.
--
-- The frozen contract (global rule 4) says every POST that moves money or
-- changes financial state "requires an `Idempotency-Key` header", and the
-- OpenAPI marks the parameter `required: true` on `/offers/{id}/accept`,
-- funding execute/confirm, settlement retry, buyer-payment, and recourse
-- repay. Until now the header was allowed through CORS and then ignored —
-- advertised but inert. This table is what makes it real: a request that
-- carries a key is recorded here, and a replay of that key returns the first
-- response instead of executing again.
--
-- Note this is a SECOND, header-level line of defence, not the only one. The
-- acceptance path is already atomic at the row level (INV-1) and dedupes on
-- the `offer_selections` unique key, so a double-accept was never going to
-- pay twice even before this existed. What the header adds is a stable,
-- client-observable "same request → same response" contract across every
-- money-moving endpoint, and a claim row that lets a concurrent duplicate be
-- recognized while the first is still in flight.
--
-- Scope is (organization_id, idempotency_key): a key is unique within the org
-- that presented it, never globally, so two organizations choosing the same
-- opaque string do not collide.
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS idempotency_keys (
  organization_id  uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  idempotency_key  text        NOT NULL,
  -- The request this key was first used for. A key replayed against a
  -- *different* request (method, path, or body) is a client error, not a
  -- replay, and `request_hash` is how that is told apart.
  request_method   text        NOT NULL,
  request_path     text        NOT NULL,
  request_hash     text        NOT NULL,
  -- Null while the first request is still executing (the claim), populated
  -- when it completes. A concurrent duplicate that finds `in_progress` knows
  -- the original has not finished yet.
  response_status  integer,
  response_body    jsonb,
  in_progress      boolean     NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  PRIMARY KEY (organization_id, idempotency_key)
);

COMMENT ON TABLE idempotency_keys IS
  'Header-level idempotency for money/state-changing POSTs (contract global rule 4). '
  'One row per (organization, Idempotency-Key); a replay returns the stored response.';

-- Same posture as every other tenant table: RLS on, writes only through the
-- API's service role, nothing for anon. The policy exists so the table is
-- covered by the "every table has RLS and at least one policy" invariant and
-- so a future SELECT grant would already be scoped; the API itself reads and
-- writes this table over the service-role connection, which bypasses RLS.
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY idempotency_read ON idempotency_keys FOR SELECT USING (
  organization_id = ANY (current_user_org_ids()) OR current_user_is_platform()
);

REVOKE ALL ON idempotency_keys FROM anon, authenticated;

COMMIT;
