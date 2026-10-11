-- QR order rate limits and expiry (P5-02a, QR-006, QR-007; ADR-0015).

-- QR-006: how long a diner must wait before ordering again, or 0 when the order may go now. The
-- limit is the restaurant's: so many orders per window, counted per table and per browser.
-- Called by the submit-order function as relay_diner, in the transaction that then inserts the
-- order. The tenant and table come from the claims, never from the caller. Submissions are
-- serialised per table and then per browser (always in that order, so they cannot deadlock),
-- so two at once cannot both slip under the limit.
CREATE FUNCTION relay.rate_limit_wait(browser text) RETURNS integer
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
    WHERE o.tenant_id = tenant AND o.table_id = dining_table
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

-- QR-007: orders nobody picked up in time are marked expired. The diner's page already reads an
-- overdue order as expired; this makes the relay agree, every minute where pg_cron runs.
CREATE FUNCTION relay.expire_orders(as_of timestamptz DEFAULT now()) RETURNS bigint
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
  WITH expired AS (
    UPDATE relay.qr_orders SET status = 'EXPIRED'
    WHERE status = 'SUBMITTED' AND expires_at < as_of
    RETURNING 1
  )
  SELECT count(*) FROM expired
$$;

REVOKE ALL ON FUNCTION relay.rate_limit_wait(text), relay.expire_orders(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION relay.rate_limit_wait(text) TO relay_diner;

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'authenticator'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format(
        'REVOKE ALL ON FUNCTION relay.rate_limit_wait(text), relay.expire_orders(timestamptz) FROM %I',
        api_role
      );
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    EXECUTE $cron$SELECT cron.schedule('relay-expire', '* * * * *', 'SELECT relay.expire_orders()')$cron$;
  END IF;
END
$$;
