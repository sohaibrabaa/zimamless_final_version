-- =====================================================================
-- ZIMMAMLESS V3 — MIGRATION 0002 (ADDITIVE AMENDMENT)
-- Approved by product owner 2026-07-22 (see docs/coordination/DECISIONS.md)
-- Applies AFTER migration 0001 (= 02_DATABASE_SCHEMA.sql with the ONE
-- modification noted in D-01 below). Nothing here alters an existing
-- column, constraint, or response shape.
-- =====================================================================

-- ---------------------------------------------------------------------
-- D-01 — Active-invoice fingerprint uniqueness (replaces the invalid
-- partial index in the frozen file).
--
-- IMPORTANT FOR MIGRATION 0001: the frozen schema's statement
--   CREATE UNIQUE INDEX uq_active_invoice_fingerprint ON invoices (fingerprint)
--     WHERE transaction_id IN (SELECT ...)
-- is invalid PostgreSQL (subqueries are not allowed in index predicates)
-- and MUST BE OMITTED when creating migration 0001. This section provides
-- the behaviour-identical replacement (ZM-VER-001, ZM-CON-017).
-- ---------------------------------------------------------------------

ALTER TABLE invoices
  ADD COLUMN is_active_fingerprint boolean NOT NULL DEFAULT true;

-- keep the flag in sync with the owning transaction's state
CREATE OR REPLACE FUNCTION sync_invoice_fingerprint_active() RETURNS trigger AS $$
BEGIN
  UPDATE invoices
     SET is_active_fingerprint = (NEW.state NOT IN ('REJECTED','CANCELLED','CLOSED'))
   WHERE transaction_id = NEW.id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sync_invoice_fingerprint_active
  AFTER UPDATE OF state ON receivable_transactions
  FOR EACH ROW
  WHEN (OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION sync_invoice_fingerprint_active();

-- new invoices attached to terminal transactions (edge case) get the right flag
CREATE OR REPLACE FUNCTION init_invoice_fingerprint_active() RETURNS trigger AS $$
BEGIN
  SELECT (state NOT IN ('REJECTED','CANCELLED','CLOSED'))
    INTO NEW.is_active_fingerprint
    FROM receivable_transactions WHERE id = NEW.transaction_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_init_invoice_fingerprint_active
  BEFORE INSERT ON invoices
  FOR EACH ROW
  EXECUTE FUNCTION init_invoice_fingerprint_active();

-- the replacement for the invalid index — identical semantics
CREATE UNIQUE INDEX uq_active_invoice_fingerprint
  ON invoices (fingerprint)
  WHERE is_active_fingerprint;

-- ---------------------------------------------------------------------
-- D-02 — The supplier's private floor must be unreadable to direct-SQL
-- clients (INV-8 / ZM-MKT-012 at the RLS layer).
--
-- Note: PostgreSQL column privileges do not subtract from a table-wide
-- GRANT, so we revoke table SELECT and re-grant an explicit column list
-- (every column EXCEPT minimum_acceptable_amount). Supplier/platform
-- reads of the floor go through the NestJS API (service role).
-- ---------------------------------------------------------------------

REVOKE SELECT ON receivable_transactions FROM authenticated;
REVOKE SELECT ON receivable_transactions FROM anon;

GRANT SELECT (
  id, reference_number, supplier_org_id, buyer_id, state,
  closure_reason, closure_notes, currency,
  locked_at, locked_by_offer_id, created_by, created_at, updated_at
) ON receivable_transactions TO authenticated;
-- (anon gets nothing.)

-- ---------------------------------------------------------------------
-- D-03 — Relisting requests (ZM-MKT-016, ZM-REC-017..019). Backs
-- /transactions/{id}/relist-request and /admin/relisting-requests.
-- ---------------------------------------------------------------------

CREATE TYPE relisting_request_status AS ENUM ('REQUESTED','UNDER_REVIEW','APPROVED','DENIED');

CREATE TABLE relisting_requests (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_id   uuid NOT NULL REFERENCES receivable_transactions(id),
  requested_by     uuid NOT NULL REFERENCES users(id),
  requested_at     timestamptz NOT NULL DEFAULT now(),
  status           relisting_request_status NOT NULL DEFAULT 'REQUESTED',
  -- ZM-REC-018 verification outcomes recorded before approval:
  -- { stillUnpaid, notFinanced, unchanged, stillValid, noFraudIndicator,
  --   supplierEligible, buyerEligible } each true|false|null
  verification     jsonb NOT NULL DEFAULT '{}',
  notes            text,
  decided_by       uuid REFERENCES users(id),
  decided_at       timestamptz,
  decision_notes   text
);

ALTER TABLE relisting_requests ENABLE ROW LEVEL SECURITY;
-- policies: Agent A applies the standard tenant pattern
-- (supplier sees own; platform sees all; banks see none).

-- at most one open request per transaction
CREATE UNIQUE INDEX uq_open_relisting_request
  ON relisting_requests (transaction_id)
  WHERE status IN ('REQUESTED','UNDER_REVIEW');

-- ---------------------------------------------------------------------
-- Webhook/event dedup store (ZM-NFR-007) — adapter-swap readiness.
-- ---------------------------------------------------------------------

CREATE TABLE webhook_events (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider_name      text NOT NULL,
  provider_event_id  text NOT NULL,
  event_type         text NOT NULL,
  payload            jsonb NOT NULL,
  processed          boolean NOT NULL DEFAULT false,
  processed_at       timestamptz,
  received_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_name, provider_event_id)
);

-- ---------------------------------------------------------------------
-- D-14 — configurable-policy settings keys referenced by LT-11 / LT-12.
-- ---------------------------------------------------------------------

INSERT INTO platform_settings (key, value, description) VALUES
  ('withdrawal_penalty_policy',
   '{"BANK_COMMERCIAL_DECISION":{"applicable":true,"flatAmount":"500.000"},"SUPPLIER_MISREPRESENTATION":{"applicable":false},"FRAUD_DISCOVERED":{"applicable":false},"INVOICE_CHANGED":{"applicable":null},"CONDITION_NOT_MET":{"applicable":null},"TECHNICAL_FAILURE":{"applicable":null},"OTHER":{"applicable":null}}',
   'Default penalty treatment per withdrawal reason; null = manual review (LT-12: recorded, never auto-deducted)'),
  ('commission_refund_on_recourse', '"NONE"',
   'LT-11 assumption: no automatic refund; any adjustment is a compensating ledger entry'),
  ('relisting_fee_policy', '"CHARGE_PER_ROUND"',
   'ZM-MKT-017: whether each relisting round incurs a new listing fee')
ON CONFLICT (key) DO NOTHING;

-- =====================================================================
-- End of migration 0002.
-- =====================================================================
