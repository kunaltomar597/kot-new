-- Call waiter / request bill from the QR page (P5-05c, QR-011; ADR-0015): a diner's request on its
-- way to the restaurant, kept like the order queue. One open request of each kind per table, so
-- pressing again finds the open one; the restaurant tells how it went.

CREATE TABLE relay.qr_service_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  table_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 100),
  browser_id text NOT NULL CHECK (length(browser_id) BETWEEN 8 AND 100),
  type text NOT NULL CHECK (type IN ('WATER', 'WAITER', 'BILL')),
  status text NOT NULL DEFAULT 'SUBMITTED'
    CHECK (status IN ('SUBMITTED', 'RECEIVED', 'ACKNOWLEDGED', 'DONE', 'REJECTED', 'EXPIRED')),
  rejection_reason text CHECK (length(rejection_reason) BETWEEN 1 AND 200),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now(),
  received_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, table_id) REFERENCES relay.dining_tables (tenant_id, table_id),
  UNIQUE (tenant_id, idempotency_key)
);
-- A second press while one is open finds it (the tablet's rule, TAB-004).
CREATE UNIQUE INDEX qr_service_requests_open_idx ON relay.qr_service_requests (tenant_id, table_id, type)
  WHERE status IN ('SUBMITTED', 'RECEIVED', 'ACKNOWLEDGED');
CREATE INDEX qr_service_requests_pickup_idx
  ON relay.qr_service_requests (tenant_id, status, submitted_at);
CREATE INDEX qr_service_requests_browser_idx
  ON relay.qr_service_requests (tenant_id, browser_id, submitted_at);

-- Stamped by the relay and expiring after the restaurant's pickup timeout, like an order.
CREATE FUNCTION relay.qr_service_request_submitted() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  timeout integer;
BEGIN
  SELECT pickup_timeout_seconds INTO timeout
    FROM relay.tenant_settings WHERE tenant_id = NEW.tenant_id;
  NEW.status := 'SUBMITTED';
  NEW.rejection_reason := NULL;
  NEW.received_at := NULL;
  NEW.submitted_at := now();
  NEW.expires_at := now() + make_interval(secs => coalesce(timeout, 60));
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER qr_service_requests_submitted BEFORE INSERT ON relay.qr_service_requests
  FOR EACH ROW EXECUTE FUNCTION relay.qr_service_request_submitted();

-- SUBMITTED -> RECEIVED | REJECTED | EXPIRED; RECEIVED -> ACKNOWLEDGED | DONE | REJECTED;
-- ACKNOWLEDGED -> DONE. A request past its pickup time cannot be received.
CREATE FUNCTION relay.qr_service_request_rules() RETURNS trigger
  LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.table_id, NEW.idempotency_key, NEW.browser_id, NEW.type,
      NEW.submitted_at, NEW.expires_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.table_id, OLD.idempotency_key, OLD.browser_id, OLD.type,
      OLD.submitted_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'QR_REQUEST_IMMUTABLE' USING ERRCODE = 'RL400';
  END IF;
  IF NOT (
    (OLD.status = 'SUBMITTED' AND NEW.status IN ('RECEIVED', 'REJECTED', 'EXPIRED'))
    OR (OLD.status = 'RECEIVED' AND NEW.status IN ('RECEIVED', 'ACKNOWLEDGED', 'DONE', 'REJECTED'))
    OR (OLD.status = 'ACKNOWLEDGED' AND NEW.status IN ('ACKNOWLEDGED', 'DONE'))
  ) THEN
    RAISE EXCEPTION 'QR_REQUEST_TRANSITION' USING ERRCODE = 'RL409',
      DETAIL = format('%s cannot become %s.', OLD.status, NEW.status);
  END IF;
  IF OLD.status = 'SUBMITTED' AND NEW.status = 'RECEIVED' THEN
    IF now() > OLD.expires_at THEN
      RAISE EXCEPTION 'QR_REQUEST_EXPIRED' USING ERRCODE = 'RL410';
    END IF;
    NEW.received_at := now();
  ELSE
    NEW.received_at := OLD.received_at;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER qr_service_requests_rules BEFORE UPDATE ON relay.qr_service_requests
  FOR EACH ROW EXECUTE FUNCTION relay.qr_service_request_rules();

ALTER TABLE relay.qr_service_requests ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON relay.qr_service_requests TO relay_server;
CREATE POLICY server_reads_own_requests ON relay.qr_service_requests FOR SELECT TO relay_server
  USING (tenant_id = (SELECT relay.claim_tenant()));

GRANT SELECT, UPDATE (status, rejection_reason) ON relay.qr_service_requests TO relay_writer;
CREATE POLICY writer_reads_own_requests ON relay.qr_service_requests FOR SELECT TO relay_writer
  USING (tenant_id = (SELECT relay.claim_tenant()));
CREATE POLICY writer_updates_own_requests ON relay.qr_service_requests FOR UPDATE TO relay_writer
  USING (tenant_id = (SELECT relay.claim_tenant()))
  WITH CHECK (tenant_id = (SELECT relay.claim_tenant()));

GRANT SELECT, INSERT (tenant_id, table_id, idempotency_key, browser_id, type)
  ON relay.qr_service_requests TO relay_diner;
CREATE POLICY diner_reads_own_table_requests ON relay.qr_service_requests FOR SELECT TO relay_diner
  USING (tenant_id = (SELECT relay.claim_tenant()) AND table_id = (SELECT relay.claim_table()));
CREATE POLICY diner_requests_for_own_table ON relay.qr_service_requests FOR INSERT TO relay_diner
  WITH CHECK (
    tenant_id = (SELECT relay.claim_tenant()) AND table_id = (SELECT relay.claim_table())
  );

-- Expiry and retention cover requests as they cover orders (QR-007, BRD §9.3).
CREATE OR REPLACE FUNCTION relay.expire_orders(as_of timestamptz DEFAULT now()) RETURNS bigint
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
  WITH expired_orders AS (
    UPDATE relay.qr_orders SET status = 'EXPIRED'
    WHERE status = 'SUBMITTED' AND expires_at < as_of
    RETURNING 1
  ),
  expired_requests AS (
    UPDATE relay.qr_service_requests SET status = 'EXPIRED'
    WHERE status = 'SUBMITTED' AND expires_at < as_of
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM expired_orders) + (SELECT count(*) FROM expired_requests)
$$;

DROP FUNCTION relay.purge(timestamptz);
CREATE FUNCTION relay.purge(as_of timestamptz DEFAULT now())
  RETURNS TABLE (orders bigint, snapshots bigint, service_requests bigint)
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
  )
  SELECT (SELECT count(*) FROM old_orders), (SELECT count(*) FROM old_snapshots),
         (SELECT count(*) FROM old_requests)
$$;

REVOKE ALL ON FUNCTION relay.qr_service_request_submitted(), relay.qr_service_request_rules(),
  relay.expire_orders(timestamptz), relay.purge(timestamptz) FROM PUBLIC;

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'authenticator'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON relay.qr_service_requests FROM %I', api_role);
      EXECUTE format(
        'REVOKE ALL ON FUNCTION relay.qr_service_request_submitted(), '
        'relay.qr_service_request_rules(), relay.expire_orders(timestamptz), '
        'relay.purge(timestamptz) FROM %I',
        api_role
      );
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE relay.qr_service_requests;
  END IF;
END
$$;
