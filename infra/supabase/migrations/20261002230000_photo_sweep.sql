-- Menu photos in Storage (P5-03c, MENU-008; ADR-0015): the files are written and swept by the relay's
-- `server` function; the metadata row stays and records when the files went (BRD §9.3: while the
-- dish exists + 90 days), since no relay role deletes rows.
ALTER TABLE relay.photos ADD COLUMN purged_at timestamptz;
GRANT UPDATE (purged_at) ON relay.photos TO relay_writer;

-- The public bucket the QR page loads photos from (through the CDN). Only the `server` function
-- writes to it, with the service-role key; nobody can list it. Supabase only.
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('menu-photos', 'menu-photos', true, 2097152, ARRAY['image/webp'])
    ON CONFLICT (id) DO NOTHING;
  END IF;
END
$$;

-- Retention (BRD §9.3): a photo's record goes a day after its files were swept.
DROP FUNCTION relay.purge(timestamptz);
CREATE FUNCTION relay.purge(as_of timestamptz DEFAULT now())
  RETURNS TABLE (orders bigint, snapshots bigint, service_requests bigint, photos bigint)
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
  WITH old_orders AS (
    DELETE FROM relay.qr_orders
    WHERE coalesce(received_at, expires_at) < as_of - interval '7 days'
    RETURNING 1
  ),
  old_snapshots AS (
    DELETE FROM relay.menu_snapshots AS s
    WHERE s.published_at < as_of - interval '1 day'
      AND s.version < (
        SELECT max(latest.version) FROM relay.menu_snapshots AS latest
        WHERE latest.tenant_id = s.tenant_id
      )
    RETURNING 1
  ),
  old_requests AS (
    DELETE FROM relay.qr_service_requests
    WHERE coalesce(received_at, expires_at) < as_of - interval '7 days'
    RETURNING 1
  ),
  old_photos AS (
    DELETE FROM relay.photos
    WHERE purged_at < as_of - interval '1 day'
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM old_orders), (SELECT count(*) FROM old_snapshots),
         (SELECT count(*) FROM old_requests), (SELECT count(*) FROM old_photos)
$$;

REVOKE ALL ON FUNCTION relay.purge(timestamptz) FROM PUBLIC;

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'authenticator'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION relay.purge(timestamptz) FROM %I', api_role);
    END IF;
  END LOOP;
END
$$;
