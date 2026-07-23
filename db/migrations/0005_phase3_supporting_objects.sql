-- =====================================================================
-- MIGRATION 0005 — Phase 3 supporting objects (additive only)
-- =====================================================================
-- Nothing here creates, alters, or drops a column, constraint, or table
-- that the frozen schema defines. It adds a sequence and three indexes,
-- which hard rule 1 permits without a ruling.
--
-- Why each one exists:
--
--  1. receivable_transactions.reference_number is `text NOT NULL UNIQUE`
--     with no default in the frozen schema, so something has to generate
--     it. Generating in application code and retrying on unique violation
--     works but makes the reference number a function of how many times
--     two requests happened to collide, which is a poor thing to print on
--     a contract. A sequence is monotonic, gap-tolerant, and safe under
--     concurrency without a lock.
--
--  2. Buyer search is name-first (ZM-BUY §7.3 steps 1-3) and Jordanian
--     company names are entered with inconsistent case. The functional
--     index on lower(legal_company_name) makes the ILIKE-equivalent
--     prefix search indexable rather than a sequential scan over every
--     buyer on the platform.
--
--  3. Documents are looked up by what they are attached to on every
--     transaction read (`subject_type`, `subject_id`), and the frozen
--     schema indexes documents by owner only.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Transaction reference numbers
-- ---------------------------------------------------------------------
-- Starts at 1000 so the first reference is ZM-1000 rather than ZM-1: a
-- fixed-width reference is easier to read aloud, quote in a support call,
-- and eyeball for transposition, and there is no value in advertising
-- that a transaction was the first one.
CREATE SEQUENCE IF NOT EXISTS transaction_reference_seq START WITH 1000 INCREMENT BY 1;

-- A function rather than a column DEFAULT: adding a DEFAULT to
-- receivable_transactions.reference_number would alter a frozen column
-- definition. The service calls this in the same statement that inserts
-- the row, so the number is allocated exactly once per transaction.
CREATE OR REPLACE FUNCTION next_transaction_reference() RETURNS text AS $$
  SELECT 'ZM-' || nextval('transaction_reference_seq')::text;
$$ LANGUAGE sql VOLATILE;

-- The sequence is server-side infrastructure. Direct-SQL clients have no
-- write privileges anywhere (migration 0003), and nextval on a sequence
-- they can reach would let them burn reference numbers.
REVOKE ALL ON SEQUENCE transaction_reference_seq FROM authenticated, anon;

-- ---------------------------------------------------------------------
-- 2. Buyer name search
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_buyers_name_lower
  ON buyers (lower(legal_company_name) text_pattern_ops);

-- ---------------------------------------------------------------------
-- 3. Document subject lookup
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_documents_subject
  ON documents (subject_type, subject_id);

-- Extraction rows are always read by document, newest first (the OCR and
-- QR rows for one file, plus any re-run).
CREATE INDEX IF NOT EXISTS idx_document_extractions_document
  ON document_extractions (document_id, created_at DESC);
