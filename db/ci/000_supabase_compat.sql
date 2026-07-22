-- =====================================================================
-- SUPABASE COMPATIBILITY SHIM — CI AND LOCAL POSTGRES ONLY
-- =====================================================================
-- NOT a migration. Never applied to a Supabase project, where every object
-- below already exists and is managed by the platform. The migration runner
-- ignores this directory; CI applies it explicitly before 0000.
--
-- Why it exists
-- -------------
-- The frozen schema and migration 0003 depend on things Supabase provides
-- but plain PostgreSQL does not:
--   * the `anon`, `authenticated`, and `service_role` roles
--   * the `auth` schema and auth.uid(), which every RLS policy calls
--   * auth.users / auth.identities, which the dev seed writes to
--
-- Without this shim the RLS suite could only ever run against a hosted
-- project. That would make the most security-critical tests in the build
-- (INV-11, the D-02 floor revoke) dependent on network access and shared
-- state — so they would be skipped, which is how confidentiality holes
-- reach production.
--
-- The definitions mirror Supabase's own closely enough for the policies to
-- behave identically; they are not a reimplementation of GoTrue.
-- =====================================================================

-- --- Roles -----------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Supabase grants broadly by default and relies on RLS to constrain reads.
-- Reproduced here so migration 0003's REVOKEs are actually revoking
-- something — if CI started from a deny-all baseline, 0003 would appear to
-- pass while doing nothing, and the hosted project would still be wide open.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO anon, authenticated, service_role;

-- --- auth schema -----------------------------------------------------
CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS auth.users (
  instance_id        uuid,
  id                 uuid PRIMARY KEY,
  aud                varchar(255),
  role               varchar(255),
  email              varchar(255) UNIQUE,
  encrypted_password varchar(255),
  email_confirmed_at timestamptz,
  invited_at         timestamptz,
  confirmation_token varchar(255),
  recovery_token     varchar(255),
  last_sign_in_at    timestamptz,
  raw_app_meta_data  jsonb,
  raw_user_meta_data jsonb,
  is_super_admin     boolean,
  created_at         timestamptz DEFAULT now(),
  updated_at         timestamptz DEFAULT now(),
  phone              text,
  banned_until       timestamptz,
  deleted_at         timestamptz
);

CREATE TABLE IF NOT EXISTS auth.identities (
  provider_id     text NOT NULL,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  identity_data   jsonb NOT NULL,
  provider        text NOT NULL,
  last_sign_in_at timestamptz,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now(),
  email           text,
  id              uuid DEFAULT gen_random_uuid(),
  PRIMARY KEY (provider, provider_id)
);

-- --- auth.uid() ------------------------------------------------------
-- The function every RLS policy in the frozen schema calls. Supabase reads
-- the authenticated user from the request.jwt.claims GUC that PostgREST
-- sets from the bearer token; the persona test helper sets the same GUC, so
-- the policies are exercised through exactly the path a real client uses.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

CREATE OR REPLACE FUNCTION auth.role() RETURNS text
LANGUAGE sql STABLE
AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

CREATE OR REPLACE FUNCTION auth.email() RETURNS text
LANGUAGE sql STABLE
AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  )::text
$$;

GRANT EXECUTE ON FUNCTION auth.uid(), auth.role(), auth.email()
  TO anon, authenticated, service_role;

-- The seed writes these directly; RLS on them is Supabase's business, not
-- ours, but they must not be readable by application roles here either.
REVOKE ALL ON auth.users, auth.identities FROM anon, authenticated;
