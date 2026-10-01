-- The local server's Realtime doorbell (P5-03d, QR-009; ADR-0015). Supabase Realtime checks each
-- change against the subscriber's RLS by taking on the role its token names (`relay_server`), so
-- its database login must be allowed to. Supabase only; plain PostgreSQL has no Realtime.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_realtime_admin') THEN
    GRANT relay_server TO supabase_realtime_admin;
  END IF;
END
$$;
