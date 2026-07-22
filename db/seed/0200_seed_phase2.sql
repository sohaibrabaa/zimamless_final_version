-- =====================================================================
-- Zimmamless V3 — Phase 2 development seed
--
-- Adds what Phase 2 introduced: the business-calendar holidays the SLA
-- clock reads, and supplier applications in assorted states so Agent B can
-- build every onboarding screen without driving the flow by hand.
--
-- Idempotent and fixed-UUID, like 0100. Safe to re-run.
-- Run AFTER db/seed/0100_seed_dev.sql.
--
--   psql "$DATABASE_URL" -f db/seed/0200_seed_phase2.sql
--
-- NEVER against production: 0100 creates accounts on a published password.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Business calendar (ZM-SON-007)
--
-- The SLA clock reads this table on every computation. It was EMPTY after
-- Phase 1, which does not fail — it silently means "no public holidays
-- exist", so every holiday span in the business-time arithmetic was
-- unreachable with real data. The unit tests cover holiday spans with
-- injected sets; this makes the deployed system exercise them too.
--
-- Islamic-calendar dates are lunar and are confirmed locally only weeks in
-- advance, so the ones below are APPROXIMATIONS chosen for fixture
-- purposes. They are deliberately plausible rather than authoritative: the
-- product owner should replace them with the official Jordanian calendar
-- before any real use. The fixed-date holidays are correct.
-- ---------------------------------------------------------------------
INSERT INTO business_calendar_holidays (holiday_date, description) VALUES
  ('2026-01-01', 'New Year''s Day'),
  ('2026-01-16', 'Prophet''s Birthday (approximate — lunar)'),
  ('2026-03-20', 'Eid al-Fitr (approximate — lunar)'),
  ('2026-03-21', 'Eid al-Fitr holiday (approximate — lunar)'),
  ('2026-03-22', 'Eid al-Fitr holiday (approximate — lunar)'),
  ('2026-05-01', 'Labour Day'),
  ('2026-05-25', 'Independence Day'),
  ('2026-05-27', 'Eid al-Adha (approximate — lunar)'),
  ('2026-05-28', 'Eid al-Adha holiday (approximate — lunar)'),
  ('2026-05-29', 'Eid al-Adha holiday (approximate — lunar)'),
  ('2026-06-16', 'Islamic New Year (approximate — lunar)'),
  ('2026-12-25', 'Christmas Day')
ON CONFLICT (holiday_date) DO UPDATE SET description = EXCLUDED.description;

-- ---------------------------------------------------------------------
-- 2. Supplier applications in assorted states
--
-- S1 (Al-Noor) and S2 (Petra) are already ACTIVE organizations from 0100.
-- Their applications are backfilled as decided history so the reviewer
-- queue and the supplier's own "my application" screen have content, and
-- so the demo's protagonist has a plausible past.
--
-- The SLA columns on supplier_applications are NOT written here. They are
-- a cache the API derives from sla_clock_events (ZM-SON-008); seeding them
-- directly would create exactly the drift that design exists to prevent.
-- The events below are the real source, and the API recomputes from them.
-- ---------------------------------------------------------------------

-- S1 — approved, the completed happy path.
INSERT INTO supplier_applications (id, organization_id, status, submitted_at, decided_at, decided_by, decision_reason_code, decision_notes)
SELECT '0e200000-0000-4000-8000-000000000001',
       '0e000000-0000-4000-8000-000000000002',
       'APPROVED',
       timestamptz '2026-07-15 09:00:00+03',
       timestamptz '2026-07-16 11:30:00+03',
       u.id,
       'ALL_CHECKS_PASSED',
       'Registry, tax and licence all verified against CCD, ISTD and GAM.'
  FROM users u WHERE u.email = 'reviewer@platform.zimmamless.test'
ON CONFLICT (id) DO NOTHING;

INSERT INTO sla_clock_events (id, application_id, event, reason, actor_user_id, occurred_at) VALUES
  ('0e201000-0000-4000-8000-000000000001', '0e200000-0000-4000-8000-000000000001', 'START', 'APPLICATION_SUBMITTED', NULL, timestamptz '2026-07-15 09:00:00+03'),
  ('0e201000-0000-4000-8000-000000000002', '0e200000-0000-4000-8000-000000000001', 'STOP',  'DECISION_APPROVED',     NULL, timestamptz '2026-07-16 11:30:00+03')
ON CONFLICT (id) DO NOTHING;

-- S2 — paused on an open information request. This is the state the phase
-- file calls out explicitly: the supplier sees "paused, waiting on you",
-- and the reviewer sees an item they are not being timed on.
INSERT INTO supplier_applications (id, organization_id, status, submitted_at)
VALUES ('0e200000-0000-4000-8000-000000000002',
        '0e000000-0000-4000-8000-000000000003',
        'INFORMATION_REQUIRED',
        timestamptz '2026-07-21 10:00:00+03')
ON CONFLICT (id) DO NOTHING;

INSERT INTO sla_clock_events (id, application_id, event, reason, actor_user_id, occurred_at) VALUES
  ('0e201000-0000-4000-8000-000000000011', '0e200000-0000-4000-8000-000000000002', 'START', 'APPLICATION_SUBMITTED', NULL, timestamptz '2026-07-21 10:00:00+03'),
  -- Paused 3 business hours in, so remaining reads 21 business hours.
  ('0e201000-0000-4000-8000-000000000012', '0e200000-0000-4000-8000-000000000002', 'PAUSE', 'INFORMATION_REQUESTED', NULL, timestamptz '2026-07-21 13:00:00+03')
ON CONFLICT (id) DO NOTHING;

INSERT INTO information_requests (id, subject_type, subject_id, requested_item, description, status, requested_by, requested_at)
SELECT '0e202000-0000-4000-8000-000000000001',
       'SUPPLIER_APPLICATION',
       '0e200000-0000-4000-8000-000000000002',
       'BANK_ACCOUNT_EVIDENCE',
       'Please upload a bank letter or statement header confirming ownership of the IBAN provided.',
       'OPEN',
       u.id,
       timestamptz '2026-07-21 13:00:00+03'
  FROM users u WHERE u.email = 'reviewer@platform.zimmamless.test'
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------
-- 3. Consents for S1, so the consent history screen is not empty.
-- ---------------------------------------------------------------------
INSERT INTO consent_records (id, organization_id, user_id, consent_type, consent_version, consent_text_hash, granted, granted_at)
SELECT '0e203000-0000-4000-8000-000000000001',
       '0e000000-0000-4000-8000-000000000002',
       u.id, 'PLATFORM_TERMS', 'v1.0',
       encode(digest('PLATFORM_TERMS:v1.0', 'sha256'), 'hex'),
       true, timestamptz '2026-07-15 08:55:00+03'
  FROM users u WHERE u.email = 'owner@alnoor.zimmamless.test'
ON CONFLICT (id) DO NOTHING;

INSERT INTO consent_records (id, organization_id, user_id, consent_type, consent_version, consent_text_hash, granted, granted_at)
SELECT '0e203000-0000-4000-8000-000000000002',
       '0e000000-0000-4000-8000-000000000002',
       u.id, 'GOVERNMENT_DATA_ACCESS', 'v1.0',
       encode(digest('GOVERNMENT_DATA_ACCESS:v1.0', 'sha256'), 'hex'),
       true, timestamptz '2026-07-15 08:56:00+03'
  FROM users u WHERE u.email = 'owner@alnoor.zimmamless.test'
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------
-- 4. Tidy the organizations created while verifying the flow live.
--
-- These were registered through POST /onboarding/register during Phase 2
-- verification, so their legal names are the pre-lookup placeholder
-- ("Establishment 20000103"). Their ids are random rather than fixed —
-- they are NOT fixtures Agent B should hard-code — but leaving a
-- placeholder name on a real row in the shared dev database makes the
-- reviewer queue read like a bug. Names only; nothing else is touched.
-- ---------------------------------------------------------------------
UPDATE organizations SET legal_name = 'Jordan Valley Foods'
 WHERE national_establishment_no = '20000103' AND legal_name LIKE 'Establishment %';
UPDATE organizations SET legal_name = 'Hani Auto Parts Establishment'
 WHERE national_establishment_no = '20000104' AND legal_name LIKE 'Establishment %';

COMMIT;

-- =====================================================================
-- VERIFY
-- =====================================================================
SELECT 'holidays' AS entity, count(*) FROM business_calendar_holidays
UNION ALL SELECT 'applications',        count(*) FROM supplier_applications
UNION ALL SELECT 'sla clock events',    count(*) FROM sla_clock_events
UNION ALL SELECT 'information requests',count(*) FROM information_requests
UNION ALL SELECT 'consents',            count(*) FROM consent_records;

-- The paused application must report remaining < 24h and no deadline when
-- read back through GET /onboarding/applications/{id}.
SELECT a.id, o.legal_name, a.status,
       (SELECT string_agg(e.event, ' → ' ORDER BY e.occurred_at)
          FROM sla_clock_events e WHERE e.application_id = a.id) AS clock_history
  FROM supplier_applications a
  JOIN organizations o ON o.id = a.organization_id
 ORDER BY a.submitted_at NULLS LAST;
