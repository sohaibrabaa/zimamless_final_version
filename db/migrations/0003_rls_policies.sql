-- =====================================================================
-- MIGRATION 0003 — RLS POLICY COMPLETION + PRIVILEGE BASELINE (additive)
-- =====================================================================
-- Assigned by PHASE_1_FOUNDATION_SHELL.md:
--   "RLS: helper functions from the schema + policies for EVERY tenant
--    table (schema shows the pattern for 8; complete the set)."
--
-- The frozen schema enables RLS on 8 of 59 tables, writes 2 policies, and
-- issues no GRANT/REVOKE. On hosted Supabase the default privileges grant
-- anon/authenticated full access to public tables, so the 51 tables without
-- RLS are readable AND writable by any authenticated user through the
-- Supabase client API. See OPEN_QUESTIONS.md Q-02.
--
-- Posture established here (ZM-ARC-003..005):
--   1. anon gets nothing in public.
--   2. authenticated gets SELECT only. All INSERT/UPDATE/DELETE/TRUNCATE
--      is revoked: every write goes through the NestJS API, which holds the
--      service-role key server-side (service_role has BYPASSRLS).
--   3. RLS is enabled on every table; each gets an explicit SELECT policy.
--      RLS-enabled with no policy = deny-all, which is the safe default for
--      anything added later without a policy.
--   4. Column-level revokes for secrets that survive row visibility
--      (D-02 floor, funding_otps.otp_hash, buyer_payments.bank_internal_notes).
--
-- ZM-ARC-005 / INV-11: these policies must hold on their own. A policy that
-- only works because NestJS filtered first is a defect. The rls.spec suite
-- connects to Postgres directly as each persona and bypasses NestJS entirely.
--
-- The 2 frozen policies (tx_read on receivable_transactions, offer_read on
-- bank_offers) are NOT redefined here — they are implemented verbatim by
-- 0001 and this migration builds around them.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. HELPER FUNCTIONS
--
-- SECURITY DEFINER so they bypass RLS on the tables they inspect. That is
-- deliberate and required: without it, a policy on table X that inspects
-- table Y would recurse through Y's own policy. They are STABLE (one
-- evaluation per statement) and take no user input beyond a row id.
--
-- The frozen schema's current_user_org_ids() and current_user_is_platform()
-- are defined in 0001 and reused as-is.
-- ---------------------------------------------------------------------

-- The platform users.id for the current Supabase auth principal.
CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid AS $$
  SELECT u.id FROM users u WHERE u.auth_user_id = auth.uid();
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Row visibility for a transaction, mirroring the frozen tx_read policy:
-- supplier that owns it, platform, or a bank marked ELIGIBLE on one of its
-- listings. Used by the transaction's satellite tables so they cannot be
-- more permissive than the aggregate root.
CREATE OR REPLACE FUNCTION app_can_see_tx(p_tx uuid) RETURNS boolean AS $$
  SELECT
    current_user_is_platform()
    OR EXISTS (
      SELECT 1 FROM receivable_transactions t
      WHERE t.id = p_tx AND t.supplier_org_id = ANY (current_user_org_ids())
    )
    OR EXISTS (
      SELECT 1 FROM listings l
      JOIN bank_eligibility be ON be.listing_id = l.id
      WHERE l.transaction_id = p_tx
        AND be.bank_org_id = ANY (current_user_org_ids())
        AND be.status = 'ELIGIBLE'
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Stricter than app_can_see_tx: an actual counterparty to the deal, not
-- merely a bank browsing the marketplace. Gates the post-selection tables
-- (contract, funding, settlement, payments, recourse) so that a bank which
-- was eligible but lost — or never offered — sees none of them.
CREATE OR REPLACE FUNCTION app_is_tx_party(p_tx uuid) RETURNS boolean AS $$
  SELECT
    current_user_is_platform()
    OR EXISTS (
      SELECT 1 FROM receivable_transactions t
      WHERE t.id = p_tx AND t.supplier_org_id = ANY (current_user_org_ids())
    )
    OR EXISTS (
      SELECT 1 FROM accepted_offer_snapshots s
      WHERE s.transaction_id = p_tx AND s.bank_org_id = ANY (current_user_org_ids())
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Does the current user's supplier org have a relationship with this buyer?
-- Buyers are a global directory (ZM-BUY-006); this keeps a supplier from
-- enumerating the whole directory by direct SQL.
CREATE OR REPLACE FUNCTION app_has_buyer_relationship(p_buyer uuid) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM supplier_buyer_relationships r
    WHERE r.buyer_id = p_buyer AND r.supplier_org_id = ANY (current_user_org_ids())
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Offer visibility, mirroring the frozen offer_read policy, for use by
-- offer satellite tables. ZM-MKT-011: never another bank's offer.
CREATE OR REPLACE FUNCTION app_can_see_offer(p_offer uuid) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM bank_offers o
    WHERE o.id = p_offer
      AND (
        o.bank_org_id = ANY (current_user_org_ids())
        OR current_user_is_platform()
        OR EXISTS (
          SELECT 1 FROM listings l
          JOIN receivable_transactions t ON t.id = l.transaction_id
          WHERE l.id = o.listing_id
            AND t.supplier_org_id = ANY (current_user_org_ids())
            AND o.status IN ('ACTIVE','SELECTED','NOT_SELECTED')
        )
      )
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- ---------------------------------------------------------------------
-- 2. PRIVILEGE BASELINE — deny by default
--
-- Wipes Supabase's permissive defaults, then re-grants SELECT only.
-- Writes are revoked outright: the API writes with the service-role key.
-- ---------------------------------------------------------------------

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;

-- Stop future tables inheriting the permissive default (applies to objects
-- created by the role running this migration, i.e. postgres).
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated;

GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
-- anon gets nothing at all.

-- Re-assert migration 0002 §D-02. The blanket GRANT above would otherwise
-- restore table-wide SELECT on receivable_transactions and silently undo the
-- floor revoke, regardless of migration ordering. Column list is identical
-- to 0002: every column EXCEPT minimum_acceptable_amount.
REVOKE SELECT ON receivable_transactions FROM authenticated;
GRANT SELECT (
  id, reference_number, supplier_org_id, buyer_id, state,
  closure_reason, closure_notes, currency,
  locked_at, locked_by_offer_id, created_by, created_at, updated_at
) ON receivable_transactions TO authenticated;

-- Same pattern, same reasoning, for two other secrets that row-level
-- visibility alone does not protect:

-- The OTP hash. Both parties legitimately see the OTP row (bank generated
-- it, supplier is entering it) but neither needs the hash by direct SQL;
-- verification happens in the API. Removing it removes an offline
-- brute-force target.
REVOKE SELECT ON funding_otps FROM authenticated;
GRANT SELECT (
  id, transaction_id, generated_by, generated_at, expires_at, status,
  attempt_count, max_attempts, resend_count, max_resends,
  verified_at, verified_by
) ON funding_otps TO authenticated;

-- ZM-PMT-018: bank_internal_notes must not reach the supplier. The row is
-- visible to both parties, so the column is revoked from authenticated
-- entirely; the bank reads it through the API, which allow-lists by role.
REVOKE SELECT ON buyer_payments FROM authenticated;
GRANT SELECT (
  id, transaction_id, amount, payment_date, bank_reference,
  evidence_document_id, reported_by, reported_at
) ON buyer_payments TO authenticated;

-- ---------------------------------------------------------------------
-- 3. ENABLE RLS ON EVERY TABLE
--
-- The 8 already enabled by the frozen schema are re-issued; ENABLE ROW
-- LEVEL SECURITY is idempotent.
-- ---------------------------------------------------------------------

ALTER TABLE users                             ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_memberships          ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_roles                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_applications             ENABLE ROW LEVEL SECURITY;
ALTER TABLE sla_clock_events                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_calendar_holidays        ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_bank_accounts            ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_records                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE information_requests              ENABLE ROW LEVEL SECURITY;
ALTER TABLE government_verification_requests  ENABLE ROW LEVEL SECURITY;
ALTER TABLE government_data_snapshots         ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_field_values               ENABLE ROW LEVEL SECURITY;
ALTER TABLE buyers                            ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_buyer_relationships      ENABLE ROW LEVEL SECURITY;
ALTER TABLE buyer_resolution_attempts         ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents                         ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_extractions              ENABLE ROW LEVEL SECURITY;
ALTER TABLE receivable_transactions           ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices                          ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_items                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_declarations              ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_runs                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_checks               ENABLE ROW LEVEL SECURITY;
ALTER TABLE risk_model_versions               ENABLE ROW LEVEL SECURITY;
ALTER TABLE risk_assessments                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_policy_filters               ENABLE ROW LEVEL SECURITY;
ALTER TABLE listings                          ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_eligibility                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_offers                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE offer_conditions                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE offer_selections                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE accepted_offer_snapshots          ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_templates                ENABLE ROW LEVEL SECURITY;
ALTER TABLE contracts                         ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_signatures               ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignment_records                ENABLE ROW LEVEL SECURITY;
ALTER TABLE funding_otps                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE funding_otp_events                ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlements                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlement_attempts               ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_tiers                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_calculations           ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_fee_obligations           ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE buyer_payments                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE recourse_cases                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE recourse_repayments               ENABLE ROW LEVEL SECURITY;
ALTER TABLE disputes                          ENABLE ROW LEVEL SECURITY;
ALTER TABLE withdrawal_cases                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE fraud_cases                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE fraud_indicators                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_evidence                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_templates            ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs                        ENABLE ROW LEVEL SECURITY;
ALTER TABLE status_history                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_settings                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo_time_offsets                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE relisting_requests                ENABLE ROW LEVEL SECURITY;  -- from 0002
ALTER TABLE webhook_events                    ENABLE ROW LEVEL SECURITY;  -- from 0002

-- ---------------------------------------------------------------------
-- 4. POLICIES — identity and access
-- ---------------------------------------------------------------------

-- A user reads their own row. Colleague names for display come through the
-- API, which allow-lists fields; direct SQL must not expose the user
-- directory (emails, phone numbers).
CREATE POLICY users_read ON users FOR SELECT USING (
  id = app_current_user_id() OR current_user_is_platform()
);

CREATE POLICY organizations_read ON organizations FOR SELECT USING (
  id = ANY (current_user_org_ids()) OR current_user_is_platform()
);

CREATE POLICY memberships_read ON organization_memberships FOR SELECT USING (
  user_id = app_current_user_id()
  OR organization_id = ANY (current_user_org_ids())
  OR current_user_is_platform()
);

CREATE POLICY membership_roles_read ON membership_roles FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM organization_memberships m
    WHERE m.id = membership_roles.membership_id
      AND (m.user_id = app_current_user_id()
           OR m.organization_id = ANY (current_user_org_ids()))
  )
  OR current_user_is_platform()
);

-- ---------------------------------------------------------------------
-- 5. POLICIES — onboarding
-- ---------------------------------------------------------------------

CREATE POLICY applications_read ON supplier_applications FOR SELECT USING (
  organization_id = ANY (current_user_org_ids()) OR current_user_is_platform()
);

CREATE POLICY sla_events_read ON sla_clock_events FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM supplier_applications a
    WHERE a.id = sla_clock_events.application_id
      AND a.organization_id = ANY (current_user_org_ids())
  )
  OR current_user_is_platform()
);

CREATE POLICY bank_accounts_read ON supplier_bank_accounts FOR SELECT USING (
  organization_id = ANY (current_user_org_ids()) OR current_user_is_platform()
);

CREATE POLICY consents_read ON consent_records FOR SELECT USING (
  organization_id = ANY (current_user_org_ids()) OR current_user_is_platform()
);

-- Polymorphic subject: resolve per subject_type rather than trusting the id.
CREATE POLICY info_requests_read ON information_requests FOR SELECT USING (
  current_user_is_platform()
  OR (subject_type = 'SUPPLIER_APPLICATION' AND EXISTS (
        SELECT 1 FROM supplier_applications a
        WHERE a.id = information_requests.subject_id
          AND a.organization_id = ANY (current_user_org_ids())))
  OR (subject_type = 'TRANSACTION' AND EXISTS (
        SELECT 1 FROM receivable_transactions t
        WHERE t.id = information_requests.subject_id
          AND t.supplier_org_id = ANY (current_user_org_ids())))
);

-- ---------------------------------------------------------------------
-- 6. POLICIES — government verification
--
-- ZM-GOV/ZM-RSK note: nothing here distinguishes "adverse" from
-- "unavailable"; source_available travels with the row and is never
-- filtered on. Visibility only.
-- ---------------------------------------------------------------------

CREATE POLICY gov_requests_read ON government_verification_requests FOR SELECT USING (
  current_user_is_platform()
  OR (subject_type = 'ORGANIZATION' AND subject_id = ANY (current_user_org_ids()))
  OR (subject_type = 'BUYER' AND app_has_buyer_relationship(subject_id))
  OR (subject_type = 'INVOICE' AND EXISTS (
        SELECT 1 FROM invoices i
        WHERE i.id = government_verification_requests.subject_id
          AND app_can_see_tx(i.transaction_id)))
);

CREATE POLICY gov_snapshots_read ON government_data_snapshots FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM government_verification_requests r
    WHERE r.id = government_data_snapshots.request_id
  ) AND (
    current_user_is_platform()
    OR EXISTS (
      SELECT 1 FROM government_verification_requests r
      WHERE r.id = government_data_snapshots.request_id
        AND ((r.subject_type = 'ORGANIZATION' AND r.subject_id = ANY (current_user_org_ids()))
             OR (r.subject_type = 'BUYER' AND app_has_buyer_relationship(r.subject_id)))
    )
  )
);

CREATE POLICY field_values_read ON entity_field_values FOR SELECT USING (
  current_user_is_platform()
  OR (entity_type = 'ORGANIZATION' AND entity_id = ANY (current_user_org_ids()))
  OR (entity_type = 'BUYER' AND app_has_buyer_relationship(entity_id))
);

-- ---------------------------------------------------------------------
-- 7. POLICIES — buyer directory
-- ---------------------------------------------------------------------

-- The directory is global, but direct-SQL enumeration is not. Suppliers see
-- buyers they trade with; banks see the buyer behind a listing they may
-- underwrite. Search over the wider registry goes through the API.
CREATE POLICY buyers_read ON buyers FOR SELECT USING (
  current_user_is_platform()
  OR app_has_buyer_relationship(id)
  OR EXISTS (
    SELECT 1 FROM receivable_transactions t
    JOIN listings l ON l.transaction_id = t.id
    JOIN bank_eligibility be ON be.listing_id = l.id
    WHERE t.buyer_id = buyers.id
      AND be.bank_org_id = ANY (current_user_org_ids())
      AND be.status = 'ELIGIBLE'
  )
);

-- ZM-BUY-008: supplier-specific contact data, never shared across suppliers.
CREATE POLICY buyer_rel_read ON supplier_buyer_relationships FOR SELECT USING (
  supplier_org_id = ANY (current_user_org_ids()) OR current_user_is_platform()
);

CREATE POLICY buyer_resolution_read ON buyer_resolution_attempts FOR SELECT USING (
  supplier_org_id = ANY (current_user_org_ids()) OR current_user_is_platform()
);

-- ---------------------------------------------------------------------
-- 8. POLICIES — documents
-- ---------------------------------------------------------------------

-- Owner org only. Cross-party document access (a bank reading an invoice
-- PDF it is underwriting) is mediated by the API, which checks the subject
-- and issues a short-lived signed URL.
CREATE POLICY documents_read ON documents FOR SELECT USING (
  owner_org_id = ANY (current_user_org_ids()) OR current_user_is_platform()
);

CREATE POLICY extractions_read ON document_extractions FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM documents d
    WHERE d.id = document_extractions.document_id
      AND d.owner_org_id = ANY (current_user_org_ids())
  )
  OR current_user_is_platform()
);

-- ---------------------------------------------------------------------
-- 9. POLICIES — transaction and invoice
--
-- receivable_transactions.tx_read is defined in 0001 (frozen) — not
-- redefined here. Satellites mirror it via app_can_see_tx().
-- ---------------------------------------------------------------------

CREATE POLICY invoices_read ON invoices FOR SELECT USING (
  app_can_see_tx(transaction_id)
);

CREATE POLICY invoice_items_read ON invoice_items FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM invoices i
    WHERE i.id = invoice_items.invoice_id AND app_can_see_tx(i.transaction_id)
  )
);

-- Declarations are the supplier's legal attestations: supplier + platform.
CREATE POLICY declarations_read ON invoice_declarations FOR SELECT USING (
  current_user_is_platform()
  OR EXISTS (
    SELECT 1 FROM receivable_transactions t
    WHERE t.id = invoice_declarations.transaction_id
      AND t.supplier_org_id = ANY (current_user_org_ids())
  )
);

CREATE POLICY verification_runs_read ON verification_runs FOR SELECT USING (
  app_can_see_tx(transaction_id)
);

CREATE POLICY verification_checks_read ON verification_checks FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM verification_runs r
    WHERE r.id = verification_checks.run_id AND app_can_see_tx(r.transaction_id)
  )
);

-- ---------------------------------------------------------------------
-- 10. POLICIES — risk
-- ---------------------------------------------------------------------

-- Model versions are not tenant data: banks and suppliers both need the
-- version label and date shown next to a score (ZM-RSK-009..011). Weights
-- and training metrics are not secret either — explainability is a
-- requirement. Writes are revoked, so activation stays with the API.
CREATE POLICY risk_models_read ON risk_model_versions FOR SELECT USING (true);

CREATE POLICY risk_assessments_read ON risk_assessments FOR SELECT USING (
  current_user_is_platform()
  OR (organization_id IS NOT NULL AND organization_id = ANY (current_user_org_ids()))
  OR (transaction_id IS NOT NULL AND app_can_see_tx(transaction_id))
);

-- ---------------------------------------------------------------------
-- 11. POLICIES — marketplace, offers, selection
--
-- The confidentiality core. INV-11: bank A must never read bank B's rows,
-- and must not be able to infer that bank B exists — including via
-- count(*), which RLS filters before aggregation.
-- ---------------------------------------------------------------------

-- A bank's underwriting appetite is commercially sensitive to its
-- competitors and irrelevant to suppliers.
CREATE POLICY policy_filters_read ON bank_policy_filters FOR SELECT USING (
  bank_org_id = ANY (current_user_org_ids()) OR current_user_is_platform()
);

CREATE POLICY listings_read ON listings FOR SELECT USING (
  app_can_see_tx(transaction_id)
);

-- Own eligibility only. Suppliers are deliberately excluded: the number of
-- eligible banks is a proxy for competition and is not the supplier's to
-- see at this layer (offerCount is served by the API, supplier-only).
CREATE POLICY eligibility_read ON bank_eligibility FOR SELECT USING (
  bank_org_id = ANY (current_user_org_ids()) OR current_user_is_platform()
);

-- bank_offers.offer_read is defined in 0001 (frozen) — not redefined here.

CREATE POLICY offer_conditions_read ON offer_conditions FOR SELECT USING (
  app_can_see_offer(offer_id)
);

CREATE POLICY offer_selections_read ON offer_selections FOR SELECT USING (
  current_user_is_platform()
  OR EXISTS (
    SELECT 1 FROM listings l
    JOIN receivable_transactions t ON t.id = l.transaction_id
    WHERE l.id = offer_selections.listing_id
      AND t.supplier_org_id = ANY (current_user_org_ids())
  )
  OR EXISTS (
    SELECT 1 FROM bank_offers o
    WHERE o.id = offer_selections.offer_id
      AND o.bank_org_id = ANY (current_user_org_ids())
  )
);

-- The snapshot carries the full accepted money breakdown. Parties only —
-- a losing bank learns nothing about the winning terms.
CREATE POLICY snapshots_read ON accepted_offer_snapshots FOR SELECT USING (
  supplier_org_id = ANY (current_user_org_ids())
  OR bank_org_id = ANY (current_user_org_ids())
  OR current_user_is_platform()
);

-- ---------------------------------------------------------------------
-- 12. POLICIES — contracts
-- ---------------------------------------------------------------------

-- Versioned templates are reference data, needed by both parties to render
-- a contract before signing.
CREATE POLICY contract_templates_read ON contract_templates FOR SELECT USING (true);

CREATE POLICY contracts_read ON contracts FOR SELECT USING (
  app_is_tx_party(transaction_id)
);

CREATE POLICY signatures_read ON contract_signatures FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM contracts c
    WHERE c.id = contract_signatures.contract_id AND app_is_tx_party(c.transaction_id)
  )
);

CREATE POLICY assignment_records_read ON assignment_records FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM contracts c
    WHERE c.id = assignment_records.contract_id AND app_is_tx_party(c.transaction_id)
  )
);

-- ---------------------------------------------------------------------
-- 13. POLICIES — funding, settlement, fees, ledger
-- ---------------------------------------------------------------------

-- Counterparties only. otp_hash is additionally revoked at column level above.
CREATE POLICY otps_read ON funding_otps FOR SELECT USING (
  app_is_tx_party(transaction_id)
);

CREATE POLICY otp_events_read ON funding_otp_events FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM funding_otps o
    WHERE o.id = funding_otp_events.otp_id AND app_is_tx_party(o.transaction_id)
  )
);

CREATE POLICY settlements_read ON settlements FOR SELECT USING (
  app_is_tx_party(transaction_id)
);

-- Attempt payloads are raw provider request/response bodies. Platform only.
CREATE POLICY settlement_attempts_read ON settlement_attempts FOR SELECT USING (
  current_user_is_platform()
);

-- Commission tiers are published pricing: a bank composing an offer needs
-- them, and the supplier is entitled to see what it is charged.
CREATE POLICY commission_tiers_read ON commission_tiers FOR SELECT USING (true);

CREATE POLICY commission_calcs_read ON commission_calculations FOR SELECT USING (
  app_is_tx_party(transaction_id)
);

CREATE POLICY listing_fees_read ON listing_fee_obligations FOR SELECT USING (
  supplier_org_id = ANY (current_user_org_ids()) OR current_user_is_platform()
);

-- Own legs only. Entries with a NULL organization_id are platform-internal
-- (commission and listing-fee revenue) and stay platform-only.
CREATE POLICY ledger_read ON ledger_entries FOR SELECT USING (
  (organization_id IS NOT NULL AND organization_id = ANY (current_user_org_ids()))
  OR current_user_is_platform()
);

-- ---------------------------------------------------------------------
-- 14. POLICIES — post-funding payments and cases
-- ---------------------------------------------------------------------

-- bank_internal_notes revoked at column level above (ZM-PMT-018).
CREATE POLICY buyer_payments_read ON buyer_payments FOR SELECT USING (
  app_is_tx_party(transaction_id)
);

CREATE POLICY recourse_read ON recourse_cases FOR SELECT USING (
  app_is_tx_party(transaction_id)
);

CREATE POLICY recourse_repayments_read ON recourse_repayments FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM recourse_cases c
    WHERE c.id = recourse_repayments.recourse_case_id AND app_is_tx_party(c.transaction_id)
  )
);

CREATE POLICY disputes_read ON disputes FOR SELECT USING (
  raised_by_org_id = ANY (current_user_org_ids())
  OR app_is_tx_party(transaction_id)
);

CREATE POLICY withdrawal_cases_read ON withdrawal_cases FOR SELECT USING (
  bank_org_id = ANY (current_user_org_ids())
  OR app_is_tx_party(transaction_id)
);

-- Fraud investigations are compliance-internal. What the subject org is
-- told, and when, is a decision the API makes (ZM-FRD): never a direct-SQL
-- read. Indicators and evidence follow the case.
CREATE POLICY fraud_cases_read ON fraud_cases FOR SELECT USING (
  current_user_is_platform()
);

CREATE POLICY fraud_indicators_read ON fraud_indicators FOR SELECT USING (
  current_user_is_platform()
);

CREATE POLICY case_evidence_read ON case_evidence FOR SELECT USING (
  current_user_is_platform()
);

CREATE POLICY relisting_requests_read ON relisting_requests FOR SELECT USING (
  current_user_is_platform()
  OR EXISTS (
    SELECT 1 FROM receivable_transactions t
    WHERE t.id = relisting_requests.transaction_id
      AND t.supplier_org_id = ANY (current_user_org_ids())
  )
);

-- ---------------------------------------------------------------------
-- 15. POLICIES — notifications, audit, configuration
-- ---------------------------------------------------------------------

CREATE POLICY notification_templates_read ON notification_templates FOR SELECT USING (true);

-- Own notifications only. Buyer-addressed notifications
-- (recipient_user_id IS NULL) are platform-visible.
CREATE POLICY notifications_read ON notifications FOR SELECT USING (
  (recipient_user_id IS NOT NULL AND recipient_user_id = app_current_user_id())
  OR current_user_is_platform()
);

-- ZM-AUD: an organization can see its own trail; the platform sees all.
-- The frozen RULEs already make audit_logs append-only.
CREATE POLICY audit_read ON audit_logs FOR SELECT USING (
  actor_org_id = ANY (current_user_org_ids()) OR current_user_is_platform()
);

-- Polymorphic entity with no owning column; resolving it per entity_type
-- would leak the existence of rows for entities the caller cannot see.
-- Platform-only at this layer; per-entity timelines are served by the API.
CREATE POLICY status_history_read ON status_history FOR SELECT USING (
  current_user_is_platform()
);

-- Operational configuration the UI needs (windows, deadlines, fee amounts,
-- language default). No secrets are stored here — secrets live in env.
CREATE POLICY settings_read ON platform_settings FOR SELECT USING (true);

CREATE POLICY demo_offsets_read ON demo_time_offsets FOR SELECT USING (
  current_user_is_platform()
);

-- Provider payloads; service-role only in practice.
CREATE POLICY webhook_events_read ON webhook_events FOR SELECT USING (
  current_user_is_platform()
);

-- =====================================================================
-- End of migration 0003.
--
-- Coverage is asserted by test, not by this comment: rls-coverage.spec
-- enumerates pg_tables in schema public and fails if any table lacks both
-- RLS and a policy, so a table added in a later phase cannot ship
-- unprotected. The persona suite (rls-personas.spec) then proves the
-- policies actually hold by connecting as each persona directly.
-- =====================================================================
