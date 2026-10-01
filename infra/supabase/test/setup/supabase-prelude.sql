-- Stand-in for what a Supabase project already has, applied before the relay migrations when the
-- tests run on plain PostgreSQL (ADR-0015). Idempotent: roles are cluster-wide and CI shares one
-- server between runs.
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
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator NOINHERIT;
  END IF;
  -- Realtime's own login, which takes on each subscriber's role to apply RLS.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_realtime_admin') THEN
    CREATE ROLE supabase_realtime_admin NOINHERIT;
  END IF;
END
$$;

GRANT anon, authenticated, service_role TO authenticator;

-- Supabase grants its API roles everything in `public` by default. The worst case is assumed
-- here: the same defaults for every schema, so the tests prove the migrations take them back.
ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;

-- Realtime's publication (logical replication needs wal_level=logical only to stream, not to
-- exist).
SET client_min_messages = error;
CREATE PUBLICATION supabase_realtime;
RESET client_min_messages;
