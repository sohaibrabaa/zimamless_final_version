-- =====================================================================
-- MIGRATION 0001 — FROZEN SCHEMA (GENERATED — DO NOT EDIT BY HAND)
-- =====================================================================
-- Source:    docs/02_DATABASE_SCHEMA.sql (schema version 3.0.0, FROZEN)
-- Generator: db/tools/build-0001.mjs   (CI verifies this file matches)
--
-- The ONLY transformation applied to the frozen file is the removal of
-- the statement creating index uq_active_invoice_fingerprint, per
-- docs/coordination/DECISIONS.md RULING D-01 (2026-07-22): the partial
-- index predicate contains a subquery, which PostgreSQL rejects, so the
-- frozen file does not execute as written. The behaviour-identical
-- replacement (trigger-maintained invoices.is_active_fingerprint + a
-- partial unique index on it) ships in migration 0002 §D-01.
--
-- To change this file, change the frozen schema (product owner only) and
-- re-run the generator. Editing it directly will fail the CI check.
-- =====================================================================

-- =====================================================================
-- ZIMMAMLESS V3 — DATABASE SCHEMA (FROZEN CONTRACT)
-- PostgreSQL / Supabase
-- =====================================================================
-- THIS FILE IS A FROZEN CONTRACT.
-- Neither parallel agent may alter it unilaterally. Any change requires
-- explicit product-owner approval and a version bump below.
--
-- Schema version: 3.0.0
-- Money: numeric(18,3) everywhere. JOD only in V3. Never float.
-- Deletes: none. Financial and audit rows are append-only.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =====================================================================
-- ENUMERATIONS
-- =====================================================================

CREATE TYPE user_status               AS ENUM ('ACTIVE','SUSPENDED','DEACTIVATED');
CREATE TYPE organization_type         AS ENUM ('SUPPLIER','BANK','PLATFORM');
CREATE TYPE organization_status       AS ENUM ('INVITED','ONBOARDING','UNDER_REVIEW','ACTIVE','APPROVED_CONDITIONAL','SUSPENDED','RESTRICTED','TERMINATED','REJECTED');
CREATE TYPE membership_status         AS ENUM ('ACTIVE','SUSPENDED','EXPIRED','REVOKED');

CREATE TYPE role_key                  AS ENUM (
  -- supplier
  'SUPPLIER_OWNER','SUPPLIER_SIGNATORY','SUPPLIER_UPLOADER','SUPPLIER_VIEWER',
  -- bank
  'BANK_ADMIN','BANK_ANALYST','BANK_OFFER_MAKER','BANK_OFFER_APPROVER','BANK_OPERATIONS','BANK_AUDITOR',
  -- platform
  'PLATFORM_SUPER_ADMIN','PLATFORM_OPS_ADMIN','PLATFORM_SUPPLIER_REVIEWER','PLATFORM_COMPLIANCE','PLATFORM_SUPPORT','PLATFORM_AUDITOR'
);

CREATE TYPE supplier_application_status AS ENUM (
  'DRAFT','SUBMITTED','AUTOMATED_VERIFICATION','UNDER_REVIEW',
  'INFORMATION_REQUIRED','INFORMATION_RESUBMITTED','GOVERNMENT_SERVICE_UNAVAILABLE',
  'FINAL_REVIEW','APPROVED','APPROVED_CONDITIONAL','REJECTED'
);

CREATE TYPE gov_source                AS ENUM ('CCD','ISTD','GAM','EINVOICE');
CREATE TYPE gov_request_status        AS ENUM ('PENDING','SUCCESS','PARTIAL','NOT_FOUND','UNAVAILABLE','ERROR');
CREATE TYPE data_source_kind          AS ENUM ('GOVERNMENT','SELF_DECLARED','DERIVED');
CREATE TYPE verification_status       AS ENUM ('UNVERIFIED','VERIFIED','MISMATCH','PENDING');

CREATE TYPE buyer_resolution_status   AS ENUM ('MATCHED','PARTIAL_MATCH','NOT_FOUND','MISMATCH','BLOCKED','MANUAL_REVIEW');
CREATE TYPE buyer_registry_status     AS ENUM ('ACTIVE','SUSPENDED','STRUCK_OFF','UNDER_LIQUIDATION','UNKNOWN');
CREATE TYPE contact_state             AS ENUM ('SUPPLIER_PROVIDED','UNVERIFIED','CONTACTED','VERIFIED_BY_CONTACT','INVALID','DO_NOT_CONTACT');

CREATE TYPE transaction_state AS ENUM (
  'DRAFT','SUBMITTED','AUTOMATED_CHECKS','UNDER_REVIEW','INFORMATION_REQUIRED',
  'ELIGIBLE','OPEN_FOR_OFFERS','OFFER_ACCEPTED','CONDITIONS_PENDING',
  'CONTRACTED','READY_FOR_DISBURSEMENT','FUNDING_CONFIRMATION_PENDING','FUNDED',
  'PARTIALLY_PAID','PAID','OVERDUE_UNCONFIRMED','OVERDUE',
  'RECOURSE_ACTIVE','DISPUTED','FRAUD_REVIEW','CLOSED','REJECTED','CANCELLED'
);

CREATE TYPE closure_reason AS ENUM (
  'PAID_IN_FULL','RECOURSE_SETTLED','WRITTEN_OFF','DEFAULTED',
  'CANCELLED_BEFORE_FUNDING','SETTLED_BY_AGREEMENT','OTHER'
);

CREATE TYPE transaction_type          AS ENUM ('INVOICE_FINANCING','RECEIVABLE_PURCHASE','RECEIVABLE_ASSIGNMENT','OTHER');
CREATE TYPE recourse_type             AS ENUM ('FULL_RECOURSE','LIMITED_RECOURSE','NON_RECOURSE','OTHER');

CREATE TYPE listing_status            AS ENUM ('OPEN_FOR_OFFERS','OFFER_PERIOD_CLOSED','AWAITING_SELECTION','OFFER_SELECTED','EXPIRED','CANCELLED');
CREATE TYPE offer_status              AS ENUM ('DRAFT','PENDING_INTERNAL_APPROVAL','ACTIVE','REVISED','SELECTED','NOT_SELECTED','WITHDRAWN','EXPIRED','REJECTED_INTERNAL');
CREATE TYPE offer_condition_type      AS ENUM ('REQUIRED_GUARANTEE','REQUIRED_DOCUMENT','RECOURSE_TERM','FUNDING_TIMELINE','CONTRACTUAL_CONDITION','OTHER');
CREATE TYPE condition_fulfilment      AS ENUM ('PENDING','FULFILLED','WAIVED','FAILED');
CREATE TYPE eligibility_status        AS ENUM ('ELIGIBLE','NOT_ELIGIBLE','PENDING_REVIEW','EXPIRED');

CREATE TYPE contract_status           AS ENUM ('GENERATED','PENDING_SIGNATURES','FULLY_SIGNED','ACTIVE','CANCELLED');
CREATE TYPE signer_capacity           AS ENUM ('SUPPLIER_AUTHORIZED_SIGNATORY','BANK_AUTHORIZED_SIGNATORY');
CREATE TYPE signature_status          AS ENUM ('PENDING','SIGNED','VERIFIED','FAILED','REVOKED');

CREATE TYPE otp_status                AS ENUM ('PENDING_GENERATION','SENT','VERIFIED','EXPIRED','FAILED_MAX_ATTEMPTS');
CREATE TYPE settlement_status         AS ENUM ('PENDING','FUNDING_RECEIVED','PAYOUT_INITIATED','PAYOUT_COMPLETED','PAYOUT_FAILED','RETRYING','MANUAL_REVIEW','REVERSED');
CREATE TYPE fee_payer                 AS ENUM ('SUPPLIER','BANK','SPLIT','CUSTOM');
CREATE TYPE fee_obligation_status     AS ENUM ('PAYABLE','DEDUCTED','PAID','WAIVED','WRITTEN_OFF');
CREATE TYPE commission_calc_status    AS ENUM ('CALCULATED','FINALIZED','SUPERSEDED','REVERSED');

CREATE TYPE ledger_entry_type         AS ENUM ('DEBIT','CREDIT');
CREATE TYPE ledger_account_kind       AS ENUM ('BANK_FUNDING','SUPPLIER_PAYABLE','PLATFORM_COMMISSION_REVENUE','PLATFORM_LISTING_FEE_REVENUE','SUPPLIER_RECEIVABLE','SETTLEMENT_CLEARING','RECOURSE_CLEARING');

CREATE TYPE recourse_reason           AS ENUM ('INVALID_INVOICE','HIDDEN_DISPUTE_OR_RETURN','DOUBLE_FINANCING','NON_DELIVERY','NON_PAYMENT','OTHER');
CREATE TYPE recourse_status           AS ENUM ('RECOURSE_INITIATED','SUPPLIER_NOTIFIED','PAYMENT_PENDING','SETTLED','DISPUTED','LEGAL_ESCALATION');
CREATE TYPE dispute_status            AS ENUM ('OPEN','UNDER_REVIEW','RESOLVED','REJECTED');
CREATE TYPE withdrawal_reason         AS ENUM ('BANK_COMMERCIAL_DECISION','SUPPLIER_MISREPRESENTATION','FRAUD_DISCOVERED','INVOICE_CHANGED','CONDITION_NOT_MET','TECHNICAL_FAILURE','OTHER');
CREATE TYPE withdrawal_status         AS ENUM ('WITHDRAWAL_REQUESTED','UNDER_REVIEW','PENALTY_ASSESSED','NO_PENALTY','RELISTING_APPROVED','RELISTING_DENIED','CLOSED');
CREATE TYPE fraud_case_status         AS ENUM ('OPEN','UNDER_REVIEW','INFORMATION_REQUESTED','CLEARED','RESTRICTED','SUSPENDED','BLACKLISTED','REPORTED','CLOSED');

CREATE TYPE risk_band                 AS ENUM ('LOW','MEDIUM','HIGH','CRITICAL');
CREATE TYPE check_result              AS ENUM ('PASS','FAIL','REVIEW','MISSING','UNPARSED','NOT_APPLICABLE');
CREATE TYPE document_type AS ENUM (
  'COMMERCIAL_REGISTRATION','TAX_CERTIFICATE','BUSINESS_LICENSE','BANK_ACCOUNT_EVIDENCE',
  'SIGNATORY_AUTHORIZATION','ELECTRONIC_INVOICE','PURCHASE_ORDER','DELIVERY_EVIDENCE',
  'STATEMENT_OF_ACCOUNT','CREDIT_NOTE','CONTRACT_DOCUMENT','CASE_EVIDENCE','OTHER'
);

CREATE TYPE notification_channel      AS ENUM ('EMAIL','WHATSAPP','IN_PLATFORM','MANUAL_CALL');
CREATE TYPE notification_status       AS ENUM ('QUEUED','SENT','DELIVERED','FAILED','BOUNCED','SUPPRESSED');
CREATE TYPE language_code             AS ENUM ('EN','AR');

-- =====================================================================
-- 1. IDENTITY, ORGANIZATIONS, ACCESS
-- =====================================================================

CREATE TABLE users (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  auth_user_id        uuid UNIQUE,                       -- Supabase auth.users.id
  full_name           text NOT NULL,
  email               citext NOT NULL UNIQUE,
  phone_number        text NOT NULL,
  national_id_enc     bytea,                             -- encrypted
  national_id_last4   text,
  preferred_language  language_code NOT NULL DEFAULT 'EN', -- ZM-I18N-003: English default
  mfa_enabled         boolean NOT NULL DEFAULT false,
  status              user_status NOT NULL DEFAULT 'ACTIVE',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organizations (
  id                        uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_type         organization_type NOT NULL,
  legal_name                text NOT NULL,
  status                    organization_status NOT NULL DEFAULT 'ONBOARDING',
  national_establishment_no text,                         -- suppliers + buyers-as-orgs
  commercial_registration_no text,
  tax_number                text,
  bank_licence_number       text,                         -- banks only
  swift_code                text,
  contact_email             citext,
  contact_phone             text,
  platform_agreement_ref    text,
  platform_terms_version    text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

-- ZM-AUD-006: national establishment number unique platform-wide for suppliers
CREATE UNIQUE INDEX uq_org_national_no
  ON organizations (national_establishment_no)
  WHERE national_establishment_no IS NOT NULL AND organization_type = 'SUPPLIER';

CREATE TABLE organization_memberships (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             uuid NOT NULL REFERENCES users(id),
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  job_title           text,
  status              membership_status NOT NULL DEFAULT 'ACTIVE',
  is_authorized_signatory boolean NOT NULL DEFAULT false,
  valid_from          timestamptz NOT NULL DEFAULT now(),
  valid_to            timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, organization_id)
);

CREATE TABLE membership_roles (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  membership_id   uuid NOT NULL REFERENCES organization_memberships(id) ON DELETE CASCADE,
  role            role_key NOT NULL,
  granted_by      uuid REFERENCES users(id),
  granted_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (membership_id, role)
);

-- =====================================================================
-- 2. SUPPLIER ONBOARDING
-- =====================================================================

CREATE TABLE supplier_applications (
  id                        uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id           uuid NOT NULL REFERENCES organizations(id),
  status                    supplier_application_status NOT NULL DEFAULT 'DRAFT',
  submitted_at              timestamptz,
  decided_at                timestamptz,
  decided_by                uuid REFERENCES users(id),
  decision_reason_code      text,
  decision_notes            text,
  sla_deadline_at           timestamptz,
  sla_elapsed_business_secs integer NOT NULL DEFAULT 0,
  sla_paused_at             timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

-- ZM-SON-008: every pause/resume reconstructible
CREATE TABLE sla_clock_events (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  application_id  uuid NOT NULL REFERENCES supplier_applications(id),
  event           text NOT NULL CHECK (event IN ('START','PAUSE','RESUME','STOP')),
  reason          text NOT NULL,
  actor_user_id   uuid REFERENCES users(id),
  occurred_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE business_calendar_holidays (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  holiday_date  date NOT NULL UNIQUE,
  description   text
);

CREATE TABLE supplier_bank_accounts (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  iban_enc            bytea NOT NULL,
  iban_last4          text NOT NULL,
  bank_name           text NOT NULL,
  account_holder_name text NOT NULL,
  verification_status verification_status NOT NULL DEFAULT 'UNVERIFIED',
  verified_at         timestamptz,
  is_primary          boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE consent_records (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id   uuid NOT NULL REFERENCES organizations(id),
  user_id           uuid REFERENCES users(id),
  consent_type      text NOT NULL,
  consent_version   text NOT NULL,
  consent_text_hash text NOT NULL,
  granted           boolean NOT NULL,
  granted_at        timestamptz NOT NULL DEFAULT now(),
  ip_address        inet
);

CREATE TABLE information_requests (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  subject_type    text NOT NULL,   -- 'SUPPLIER_APPLICATION' | 'TRANSACTION'
  subject_id      uuid NOT NULL,
  requested_item  text NOT NULL,
  description     text,
  status          text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','FULFILLED','CANCELLED')),
  requested_by    uuid REFERENCES users(id),
  requested_at    timestamptz NOT NULL DEFAULT now(),
  fulfilled_at    timestamptz
);

-- =====================================================================
-- 3. GOVERNMENT VERIFICATION
-- =====================================================================

CREATE TABLE government_verification_requests (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  source          gov_source NOT NULL,
  lookup_key      text NOT NULL,
  subject_type    text NOT NULL,   -- 'ORGANIZATION' | 'BUYER' | 'INVOICE'
  subject_id      uuid,
  status          gov_request_status NOT NULL DEFAULT 'PENDING',
  -- ZM-RSK-008 / ZM-GOV-008: distinguishes "source said no" from "source silent"
  source_available boolean NOT NULL DEFAULT true,
  requested_at    timestamptz NOT NULL DEFAULT now(),
  responded_at    timestamptz,
  error_code      text,
  adapter_version text
);

CREATE TABLE government_data_snapshots (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  request_id          uuid NOT NULL REFERENCES government_verification_requests(id),
  source              gov_source NOT NULL,
  raw_payload         jsonb NOT NULL,     -- verbatim from source
  normalized_payload  jsonb NOT NULL,     -- mapped to platform shape
  payload_hash        text NOT NULL,
  retrieved_at        timestamptz NOT NULL DEFAULT now(),
  valid_until         timestamptz NOT NULL  -- retrieved_at + freshness window (default 90d)
);

-- ZM-GOV-002: every field carries provenance
CREATE TABLE entity_field_values (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  entity_type         text NOT NULL,     -- 'ORGANIZATION' | 'BUYER'
  entity_id           uuid NOT NULL,
  field_key           text NOT NULL,
  field_value         text,
  source_kind         data_source_kind NOT NULL,
  source              gov_source,
  snapshot_id         uuid REFERENCES government_data_snapshots(id),
  verification_status verification_status NOT NULL DEFAULT 'UNVERIFIED',
  evidence_document_id uuid,
  retrieved_at        timestamptz NOT NULL DEFAULT now(),
  superseded_at       timestamptz,
  UNIQUE (entity_type, entity_id, field_key, source_kind, retrieved_at)
);

-- =====================================================================
-- 4. BUYER DIRECTORY
-- =====================================================================

-- ZM-BUY-006: global, deduplicated by national establishment number
CREATE TABLE buyers (
  id                        uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  national_establishment_no text UNIQUE,
  legal_company_name        text NOT NULL,
  company_type              text,
  registry_status           buyer_registry_status NOT NULL DEFAULT 'UNKNOWN',
  governorate               text,
  registered_address        text,
  capital_amount            numeric(18,3),
  registration_date         date,
  last_snapshot_id          uuid REFERENCES government_data_snapshots(id),
  last_verified_at          timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

-- ZM-BUY-008: supplier-specific contact lives here, never on buyers
CREATE TABLE supplier_buyer_relationships (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  supplier_org_id       uuid NOT NULL REFERENCES organizations(id),
  buyer_id              uuid NOT NULL REFERENCES buyers(id),
  contact_name          text,
  contact_role          text,
  contact_phone_enc     bytea,
  contact_phone_last4   text,
  contact_email         citext,
  contact_state         contact_state NOT NULL DEFAULT 'SUPPLIER_PROVIDED',
  relationship_start_date date,
  previous_transactions_count integer DEFAULT 0,
  usual_payment_period_days integer,
  previous_late_payments_count integer DEFAULT 0,
  previous_disputes_count integer DEFAULT 0,
  provided_by_user_id   uuid REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_org_id, buyer_id)
);

CREATE TABLE buyer_resolution_attempts (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  supplier_org_id   uuid NOT NULL REFERENCES organizations(id),
  search_term       text NOT NULL,
  candidates        jsonb NOT NULL DEFAULT '[]',
  selected_buyer_id uuid REFERENCES buyers(id),
  selected_by       uuid REFERENCES users(id),
  status            buyer_resolution_status NOT NULL,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- 5. DOCUMENTS
-- =====================================================================

CREATE TABLE documents (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_org_id      uuid NOT NULL REFERENCES organizations(id),
  document_type     document_type NOT NULL,
  storage_path      text NOT NULL,       -- private bucket key
  file_name         text NOT NULL,
  mime_type         text NOT NULL,
  size_bytes        bigint NOT NULL,
  file_hash         text NOT NULL,
  subject_type      text,                -- 'SUPPLIER_APPLICATION' | 'TRANSACTION' | 'CASE'
  subject_id        uuid,
  uploaded_by       uuid NOT NULL REFERENCES users(id),
  uploaded_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE document_extractions (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id         uuid NOT NULL REFERENCES documents(id),
  extraction_kind     text NOT NULL CHECK (extraction_kind IN ('OCR','QR')),
  -- ZM-DOC-006: machine output preserved independently of user corrections
  raw_output          jsonb NOT NULL,
  extracted_fields    jsonb NOT NULL DEFAULT '{}',
  confidence          numeric(5,4),
  engine_version      text,
  succeeded           boolean NOT NULL DEFAULT true,
  failure_reason      text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- 6. RECEIVABLE TRANSACTION (core aggregate) + INVOICE
-- =====================================================================

CREATE TABLE receivable_transactions (
  id                        uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  reference_number          text NOT NULL UNIQUE,
  supplier_org_id           uuid NOT NULL REFERENCES organizations(id),
  buyer_id                  uuid REFERENCES buyers(id),
  state                     transaction_state NOT NULL DEFAULT 'DRAFT',
  closure_reason            closure_reason,
  closure_notes             text,
  -- supplier private floor (ZM-MKT-012: never exposed to banks)
  minimum_acceptable_amount numeric(18,3),
  currency                  char(3) NOT NULL DEFAULT 'JOD' CHECK (currency = 'JOD'),
  locked_at                 timestamptz,
  locked_by_offer_id        uuid,
  created_by                uuid NOT NULL REFERENCES users(id),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_min_amount_positive CHECK (minimum_acceptable_amount IS NULL OR minimum_acceptable_amount > 0),
  CONSTRAINT chk_closed_has_reason  CHECK (state <> 'CLOSED' OR closure_reason IS NOT NULL)
);

CREATE TABLE invoices (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_id        uuid NOT NULL UNIQUE REFERENCES receivable_transactions(id),
  invoice_number        text NOT NULL,
  einvoice_identifier   text NOT NULL,          -- ZM-DOC-001: mandatory
  issue_date            date NOT NULL,
  due_date              date NOT NULL,
  currency              char(3) NOT NULL DEFAULT 'JOD',
  subtotal_amount       numeric(18,3) NOT NULL,
  tax_amount            numeric(18,3) NOT NULL DEFAULT 0,
  face_value            numeric(18,3) NOT NULL,
  paid_amount           numeric(18,3) NOT NULL DEFAULT 0,
  outstanding_amount    numeric(18,3) NOT NULL,
  payment_terms         text,
  payment_period_days   integer,
  goods_description     text,
  purchase_order_number text,
  delivery_note_number  text,
  receiving_branch      text,
  -- ZM-VER-001: unique platform-wide for active invoices
  fingerprint           text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_outstanding    CHECK (outstanding_amount = face_value - paid_amount),
  CONSTRAINT chk_outstanding_pos CHECK (outstanding_amount > 0),
  CONSTRAINT chk_due_after_issue CHECK (due_date >= issue_date)
);

-- [D-01] The uq_active_invoice_fingerprint index from the frozen schema is
-- omitted here (invalid PostgreSQL). Replacement in migration 0002 §D-01.


CREATE TABLE invoice_items (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  invoice_id    uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  line_no       integer NOT NULL,
  description   text NOT NULL,
  quantity      numeric(18,3) NOT NULL,
  unit_price    numeric(18,3) NOT NULL,
  line_amount   numeric(18,3) NOT NULL,
  UNIQUE (invoice_id, line_no)
);

CREATE TABLE invoice_declarations (
  id                        uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_id            uuid NOT NULL UNIQUE REFERENCES receivable_transactions(id),
  declaration_template_version text NOT NULL,
  is_authentic              boolean NOT NULL,
  goods_delivered           boolean NOT NULL,
  unpaid_and_not_cancelled  boolean NOT NULL,
  no_known_dispute          boolean NOT NULL,
  not_previously_financed   boolean NOT NULL,
  buyer_is_named_entity     boolean NOT NULL,
  contact_is_buyer_rep      boolean NOT NULL,
  accepts_recourse          boolean NOT NULL,
  declared_by               uuid NOT NULL REFERENCES users(id),
  declared_at               timestamptz NOT NULL DEFAULT now(),
  ip_address                inet,
  CONSTRAINT chk_all_declared CHECK (
    is_authentic AND goods_delivered AND unpaid_and_not_cancelled
    AND no_known_dispute AND not_previously_financed
    AND buyer_is_named_entity AND contact_is_buyer_rep AND accepts_recourse
  )
);

-- =====================================================================
-- 7. VERIFICATION CHECKS
-- =====================================================================

CREATE TABLE verification_runs (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_id  uuid NOT NULL REFERENCES receivable_transactions(id),
  started_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  overall_result  check_result
);

CREATE TABLE verification_checks (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id          uuid NOT NULL REFERENCES verification_runs(id) ON DELETE CASCADE,
  check_type      text NOT NULL,   -- COMPLETENESS | IDENTITY_MATCH | DUPLICATE | LOGIC | ELIGIBILITY | FILE_INTEGRITY | OCR_CONSISTENCY | QR_CONSISTENCY
  result          check_result NOT NULL,
  details         jsonb NOT NULL DEFAULT '{}',
  evaluated_at    timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- 8. RISK / TRUST SCORE
-- =====================================================================

CREATE TABLE risk_model_versions (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  version_label     text NOT NULL UNIQUE,
  model_type        text NOT NULL,   -- 'RULES' | 'ML' | 'HYBRID'
  weights           jsonb NOT NULL,
  band_thresholds   jsonb NOT NULL DEFAULT '{"LOW":75,"MEDIUM":50,"HIGH":25}',
  is_active         boolean NOT NULL DEFAULT false,
  training_metrics  jsonb,
  effective_from    timestamptz,
  effective_to      timestamptz,
  activated_by      uuid REFERENCES users(id),
  activation_reason text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_one_active_risk_model ON risk_model_versions (is_active) WHERE is_active;

CREATE TABLE risk_assessments (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_id        uuid REFERENCES receivable_transactions(id),
  organization_id       uuid REFERENCES organizations(id),
  model_version_id      uuid NOT NULL REFERENCES risk_model_versions(id),
  composite_score       integer NOT NULL CHECK (composite_score BETWEEN 0 AND 100),
  band                  risk_band NOT NULL,
  supplier_verification_score integer CHECK (supplier_verification_score BETWEEN 0 AND 100),
  data_confidence_score integer CHECK (data_confidence_score BETWEEN 0 AND 100),
  buyer_profile_score   integer CHECK (buyer_profile_score BETWEEN 0 AND 100),
  invoice_score         integer CHECK (invoice_score BETWEEN 0 AND 100),
  platform_behavior_score integer CHECK (platform_behavior_score BETWEEN 0 AND 100),
  -- ZM-RSK-005/006: availability tracked separately, never reduces score
  data_availability_pct numeric(5,2),
  positive_factors      jsonb NOT NULL DEFAULT '[]',
  risk_factors          jsonb NOT NULL DEFAULT '[]',
  reason_codes          text[] NOT NULL DEFAULT '{}',
  ml_used               boolean NOT NULL DEFAULT false,
  ml_fallback_reason    text,
  calculated_at         timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- 9. MARKETPLACE, OFFERS, SELECTION
-- =====================================================================

CREATE TABLE bank_policy_filters (
  id                      uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  bank_org_id             uuid NOT NULL REFERENCES organizations(id),
  name                    text NOT NULL,
  is_active               boolean NOT NULL DEFAULT true,
  min_amount              numeric(18,3),
  max_amount              numeric(18,3),
  min_tenor_days          integer,
  max_tenor_days          integer,
  accepted_transaction_types transaction_type[],
  accepted_recourse_types recourse_type[],
  min_trust_score         integer,
  max_risk_band           risk_band,
  sectors_include         text[],
  sectors_exclude         text[],
  governorates_include    text[],
  buyer_exclude_ids       uuid[],
  supplier_exclude_ids    uuid[],
  default_transaction_type transaction_type,
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE listings (
  id                          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_id              uuid NOT NULL REFERENCES receivable_transactions(id),
  round_number                integer NOT NULL DEFAULT 1,
  status                      listing_status NOT NULL DEFAULT 'OPEN_FOR_OFFERS',
  activated_at                timestamptz NOT NULL DEFAULT now(),
  offer_submission_deadline   timestamptz NOT NULL,
  supplier_selection_deadline timestamptz NOT NULL,
  closed_at                   timestamptz,
  activated_by                uuid NOT NULL REFERENCES users(id),
  UNIQUE (transaction_id, round_number)
);

-- ZM-CON-017: at most one active listing per transaction
CREATE UNIQUE INDEX uq_one_active_listing
  ON listings (transaction_id)
  WHERE status IN ('OPEN_FOR_OFFERS','OFFER_PERIOD_CLOSED','AWAITING_SELECTION');

CREATE TABLE bank_eligibility (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  listing_id      uuid NOT NULL REFERENCES listings(id),
  bank_org_id     uuid NOT NULL REFERENCES organizations(id),
  status          eligibility_status NOT NULL,
  reason          text,
  rules_applied   jsonb NOT NULL DEFAULT '[]',
  evaluated_at    timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz,
  UNIQUE (listing_id, bank_org_id)
);

CREATE TABLE bank_offers (
  id                        uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  listing_id                uuid NOT NULL REFERENCES listings(id),
  bank_org_id               uuid NOT NULL REFERENCES organizations(id),
  status                    offer_status NOT NULL DEFAULT 'DRAFT',
  version_number            integer NOT NULL DEFAULT 1,
  previous_offer_id         uuid REFERENCES bank_offers(id),
  transaction_type          transaction_type NOT NULL,
  recourse_type             recourse_type NOT NULL,
  -- money breakdown (ZM-OFR-001/002)
  gross_funding_amount      numeric(18,3) NOT NULL,
  bank_discount_amount      numeric(18,3) NOT NULL DEFAULT 0,
  bank_fees_amount          numeric(18,3) NOT NULL DEFAULT 0,
  platform_commission_amount numeric(18,3) NOT NULL DEFAULT 0,
  listing_fee_amount        numeric(18,3) NOT NULL DEFAULT 0,
  other_deductions_amount   numeric(18,3) NOT NULL DEFAULT 0,
  net_supplier_payout       numeric(18,3) NOT NULL,
  expected_payout_date      date,
  valid_until               timestamptz NOT NULL,
  created_by                uuid NOT NULL REFERENCES users(id),
  approved_by               uuid REFERENCES users(id),
  approved_at               timestamptz,
  submitted_at              timestamptz,
  withdrawn_at              timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  -- ZM-OFR-002: formula enforced in the database
  CONSTRAINT chk_net_formula CHECK (
    net_supplier_payout = gross_funding_amount
      - bank_discount_amount - bank_fees_amount
      - platform_commission_amount - listing_fee_amount - other_deductions_amount
  ),
  CONSTRAINT chk_amounts_non_negative CHECK (
    gross_funding_amount > 0 AND bank_discount_amount >= 0 AND bank_fees_amount >= 0
    AND platform_commission_amount >= 0 AND listing_fee_amount >= 0
    AND other_deductions_amount >= 0 AND net_supplier_payout > 0
  ),
  -- ZM-ROL-002: maker/approver separation
  CONSTRAINT chk_maker_approver_differ CHECK (approved_by IS NULL OR approved_by <> created_by)
);

-- ZM-OFR-013: one current offer per bank per listing
CREATE UNIQUE INDEX uq_one_current_offer_per_bank
  ON bank_offers (listing_id, bank_org_id)
  WHERE status IN ('DRAFT','PENDING_INTERNAL_APPROVAL','ACTIVE');

CREATE TABLE offer_conditions (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  offer_id        uuid NOT NULL REFERENCES bank_offers(id) ON DELETE CASCADE,
  condition_type  offer_condition_type NOT NULL,
  title           text NOT NULL,
  description     text,
  is_mandatory    boolean NOT NULL DEFAULT true,
  display_order   integer NOT NULL DEFAULT 0,
  fulfilment      condition_fulfilment NOT NULL DEFAULT 'PENDING',
  fulfilled_at    timestamptz,
  fulfilled_by    uuid REFERENCES users(id),
  waiver_reason   text
);

CREATE TABLE offer_selections (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  listing_id          uuid NOT NULL UNIQUE REFERENCES listings(id),
  offer_id            uuid NOT NULL UNIQUE REFERENCES bank_offers(id),
  selected_by         uuid NOT NULL REFERENCES users(id),
  selected_at         timestamptz NOT NULL DEFAULT now(),
  supplier_acknowledgement boolean NOT NULL DEFAULT true
);

-- ZM-SEL-007: immutable freeze at selection
CREATE TABLE accepted_offer_snapshots (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  selection_id          uuid NOT NULL UNIQUE REFERENCES offer_selections(id),
  transaction_id        uuid NOT NULL REFERENCES receivable_transactions(id),
  bank_org_id           uuid NOT NULL REFERENCES organizations(id),
  supplier_org_id       uuid NOT NULL REFERENCES organizations(id),
  source_offer_id       uuid NOT NULL REFERENCES bank_offers(id),
  source_offer_version  integer NOT NULL,
  transaction_type      transaction_type NOT NULL,
  recourse_type         recourse_type NOT NULL,
  gross_funding_amount  numeric(18,3) NOT NULL,
  bank_discount_amount  numeric(18,3) NOT NULL,
  bank_fees_amount      numeric(18,3) NOT NULL,
  platform_commission_amount numeric(18,3) NOT NULL,
  listing_fee_amount    numeric(18,3) NOT NULL,
  other_deductions_amount numeric(18,3) NOT NULL,
  net_supplier_payout   numeric(18,3) NOT NULL,
  conditions_snapshot   jsonb NOT NULL,
  snapshot_hash         text NOT NULL,
  captured_at           timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- 10. CONTRACTS AND SIGNATURES
-- =====================================================================

CREATE TABLE contract_templates (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_type  transaction_type,   -- NULL = fallback default
  language          language_code NOT NULL,
  version           text NOT NULL,
  body_template     text NOT NULL,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (transaction_type, language, version)
);

CREATE TABLE contracts (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_id        uuid NOT NULL UNIQUE REFERENCES receivable_transactions(id),
  snapshot_id           uuid NOT NULL REFERENCES accepted_offer_snapshots(id),
  contract_number       text NOT NULL UNIQUE,
  template_id           uuid NOT NULL REFERENCES contract_templates(id),
  template_version      text NOT NULL,
  canonical_language    language_code NOT NULL DEFAULT 'EN',  -- ZM-I18N-003b
  status                contract_status NOT NULL DEFAULT 'GENERATED',
  document_id           uuid REFERENCES documents(id),
  document_hash         text,
  terms_snapshot        jsonb NOT NULL,
  generated_at          timestamptz NOT NULL DEFAULT now(),
  fully_signed_at       timestamptz
);

CREATE TABLE contract_signatures (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  contract_id           uuid NOT NULL REFERENCES contracts(id),
  signer_user_id        uuid NOT NULL REFERENCES users(id),
  signer_org_id         uuid NOT NULL REFERENCES organizations(id),
  signer_capacity       signer_capacity NOT NULL,
  status                signature_status NOT NULL DEFAULT 'PENDING',
  provider_name         text NOT NULL DEFAULT 'DUMMY',
  signed_document_hash  text,
  signed_at             timestamptz,
  ip_address            inet,
  device_info           text,
  verification_result   jsonb,
  verified_at           timestamptz,
  UNIQUE (contract_id, signer_user_id)
);

-- placeholder for future perfection evidence (LT-09)
CREATE TABLE assignment_records (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  contract_id   uuid NOT NULL REFERENCES contracts(id),
  registry_name text,
  reference     text,
  evidence_document_id uuid REFERENCES documents(id),
  recorded_by   uuid REFERENCES users(id),
  recorded_at   timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- 11. FUNDING, OTP, SETTLEMENT, LEDGER
-- =====================================================================

CREATE TABLE funding_otps (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_id      uuid NOT NULL REFERENCES receivable_transactions(id),
  otp_hash            text NOT NULL,
  generated_by        uuid NOT NULL REFERENCES users(id),   -- bank user
  generated_at        timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  status              otp_status NOT NULL DEFAULT 'SENT',
  attempt_count       integer NOT NULL DEFAULT 0,
  max_attempts        integer NOT NULL DEFAULT 5,
  resend_count        integer NOT NULL DEFAULT 0,
  max_resends         integer NOT NULL DEFAULT 3,
  verified_at         timestamptz,
  verified_by         uuid REFERENCES users(id),            -- supplier user
  CONSTRAINT chk_attempts CHECK (attempt_count <= max_attempts)
);

CREATE TABLE funding_otp_events (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  otp_id        uuid NOT NULL REFERENCES funding_otps(id),
  event         text NOT NULL,  -- GENERATED | RESENT | ATTEMPT_FAILED | VERIFIED | EXPIRED
  actor_user_id uuid REFERENCES users(id),
  ip_address    inet,
  occurred_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE settlements (
  id                        uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_id            uuid NOT NULL UNIQUE REFERENCES receivable_transactions(id),
  snapshot_id               uuid NOT NULL REFERENCES accepted_offer_snapshots(id),
  status                    settlement_status NOT NULL DEFAULT 'PENDING',
  gross_funding_amount      numeric(18,3) NOT NULL,
  platform_commission_amount numeric(18,3) NOT NULL,
  listing_fee_deducted      numeric(18,3) NOT NULL DEFAULT 0,
  net_supplier_payout       numeric(18,3) NOT NULL,
  provider_name             text NOT NULL DEFAULT 'DUMMY',
  provider_reference        text,
  idempotency_key           text NOT NULL UNIQUE,   -- ZM-FND-018
  bank_marked_sent_at       timestamptz,
  bank_marked_sent_by       uuid REFERENCES users(id),
  funding_received_at       timestamptz,
  payout_initiated_at       timestamptz,
  payout_completed_at       timestamptz,
  retry_count               integer NOT NULL DEFAULT 0,
  max_retries               integer NOT NULL DEFAULT 3,
  failure_reason            text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_settlement_split CHECK (
    gross_funding_amount >= platform_commission_amount + listing_fee_deducted + net_supplier_payout
  )
);

CREATE TABLE settlement_attempts (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  settlement_id uuid NOT NULL REFERENCES settlements(id),
  attempt_no    integer NOT NULL,
  request_payload jsonb,
  response_payload jsonb,
  succeeded     boolean NOT NULL,
  failure_reason text,
  attempted_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (settlement_id, attempt_no)
);

CREATE TABLE commission_tiers (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  min_transaction_amount numeric(18,3) NOT NULL,
  max_transaction_amount numeric(18,3),
  commission_percentage numeric(7,5) NOT NULL DEFAULT 0,
  fixed_commission_amount numeric(18,3) NOT NULL DEFAULT 0,
  fee_payer             fee_payer NOT NULL DEFAULT 'SUPPLIER',
  effective_from        timestamptz NOT NULL,
  effective_to          timestamptz,
  is_active             boolean NOT NULL DEFAULT true,
  created_by            uuid REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE commission_calculations (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_id        uuid NOT NULL REFERENCES receivable_transactions(id),
  tier_id               uuid NOT NULL REFERENCES commission_tiers(id),
  basis_amount          numeric(18,3) NOT NULL,   -- gross_funding_amount only
  applied_percentage    numeric(7,5) NOT NULL,
  applied_fixed_amount  numeric(18,3) NOT NULL,
  commission_amount     numeric(18,3) NOT NULL,
  fee_payer             fee_payer NOT NULL,
  status                commission_calc_status NOT NULL DEFAULT 'CALCULATED',
  finalized_at          timestamptz,              -- only on SUPPLIER_PAYOUT_COMPLETED
  reversed_by_id        uuid REFERENCES commission_calculations(id),
  calculated_at         timestamptz NOT NULL DEFAULT now()
);

-- ZM-FEE-001..005: incurred at listing activation regardless of outcome
CREATE TABLE listing_fee_obligations (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  listing_id      uuid NOT NULL UNIQUE REFERENCES listings(id),
  supplier_org_id uuid NOT NULL REFERENCES organizations(id),
  amount          numeric(18,3) NOT NULL,
  status          fee_obligation_status NOT NULL DEFAULT 'PAYABLE',
  settled_at      timestamptz,
  settlement_id   uuid REFERENCES settlements(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ZM-FEE-016..019: double-entry, append-only, must balance
CREATE TABLE ledger_entries (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  journal_id      uuid NOT NULL,          -- groups the balanced set
  entry_type      ledger_entry_type NOT NULL,
  account_kind    ledger_account_kind NOT NULL,
  organization_id uuid REFERENCES organizations(id),
  amount          numeric(18,3) NOT NULL CHECK (amount > 0),
  currency        char(3) NOT NULL DEFAULT 'JOD',
  transaction_id  uuid REFERENCES receivable_transactions(id),
  settlement_id   uuid REFERENCES settlements(id),
  description     text NOT NULL,
  reverses_entry_id uuid REFERENCES ledger_entries(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ledger_journal ON ledger_entries (journal_id);

-- =====================================================================
-- 12. POST-FUNDING PAYMENTS
-- =====================================================================

CREATE TABLE buyer_payments (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_id    uuid NOT NULL REFERENCES receivable_transactions(id),
  amount            numeric(18,3) NOT NULL CHECK (amount > 0),
  payment_date      date NOT NULL,
  bank_reference    text,
  evidence_document_id uuid REFERENCES documents(id),
  -- ZM-PMT-018: supplier must not see this
  bank_internal_notes text,
  reported_by       uuid NOT NULL REFERENCES users(id),
  reported_at       timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- 13. RECOURSE, DISPUTES, WITHDRAWAL, FRAUD
-- =====================================================================

CREATE TABLE recourse_cases (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_id    uuid NOT NULL REFERENCES receivable_transactions(id),
  reason            recourse_reason NOT NULL,
  reason_notes      text,
  requested_amount  numeric(18,3) NOT NULL,
  repaid_amount     numeric(18,3) NOT NULL DEFAULT 0,
  remaining_amount  numeric(18,3) NOT NULL,
  status            recourse_status NOT NULL DEFAULT 'RECOURSE_INITIATED',
  initiated_by      uuid NOT NULL REFERENCES users(id),   -- bank user only
  initiated_at      timestamptz NOT NULL DEFAULT now(),
  settled_at        timestamptz
);

CREATE TABLE recourse_repayments (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  recourse_case_id  uuid NOT NULL REFERENCES recourse_cases(id),
  amount            numeric(18,3) NOT NULL,
  provider_reference text,
  status            settlement_status NOT NULL DEFAULT 'PENDING',
  evidence_document_id uuid REFERENCES documents(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE disputes (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_id  uuid NOT NULL REFERENCES receivable_transactions(id),
  dispute_type    text NOT NULL,
  amount          numeric(18,3),
  status          dispute_status NOT NULL DEFAULT 'OPEN',
  raised_by_org_id uuid NOT NULL REFERENCES organizations(id),
  raised_by       uuid NOT NULL REFERENCES users(id),
  description     text NOT NULL,
  resolution_notes text,
  raised_at       timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz
);

CREATE TABLE withdrawal_cases (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_id        uuid NOT NULL REFERENCES receivable_transactions(id),
  offer_id              uuid NOT NULL REFERENCES bank_offers(id),
  bank_org_id           uuid NOT NULL REFERENCES organizations(id),
  reason                withdrawal_reason NOT NULL,
  reason_notes          text,
  status                withdrawal_status NOT NULL DEFAULT 'WITHDRAWAL_REQUESTED',
  penalty_applicable    boolean,
  penalty_amount        numeric(18,3),
  relisting_eligible    boolean,
  admin_decision_notes  text,
  decided_by            uuid REFERENCES users(id),
  requested_at          timestamptz NOT NULL DEFAULT now(),
  closed_at             timestamptz
);

CREATE TABLE fraud_cases (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_id  uuid REFERENCES receivable_transactions(id),
  organization_id uuid REFERENCES organizations(id),
  status          fraud_case_status NOT NULL DEFAULT 'OPEN',
  summary         text NOT NULL,
  opened_by       uuid REFERENCES users(id),
  assigned_to     uuid REFERENCES users(id),
  decision_notes  text,
  opened_at       timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz
);

CREATE TABLE fraud_indicators (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  fraud_case_id   uuid NOT NULL REFERENCES fraud_cases(id) ON DELETE CASCADE,
  indicator_type  text NOT NULL,
  detected_at     timestamptz NOT NULL DEFAULT now(),
  source_reference text,
  details         jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE case_evidence (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  case_type       text NOT NULL,   -- FRAUD | DISPUTE | RECOURSE | WITHDRAWAL
  case_id         uuid NOT NULL,
  document_id     uuid REFERENCES documents(id),
  description     text,
  added_by        uuid NOT NULL REFERENCES users(id),
  added_at        timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- 14. NOTIFICATIONS
-- =====================================================================

CREATE TABLE notification_templates (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  template_key  text NOT NULL,
  channel       notification_channel NOT NULL,
  language      language_code NOT NULL,
  version       text NOT NULL,
  subject       text,
  body_template text NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,
  UNIQUE (template_key, channel, language, version)
);

CREATE TABLE notifications (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  template_key        text NOT NULL,
  template_version    text,
  channel             notification_channel NOT NULL,
  language            language_code NOT NULL DEFAULT 'EN',
  recipient_user_id   uuid REFERENCES users(id),
  recipient_buyer_id  uuid REFERENCES buyers(id),
  destination         text NOT NULL,
  subject             text,
  body                text NOT NULL,
  status              notification_status NOT NULL DEFAULT 'QUEUED',
  provider_reference  text,
  failure_reason      text,
  retry_count         integer NOT NULL DEFAULT 0,
  manual_call_notes   text,
  manual_call_by      uuid REFERENCES users(id),
  transaction_id      uuid REFERENCES receivable_transactions(id),
  queued_at           timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz,
  delivered_at        timestamptz
);

-- =====================================================================
-- 15. AUDIT AND STATUS HISTORY
-- =====================================================================

CREATE TABLE audit_logs (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_user_id       uuid REFERENCES users(id),
  actor_org_id        uuid REFERENCES organizations(id),   -- active context
  action_type         text NOT NULL,
  target_entity_type  text NOT NULL,
  target_entity_id    uuid,
  previous_value      jsonb,
  new_value           jsonb,
  ip_address          inet,
  device_info         text,
  correlation_id      uuid,
  occurred_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_target ON audit_logs (target_entity_type, target_entity_id);
CREATE INDEX idx_audit_actor  ON audit_logs (actor_user_id, occurred_at DESC);

CREATE TABLE status_history (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  entity_type     text NOT NULL,
  entity_id       uuid NOT NULL,
  previous_status text,
  new_status      text NOT NULL,
  reason          text,
  changed_by      uuid REFERENCES users(id),
  changed_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_status_history_entity ON status_history (entity_type, entity_id, changed_at DESC);

-- =====================================================================
-- 16. PLATFORM CONFIGURATION
-- =====================================================================

CREATE TABLE platform_settings (
  key           text PRIMARY KEY,
  value         jsonb NOT NULL,
  description   text,
  updated_by    uuid REFERENCES users(id),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

INSERT INTO platform_settings (key, value, description) VALUES
  ('offer_submission_window_hours',    '24',        'Hours from listing activation to offer deadline'),
  ('supplier_selection_window_hours',  '12',        'Hours from offer close to selection deadline'),
  ('gov_snapshot_freshness_days',      '90',        'Government snapshot validity window'),
  ('sla_business_hours',               '{"days":[0,1,2,3,4],"start":"08:00","end":"17:00","tz":"Asia/Amman"}', 'Sun-Thu 08:00-17:00 Amman'),
  ('sla_target_business_hours',        '24',        'Onboarding decision SLA'),
  ('otp_validity_minutes',             '15',        'Funding OTP validity'),
  ('otp_max_attempts',                 '5',         'Funding OTP max attempts'),
  ('otp_max_resends',                  '3',         'Funding OTP max resends'),
  ('funding_confirmation_escalation_hours','24',    'Escalate stalled funding confirmation'),
  ('settlement_max_retries',           '3',         'Automatic payout retries'),
  ('listing_fee_amount',               '25.000',    'Flat listing fee in JOD (AS-06)'),
  ('default_fee_payer',                '"SUPPLIER"','Default commission payer (ZM-FEE-009)'),
  ('min_tenor_days',                   '7',         'Minimum days to maturity to list (AS-08)'),
  ('reminder_thresholds_pct',          '[50,15]',   'Selection reminder points (AS-02)'),
  ('maturity_reminder_days',           '[30,14,7]', 'Pre-maturity notification days'),
  ('default_language',                 '"EN"',      'ZM-I18N-003: English default, no locale detection'),
  ('demo_time_machine_enabled',        'false',     'MUST be false in production');

-- =====================================================================
-- 17. DEMO TOOLING (non-production)
-- =====================================================================

CREATE TABLE demo_time_offsets (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  offset_days   integer NOT NULL DEFAULT 0,
  set_by        uuid REFERENCES users(id),
  set_at        timestamptz NOT NULL DEFAULT now(),
  note          text
);

-- =====================================================================
-- ROW LEVEL SECURITY — defense in depth (ZM-ARC-003..005)
-- NestJS is the primary authorization layer; RLS is mandatory backup.
-- Every tenant table gets RLS. Pattern shown; apply to all.
-- =====================================================================

ALTER TABLE receivable_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices                ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_offers             ENABLE ROW LEVEL SECURITY;
ALTER TABLE listings                ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents               ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlements             ENABLE ROW LEVEL SECURITY;
ALTER TABLE buyer_payments          ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_buyer_relationships ENABLE ROW LEVEL SECURITY;

-- helper: organizations the current user belongs to
CREATE OR REPLACE FUNCTION current_user_org_ids() RETURNS uuid[] AS $$
  SELECT coalesce(array_agg(m.organization_id), '{}')
  FROM organization_memberships m
  JOIN users u ON u.id = m.user_id
  WHERE u.auth_user_id = auth.uid() AND m.status = 'ACTIVE';
$$ LANGUAGE sql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION current_user_is_platform() RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM organization_memberships m
    JOIN users u ON u.id = m.user_id
    JOIN organizations o ON o.id = m.organization_id
    WHERE u.auth_user_id = auth.uid()
      AND m.status = 'ACTIVE' AND o.organization_type = 'PLATFORM'
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- supplier sees own transactions; platform sees all;
-- bank sees only transactions it is eligible for or has offered on
CREATE POLICY tx_read ON receivable_transactions FOR SELECT USING (
  supplier_org_id = ANY (current_user_org_ids())
  OR current_user_is_platform()
  OR EXISTS (
    SELECT 1 FROM listings l
    JOIN bank_eligibility be ON be.listing_id = l.id
    WHERE l.transaction_id = receivable_transactions.id
      AND be.bank_org_id = ANY (current_user_org_ids())
      AND be.status = 'ELIGIBLE'
  )
);

-- ZM-MKT-011: a bank may never read another bank's offer
CREATE POLICY offer_read ON bank_offers FOR SELECT USING (
  bank_org_id = ANY (current_user_org_ids())
  OR current_user_is_platform()
  OR EXISTS (
    SELECT 1 FROM listings l
    JOIN receivable_transactions t ON t.id = l.transaction_id
    WHERE l.id = bank_offers.listing_id
      AND t.supplier_org_id = ANY (current_user_org_ids())
      AND bank_offers.status IN ('ACTIVE','SELECTED','NOT_SELECTED')
  )
);

-- append-only enforcement on audit and ledger
CREATE RULE audit_no_update AS ON UPDATE TO audit_logs DO INSTEAD NOTHING;
CREATE RULE audit_no_delete AS ON DELETE TO audit_logs DO INSTEAD NOTHING;
CREATE RULE ledger_no_update AS ON UPDATE TO ledger_entries DO INSTEAD NOTHING;
CREATE RULE ledger_no_delete AS ON DELETE TO ledger_entries DO INSTEAD NOTHING;

-- =====================================================================
-- CRITICAL INVARIANTS (implement as triggers or service-layer guards)
-- =====================================================================
-- INV-1  Offer acceptance is atomic: lock tx, mark selected, mark all
--        others NOT_SELECTED, write snapshot — one transaction or none.
-- INV-2  net_supplier_payout >= tx.minimum_acceptable_amount at accept time.
-- INV-3  gross_funding_amount <= invoice.outstanding_amount.
-- INV-4  A transaction may be locked exactly once (locked_at immutable).
-- INV-5  Commission finalized only when settlement.status = PAYOUT_COMPLETED.
-- INV-6  Ledger journals must balance: sum(DEBIT) = sum(CREDIT) per journal_id.
-- INV-7  No hard delete anywhere on financial or audit tables.
-- INV-8  minimum_acceptable_amount never appears in any bank-facing payload.
-- INV-9  Government unavailability sets source_available=false and MUST NOT
--        reduce any risk score component.
-- INV-10 FUNDED requires BOTH otp.status=VERIFIED AND settlement evidence.
-- =====================================================================
