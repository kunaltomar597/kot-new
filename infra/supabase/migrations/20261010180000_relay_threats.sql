-- Fixes from the relay's threat model (P8-03b4b; docs/security/threat-models/qr-relay-and-site.md).

-- RELAY-E3: the edge functions' login no longer holds the provisioning role (the first migration
-- no longer grants it; this takes it back where it did). The Control Plane has a login of its own
-- for it (relay_control_plane, given a password by hand: manual task 20), which can take that role
-- and nothing else, so a flaw in a diner's function cannot create or change a restaurant or its
-- credentials.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'relay_control_plane') THEN
    CREATE ROLE relay_control_plane NOLOGIN NOINHERIT;
  END IF;
END
$$;
REVOKE relay_provisioner FROM relay_edge;
GRANT relay_provisioner TO relay_control_plane;

-- RELAY-D1: orders the restaurant rejected no longer count against the table, so junk sent with a
-- table's code stops blocking the diners there once the waiter rejects it. They still count
-- against the browser that sent them. Otherwise as in 20261002150000_qr_order_limits.sql.
CREATE OR REPLACE FUNCTION relay.rate_limit_wait(browser text) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  tenant uuid := relay.claim_tenant();
  dining_table uuid := relay.claim_table();
  max_orders integer;
  window_length interval;
  table_free_at timestamptz;
  browser_free_at timestamptz;
BEGIN
  IF tenant IS NULL OR dining_table IS NULL OR browser IS NULL THEN
    RAISE EXCEPTION 'QR_SCOPE_MISSING' USING ERRCODE = '42501';
  END IF;
  SELECT s.submissions_per_window, make_interval(mins => s.rate_limit_window_minutes)
    INTO max_orders, window_length
    FROM relay.tenant_settings AS s WHERE s.tenant_id = tenant;
  max_orders := coalesce(max_orders, 5);
  window_length := coalesce(window_length, interval '10 minutes');

  PERFORM pg_advisory_xact_lock(hashtextextended('relay.table:' || tenant || ':' || dining_table, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('relay.browser:' || tenant || ':' || browser, 0));

  -- The window frees up when the max-th most recent order in it falls out.
  SELECT o.submitted_at + window_length INTO table_free_at
    FROM relay.qr_orders AS o
    WHERE o.tenant_id = tenant AND o.table_id = dining_table AND o.status <> 'REJECTED'
      AND o.submitted_at > now() - window_length
    ORDER BY o.submitted_at DESC OFFSET max_orders - 1 LIMIT 1;
  SELECT o.submitted_at + window_length INTO browser_free_at
    FROM relay.qr_orders AS o
    WHERE o.tenant_id = tenant AND o.browser_id = browser
      AND o.submitted_at > now() - window_length
    ORDER BY o.submitted_at DESC OFFSET max_orders - 1 LIMIT 1;

  RETURN greatest(
    0,
    ceil(extract(epoch FROM coalesce(greatest(table_free_at, browser_free_at), now()) - now()))
  )::integer;
END
$$;

-- RELAY-D2 (QR-011): how long a diner must wait before calling a waiter or asking for the bill
-- again, or 0 when the request may go now. At most 10 requests in 10 minutes at a table (those the
-- restaurant rejected not counted, as for orders) and 6 from one browser anywhere in the
-- restaurant. Serialised per table and then per browser, like orders, so a burst cannot slip
-- past; the tenant and table come from the claims.
CREATE FUNCTION relay.service_request_wait(browser text) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  tenant uuid := relay.claim_tenant();
  dining_table uuid := relay.claim_table();
  window_length constant interval := interval '10 minutes';
  per_table constant integer := 10;
  per_browser constant integer := 6;
  table_free_at timestamptz;
  browser_free_at timestamptz;
BEGIN
  IF tenant IS NULL OR dining_table IS NULL OR browser IS NULL THEN
    RAISE EXCEPTION 'QR_SCOPE_MISSING' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('relay.request-table:' || tenant || ':' || dining_table, 0)
  );
  PERFORM pg_advisory_xact_lock(
    hashtextextended('relay.request-browser:' || tenant || ':' || browser, 0)
  );

  SELECT r.submitted_at + window_length INTO table_free_at
    FROM relay.qr_service_requests AS r
    WHERE r.tenant_id = tenant AND r.table_id = dining_table AND r.status <> 'REJECTED'
      AND r.submitted_at > now() - window_length
    ORDER BY r.submitted_at DESC OFFSET per_table - 1 LIMIT 1;
  SELECT r.submitted_at + window_length INTO browser_free_at
    FROM relay.qr_service_requests AS r
    WHERE r.tenant_id = tenant AND r.browser_id = browser
      AND r.submitted_at > now() - window_length
    ORDER BY r.submitted_at DESC OFFSET per_browser - 1 LIMIT 1;

  RETURN greatest(
    0,
    ceil(extract(epoch FROM coalesce(greatest(table_free_at, browser_free_at), now()) - now()))
  )::integer;
END
$$;

CREATE INDEX qr_service_requests_table_idx
  ON relay.qr_service_requests (tenant_id, table_id, submitted_at);

REVOKE ALL ON FUNCTION relay.rate_limit_wait(text), relay.service_request_wait(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION relay.rate_limit_wait(text), relay.service_request_wait(text)
  TO relay_diner;

-- RELAY-T8 (MENU-008): menu photos are WebP only, in the table, the bucket and config.toml alike.
-- The `server` function has only ever stored WebP.
ALTER TABLE relay.photos DROP CONSTRAINT photos_content_type_check;
ALTER TABLE relay.photos ADD CONSTRAINT photos_content_type_check
  CHECK (content_type = 'image/webp');

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'authenticator'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format(
        'REVOKE ALL ON FUNCTION relay.rate_limit_wait(text), relay.service_request_wait(text) FROM %I',
        api_role
      );
    END IF;
  END LOOP;

  -- A bucket made before this migration (by config.toml's older types) is brought in line too.
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    UPDATE storage.buckets
    SET allowed_mime_types = ARRAY['image/webp'], file_size_limit = 2097152
    WHERE id = 'menu-photos';
  END IF;
END
$$;
