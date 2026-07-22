-- =====================================================================
-- DEV SEED — paste into the Supabase SQL editor and Run.
-- =====================================================================
-- Creates the Phase 1 persona population: 6 organizations, 15 users with
-- working Supabase Auth logins, their memberships and role grants, and 6
-- buyers. Mirrors docs/specs/GOV_DUMMY_DATA.md, which is the shared
-- identity contract with Agent B's mock fixtures.
--
-- Every id is a fixed literal, so this is idempotent (safe to re-run) and
-- Agent B can hard-code the same ids in mocks.
--
-- PASSWORD FOR EVERY ACCOUNT:  Zimmamless#2026
--
-- Requires: migrations 0000-0003 applied.
-- Never run against production: these are published credentials.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. ORGANIZATIONS
--
-- Suppliers are seeded ACTIVE so Agent B has a fully-onboarded supplier
-- from the Phase 1 checkpoint. The onboarding journey itself is Phase 2
-- and uses a third supplier that this seed deliberately omits.
-- Banks are ACTIVE by seed because bank onboarding is seed-only (PA-01).
-- ---------------------------------------------------------------------

INSERT INTO organizations
  (id, organization_type, legal_name, status, national_establishment_no,
   commercial_registration_no, tax_number, bank_licence_number, swift_code,
   contact_email, platform_terms_version)
VALUES
  ('0e000000-0000-4000-8000-000000000001','PLATFORM','Zimmamless Platform','ACTIVE','40000001',
   NULL,NULL,NULL,NULL,'contact@platform.zimmamless.test','v1.0'),
  ('0e000000-0000-4000-8000-000000000002','SUPPLIER','Al-Noor Trading Company','ACTIVE','20000101',
   'CR-20000101','TAX-20000101',NULL,NULL,'contact@alnoor.zimmamless.test','v1.0'),
  ('0e000000-0000-4000-8000-000000000003','SUPPLIER','Petra Industrial Supplies','ACTIVE','20000102',
   'CR-20000102','TAX-20000102',NULL,NULL,'contact@petra.zimmamless.test','v1.0'),
  ('0e000000-0000-4000-8000-000000000004','BANK','Jordan National Bank','ACTIVE','40000301',
   NULL,NULL,'CBJ-2019-011','JNBAJOAX','contact@jnb.zimmamless.test','v1.0'),
  ('0e000000-0000-4000-8000-000000000005','BANK','Levant Commercial Bank','ACTIVE','40000302',
   NULL,NULL,'CBJ-2017-004','LCBKJOAX','contact@lcb.zimmamless.test','v1.0'),
  ('0e000000-0000-4000-8000-000000000006','BANK','Capital Investment Bank','ACTIVE','40000303',
   NULL,NULL,'CBJ-2020-022','CIBKJOAX','contact@cib.zimmamless.test','v1.0')
ON CONFLICT (id) DO UPDATE
  SET legal_name = EXCLUDED.legal_name,
      status     = EXCLUDED.status,
      updated_at = now();

-- ---------------------------------------------------------------------
-- 2-4. PERSONAS: auth accounts, identities, and platform user rows
--
-- The persona list is inlined as VALUES in each statement rather than held
-- in a temp table. The Supabase SQL editor does not guarantee a temp table
-- survives between statements in a script — that is what produced
-- `relation "_seed_users" does not exist`. Repetition is the price of every
-- statement being self-contained and independently re-runnable.
--
-- The three must agree. A platform user without an auth account cannot log
-- in; an auth account without a platform user logs in to an empty /auth/me;
-- an auth user without an identity row fails password sign-in in GoTrue.
--
-- Maker and approver are different people at every bank on purpose:
-- ZM-ROL-002 separation is enforced by the DB CHECK
-- chk_maker_approver_differ, so INV-12 needs two real accounts per bank.
--
-- multi@platform holds memberships in TWO organizations. Without it the
-- org-context switcher (a Phase 1 checkpoint item) can only ever be tested
-- against its failure case.
-- ---------------------------------------------------------------------

-- 2. Supabase Auth accounts.
-- Written directly rather than through the admin API so this stays pure SQL.
-- bcrypt via pgcrypto is exactly what GoTrue itself stores. email_confirmed_at
-- is set because verification is Agent B's client-side flow (PA-04) and
-- seeded personas must be able to log in without an inbox.
-- The token columns below are set to '' rather than left to default.
-- They are NULLABLE in the table but GoTrue scans them into non-nullable Go
-- strings, so a row inserted without them authenticates with:
--   "Database error querying schema"
-- — an error that names neither the column nor the table, and appears at
-- login rather than at insert. Supabase's own signup path always writes '',
-- which is why this only bites seeds written in raw SQL.
INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin,
  confirmation_token, recovery_token, email_change,
  email_change_token_new, email_change_token_current,
  phone_change, phone_change_token, reauthentication_token
)
SELECT
  '00000000-0000-0000-0000-000000000000',
  s.auth_id, 'authenticated', 'authenticated', s.email,
  crypt('Zimmamless#2026', gen_salt('bf')),
  now(), now(), now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  jsonb_build_object('full_name', s.full_name, 'seeded', true),
  false,
  '', '', '', '', '', '', '', ''
FROM (VALUES
  ('0e200000-0000-4000-8000-000000000001'::uuid,'owner@alnoor.zimmamless.test','Rania Haddad'),
  ('0e200000-0000-4000-8000-000000000002','uploader@alnoor.zimmamless.test','Omar Khalil'),
  ('0e200000-0000-4000-8000-000000000003','owner@petra.zimmamless.test','Yousef Nasser'),
  ('0e200000-0000-4000-8000-000000000004','admin@jnb.zimmamless.test','Layla Mansour'),
  ('0e200000-0000-4000-8000-000000000005','maker@jnb.zimmamless.test','Tariq Odeh'),
  ('0e200000-0000-4000-8000-000000000006','approver@jnb.zimmamless.test','Nadia Rifai'),
  ('0e200000-0000-4000-8000-000000000007','ops@jnb.zimmamless.test','Sami Barakat'),
  ('0e200000-0000-4000-8000-000000000008','maker@lcb.zimmamless.test','Huda Salameh'),
  ('0e200000-0000-4000-8000-000000000009','approver@lcb.zimmamless.test','Faris Zoubi'),
  ('0e200000-0000-4000-8000-00000000000a','ops@lcb.zimmamless.test','Dina Aql'),
  ('0e200000-0000-4000-8000-00000000000b','maker@cib.zimmamless.test','Bashar Tell'),
  ('0e200000-0000-4000-8000-00000000000c','admin@platform.zimmamless.test','Zaid Qasem'),
  ('0e200000-0000-4000-8000-00000000000d','reviewer@platform.zimmamless.test','Maha Darwish'),
  ('0e200000-0000-4000-8000-00000000000e','compliance@platform.zimmamless.test','Khalid Amir'),
  ('0e200000-0000-4000-8000-00000000000f','multi@platform.zimmamless.test','Sara Yaseen')
) AS s(auth_id, email, full_name)
ON CONFLICT (id) DO UPDATE
  SET encrypted_password = EXCLUDED.encrypted_password,
      email_confirmed_at = now(),
      updated_at         = now();

-- 2b. Heal rows written by an earlier version of this seed, whose ON
-- CONFLICT branch does not touch the token columns. Without this, re-running
-- the seed on a database already carrying NULLs leaves login broken and the
-- fix above looks ineffective.
UPDATE auth.users SET
  confirmation_token         = coalesce(confirmation_token, ''),
  recovery_token             = coalesce(recovery_token, ''),
  email_change               = coalesce(email_change, ''),
  email_change_token_new     = coalesce(email_change_token_new, ''),
  email_change_token_current = coalesce(email_change_token_current, ''),
  phone_change               = coalesce(phone_change, ''),
  phone_change_token         = coalesce(phone_change_token, ''),
  reauthentication_token     = coalesce(reauthentication_token, '')
WHERE email LIKE '%zimmamless.test';

-- 3. Identities. GoTrue requires a matching identity row for email/password
-- sign-in; without it the account exists but authentication fails.
-- Derived from auth.users so the two cannot disagree.
INSERT INTO auth.identities (
  provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at
)
SELECT
  u.id::text, u.id,
  jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
  'email', now(), now(), now()
FROM auth.users u
WHERE u.email LIKE '%zimmamless.test'
ON CONFLICT (provider, provider_id) DO UPDATE
  SET identity_data = EXCLUDED.identity_data,
      updated_at    = now();

-- 4. Platform user rows.
INSERT INTO users (id, auth_user_id, full_name, email, phone_number, preferred_language, status)
SELECT s.user_id, s.auth_id, s.full_name, s.email, s.phone, 'EN', 'ACTIVE'
FROM (VALUES
  ('0e100000-0000-4000-8000-000000000001'::uuid,'0e200000-0000-4000-8000-000000000001'::uuid,'owner@alnoor.zimmamless.test','Rania Haddad','+962790000101'),
  ('0e100000-0000-4000-8000-000000000002','0e200000-0000-4000-8000-000000000002','uploader@alnoor.zimmamless.test','Omar Khalil','+962790000102'),
  ('0e100000-0000-4000-8000-000000000003','0e200000-0000-4000-8000-000000000003','owner@petra.zimmamless.test','Yousef Nasser','+962790000103'),
  ('0e100000-0000-4000-8000-000000000004','0e200000-0000-4000-8000-000000000004','admin@jnb.zimmamless.test','Layla Mansour','+962790000301'),
  ('0e100000-0000-4000-8000-000000000005','0e200000-0000-4000-8000-000000000005','maker@jnb.zimmamless.test','Tariq Odeh','+962790000302'),
  ('0e100000-0000-4000-8000-000000000006','0e200000-0000-4000-8000-000000000006','approver@jnb.zimmamless.test','Nadia Rifai','+962790000303'),
  ('0e100000-0000-4000-8000-000000000007','0e200000-0000-4000-8000-000000000007','ops@jnb.zimmamless.test','Sami Barakat','+962790000304'),
  ('0e100000-0000-4000-8000-000000000008','0e200000-0000-4000-8000-000000000008','maker@lcb.zimmamless.test','Huda Salameh','+962790000305'),
  ('0e100000-0000-4000-8000-000000000009','0e200000-0000-4000-8000-000000000009','approver@lcb.zimmamless.test','Faris Zoubi','+962790000306'),
  ('0e100000-0000-4000-8000-00000000000a','0e200000-0000-4000-8000-00000000000a','ops@lcb.zimmamless.test','Dina Aql','+962790000307'),
  ('0e100000-0000-4000-8000-00000000000b','0e200000-0000-4000-8000-00000000000b','maker@cib.zimmamless.test','Bashar Tell','+962790000308'),
  ('0e100000-0000-4000-8000-00000000000c','0e200000-0000-4000-8000-00000000000c','admin@platform.zimmamless.test','Zaid Qasem','+962790000001'),
  ('0e100000-0000-4000-8000-00000000000d','0e200000-0000-4000-8000-00000000000d','reviewer@platform.zimmamless.test','Maha Darwish','+962790000002'),
  ('0e100000-0000-4000-8000-00000000000e','0e200000-0000-4000-8000-00000000000e','compliance@platform.zimmamless.test','Khalid Amir','+962790000003'),
  ('0e100000-0000-4000-8000-00000000000f','0e200000-0000-4000-8000-00000000000f','multi@platform.zimmamless.test','Sara Yaseen','+962790000004')
) AS s(user_id, auth_id, email, full_name, phone)
ON CONFLICT (id) DO UPDATE
  SET auth_user_id = EXCLUDED.auth_user_id,
      full_name    = EXCLUDED.full_name,
      phone_number = EXCLUDED.phone_number,
      updated_at   = now();

-- ---------------------------------------------------------------------
-- 5. MEMBERSHIPS AND ROLE GRANTS
-- ---------------------------------------------------------------------

INSERT INTO organization_memberships
  (id, user_id, organization_id, status, is_authorized_signatory, job_title)
VALUES
  -- Al-Noor (supplier)
  ('0e400000-0000-4000-8000-000000000001','0e100000-0000-4000-8000-000000000001','0e000000-0000-4000-8000-000000000002','ACTIVE',true ,'Owner'),
  ('0e400000-0000-4000-8000-000000000002','0e100000-0000-4000-8000-000000000002','0e000000-0000-4000-8000-000000000002','ACTIVE',false,'Document Uploader'),
  -- Petra (supplier)
  ('0e400000-0000-4000-8000-000000000003','0e100000-0000-4000-8000-000000000003','0e000000-0000-4000-8000-000000000003','ACTIVE',true ,'Owner'),
  -- Jordan National Bank
  ('0e400000-0000-4000-8000-000000000004','0e100000-0000-4000-8000-000000000004','0e000000-0000-4000-8000-000000000004','ACTIVE',true ,'Bank Administrator'),
  ('0e400000-0000-4000-8000-000000000005','0e100000-0000-4000-8000-000000000005','0e000000-0000-4000-8000-000000000004','ACTIVE',false,'Offer Maker'),
  ('0e400000-0000-4000-8000-000000000006','0e100000-0000-4000-8000-000000000006','0e000000-0000-4000-8000-000000000004','ACTIVE',true ,'Offer Approver'),
  ('0e400000-0000-4000-8000-000000000007','0e100000-0000-4000-8000-000000000007','0e000000-0000-4000-8000-000000000004','ACTIVE',false,'Operations'),
  -- Levant Commercial Bank — the counterparty in every INV-11 test
  ('0e400000-0000-4000-8000-000000000008','0e100000-0000-4000-8000-000000000008','0e000000-0000-4000-8000-000000000005','ACTIVE',false,'Offer Maker'),
  ('0e400000-0000-4000-8000-000000000009','0e100000-0000-4000-8000-000000000009','0e000000-0000-4000-8000-000000000005','ACTIVE',true ,'Offer Approver'),
  ('0e400000-0000-4000-8000-00000000000a','0e100000-0000-4000-8000-00000000000a','0e000000-0000-4000-8000-000000000005','ACTIVE',false,'Operations'),
  -- Capital Investment Bank
  ('0e400000-0000-4000-8000-00000000000b','0e100000-0000-4000-8000-00000000000b','0e000000-0000-4000-8000-000000000006','ACTIVE',false,'Offer Maker'),
  -- Platform
  ('0e400000-0000-4000-8000-00000000000c','0e100000-0000-4000-8000-00000000000c','0e000000-0000-4000-8000-000000000001','ACTIVE',true ,'Super Administrator'),
  ('0e400000-0000-4000-8000-00000000000d','0e100000-0000-4000-8000-00000000000d','0e000000-0000-4000-8000-000000000001','ACTIVE',false,'Supplier Reviewer'),
  ('0e400000-0000-4000-8000-00000000000e','0e100000-0000-4000-8000-00000000000e','0e000000-0000-4000-8000-000000000001','ACTIVE',false,'Compliance Officer'),
  -- Sara Yaseen: two memberships, one user
  ('0e400000-0000-4000-8000-00000000000f','0e100000-0000-4000-8000-00000000000f','0e000000-0000-4000-8000-000000000001','ACTIVE',false,'Support'),
  ('0e400000-0000-4000-8000-000000000010','0e100000-0000-4000-8000-00000000000f','0e000000-0000-4000-8000-000000000003','ACTIVE',false,'Viewer')
ON CONFLICT (id) DO UPDATE
  SET status = 'ACTIVE', is_authorized_signatory = EXCLUDED.is_authorized_signatory;

INSERT INTO membership_roles (membership_id, role)
VALUES
  ('0e400000-0000-4000-8000-000000000001','SUPPLIER_OWNER'),
  ('0e400000-0000-4000-8000-000000000001','SUPPLIER_SIGNATORY'),
  ('0e400000-0000-4000-8000-000000000002','SUPPLIER_UPLOADER'),
  ('0e400000-0000-4000-8000-000000000003','SUPPLIER_OWNER'),
  ('0e400000-0000-4000-8000-000000000003','SUPPLIER_SIGNATORY'),
  ('0e400000-0000-4000-8000-000000000004','BANK_ADMIN'),
  ('0e400000-0000-4000-8000-000000000005','BANK_OFFER_MAKER'),
  ('0e400000-0000-4000-8000-000000000005','BANK_ANALYST'),
  ('0e400000-0000-4000-8000-000000000006','BANK_OFFER_APPROVER'),
  ('0e400000-0000-4000-8000-000000000007','BANK_OPERATIONS'),
  ('0e400000-0000-4000-8000-000000000008','BANK_OFFER_MAKER'),
  ('0e400000-0000-4000-8000-000000000009','BANK_OFFER_APPROVER'),
  ('0e400000-0000-4000-8000-00000000000a','BANK_OPERATIONS'),
  ('0e400000-0000-4000-8000-00000000000b','BANK_OFFER_MAKER'),
  ('0e400000-0000-4000-8000-00000000000c','PLATFORM_SUPER_ADMIN'),
  ('0e400000-0000-4000-8000-00000000000c','PLATFORM_OPS_ADMIN'),
  ('0e400000-0000-4000-8000-00000000000d','PLATFORM_SUPPLIER_REVIEWER'),
  ('0e400000-0000-4000-8000-00000000000e','PLATFORM_COMPLIANCE'),
  ('0e400000-0000-4000-8000-00000000000f','PLATFORM_SUPPORT'),
  ('0e400000-0000-4000-8000-000000000010','SUPPLIER_VIEWER')
ON CONFLICT (membership_id, role) DO NOTHING;

-- ---------------------------------------------------------------------
-- 6. BUYERS
--
-- Buyers are never platform users — registry records plus a debtor row,
-- notified after the fact. B4-B6 carry blocked registry statuses so Agent B
-- can build the block-state screens in Phase 3 without waiting on the
-- buyer-resolution endpoints.
-- ---------------------------------------------------------------------

INSERT INTO buyers
  (id, national_establishment_no, legal_company_name, registry_status,
   governorate, company_type, registered_address, last_verified_at)
VALUES
  ('0e300000-0000-4000-8000-000000000001','30000201','Amman Retail Group','ACTIVE','Amman','LLC','Amman, Jordan',now()),
  ('0e300000-0000-4000-8000-000000000002','30000202','Levant Construction Co.','ACTIVE','Amman','LLC','Amman, Jordan',now()),
  ('0e300000-0000-4000-8000-000000000003','30000203','Aqaba Logistics Ltd','ACTIVE','Aqaba','LLC','Aqaba, Jordan',now()),
  ('0e300000-0000-4000-8000-000000000004','30000204','Northern Textiles','SUSPENDED','Irbid','LLC','Irbid, Jordan',now()),
  ('0e300000-0000-4000-8000-000000000005','30000205','Desert Rose Trading','STRUCK_OFF','Amman','LLC','Amman, Jordan',now()),
  ('0e300000-0000-4000-8000-000000000006','30000206','Capital Medical Supplies','UNDER_LIQUIDATION','Zarqa','LLC','Zarqa, Jordan',now())
ON CONFLICT (id) DO UPDATE
  SET legal_company_name = EXCLUDED.legal_company_name,
      registry_status    = EXCLUDED.registry_status,
      updated_at         = now();

COMMIT;

-- =====================================================================
-- VERIFY (expect: 6 orgs, 15 users, 15 auth users, 16 memberships,
--                 20 role grants, 6 buyers)
-- =====================================================================
SELECT 'organizations' AS entity, count(*) FROM organizations
UNION ALL SELECT 'users',            count(*) FROM users
UNION ALL SELECT 'auth.users',       count(*) FROM auth.users WHERE email LIKE '%zimmamless.test'
UNION ALL SELECT 'auth.identities',  count(*) FROM auth.identities WHERE provider='email'
UNION ALL SELECT 'memberships',      count(*) FROM organization_memberships
UNION ALL SELECT 'role grants',      count(*) FROM membership_roles
UNION ALL SELECT 'buyers',           count(*) FROM buyers;

-- The multi-org user must show TWO rows — this is what makes the
-- context switcher testable at the Phase 1 checkpoint.
SELECT u.email, o.legal_name, o.organization_type, array_agg(r.role ORDER BY r.role) AS roles
FROM users u
JOIN organization_memberships m ON m.user_id = u.id
JOIN organizations o            ON o.id = m.organization_id
LEFT JOIN membership_roles r    ON r.membership_id = m.id
WHERE u.email = 'multi@platform.zimmamless.test'
GROUP BY u.email, o.legal_name, o.organization_type;
