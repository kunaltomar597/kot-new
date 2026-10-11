-- The local server's Realtime doorbell (P5-03d, QR-009; ADR-0015). Supabase Realtime checks each
-- change against the subscriber's RLS by taking on the role its token names (`relay_server`), so
-- the login it uses must be allowed to.
--
-- On Supabase, Realtime logs in as `supabase_admin`, a superuser that may take on any role, and
-- `supabase_realtime_admin` is reserved: nobody but a superuser may change who it belongs to
-- (supautils `reserved_memberships`). So nothing is granted there. Where the role is an ordinary
-- one (plain PostgreSQL standing in for Supabase), it is given `relay_server` only.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_realtime_admin') THEN
    BEGIN
      GRANT relay_server TO supabase_realtime_admin;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'supabase_realtime_admin is reserved here; Realtime takes on relay_server as supabase_admin';
    END;
  END IF;
END
$$;
