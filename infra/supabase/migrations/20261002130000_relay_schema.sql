-- QR relay schema (P5-01, ADR-0015): a private schema, role-scoped Row-Level Security on every
-- table (deny by default), hashed table tokens and tenant credentials, order rules and retention.
--
-- Runs on Supabase and on plain PostgreSQL 15+: Supabase objects (the API roles, the Realtime
-- publication, pg_cron) are used only when they exist. Nothing here holds a secret (SEC-002).

-- Roles ------------------------------------------------------------------------------------------
-- Roles are cluster-wide, so they are created once. All are NOLOGIN and NOINHERIT; the edge
-- functions' login (relay_edge) is enabled with a password by hand (manual task 20).
DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY[
    'relay_server', 'relay_writer', 'relay_diner', 'relay_provisioner', 'relay_edge'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT', name);
    END IF;
  END LOOP;
END
$$;

-- The edge functions switch to the role of whoever they act for, per transaction, and inherit
-- nothing in between. relay_server is deliberately not among them: only a signed JWT carries it,
-- and only Realtime honours it.
GRANT relay_writer, relay_diner, relay_provisioner TO relay_edge;

CREATE SCHEMA relay;
COMMENT ON SCHEMA relay IS
  'QR relay (ADR-0015). Not exposed through the Data API; reached through edge functions and Realtime.';
REVOKE ALL ON SCHEMA relay FROM PUBLIC;
GRANT USAGE ON SCHEMA relay
  TO relay_server, relay_writer, relay_diner, relay_provisioner, relay_edge;

-- Claims -----------------------------------------------------------------------------------------
-- The tenant (and for a diner the table) comes from request.jwt.claims, as PostgREST and Realtime
-- set it; edge functions set it with set_config(..., true) next to SET LOCAL ROLE. A missing or
-- malformed claim is NULL, which matches no row.
CREATE FUNCTION relay.claim_uuid(claim text) RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE SET search_path = ''
AS $$
  SELECT CASE
    WHEN value ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      THEN value::uuid
  END
  FROM (
    SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> claim AS value
  ) AS claims
$$;

CREATE FUNCTION relay.claim_tenant() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE SET search_path = ''
AS $$ SELECT relay.claim_uuid('tenant_id') $$;

CREATE FUNCTION relay.claim_table() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE SET search_path = ''
AS $$ SELECT relay.claim_uuid('table_id') $$;

-- Tables -----------------------------------------------------------------------------------------
-- A tenant is one restaurant, with the Control Plane's restaurant id (VCP-002).
CREATE TABLE relay.tenants (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A local server's credential: 256 random bits made by the Control Plane, stored as sha256. No
-- role reads this table; relay.verify_credential is the only way in.
CREATE TABLE relay.credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES relay.tenants (id),
  secret_hash bytea NOT NULL UNIQUE CHECK (length(secret_hash) = 32),
  label text CHECK (length(label) <= 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX credentials_tenant_idx ON relay.credentials (tenant_id);

-- The QR settings the relay enforces (qr.*, scope VENDOR), with the registry's defaults and
-- limits; the local server keeps them in step (P5-03).
CREATE TABLE relay.tenant_settings (
  tenant_id uuid PRIMARY KEY REFERENCES relay.tenants (id),
  submissions_per_window integer NOT NULL DEFAULT 5 CHECK (submissions_per_window BETWEEN 1 AND 50),
  rate_limit_window_minutes integer NOT NULL DEFAULT 10
    CHECK (rate_limit_window_minutes BETWEEN 1 AND 120),
  pickup_timeout_seconds integer NOT NULL DEFAULT 60 CHECK (pickup_timeout_seconds BETWEEN 15 AND 600),
  presence_interval_seconds integer NOT NULL DEFAULT 30
    CHECK (presence_interval_seconds BETWEEN 5 AND 300),
  read_only_after_seconds integer NOT NULL DEFAULT 120
    CHECK (read_only_after_seconds BETWEEN 30 AND 1800),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A dining table with its QR token's sha256 (QR-001). Regenerating the code replaces the hash; a
-- table without a code has none. Tables are deactivated, never deleted.
CREATE TABLE relay.dining_tables (
  tenant_id uuid NOT NULL REFERENCES relay.tenants (id),
  table_id uuid NOT NULL,
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 40),
  token_hash bytea UNIQUE CHECK (length(token_hash) = 32),
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, table_id)
);

-- The menu as the QR site shows it (QR-002, QR-003). Snapshots are immutable; the highest
-- version is the live one.
CREATE TABLE relay.menu_snapshots (
  tenant_id uuid NOT NULL REFERENCES relay.tenants (id),
  version bigint NOT NULL CHECK (version > 0),
  menu jsonb NOT NULL CHECK (jsonb_typeof(menu) = 'object'),
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, version)
);

-- Menu photos mirrored to Storage (MENU-008): objects live under the tenant's own folder.
CREATE TABLE relay.photos (
  tenant_id uuid NOT NULL REFERENCES relay.tenants (id),
  photo_id uuid NOT NULL,
  storage_path text NOT NULL CHECK (length(storage_path) <= 300),
  content_type text NOT NULL CHECK (content_type IN ('image/webp', 'image/jpeg', 'image/png')),
  width integer CHECK (width > 0),
  height integer CHECK (height > 0),
  bytes integer CHECK (bytes > 0),
  sha256 bytea CHECK (length(sha256) = 32),
  removed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, photo_id),
  CHECK (starts_with(storage_path, tenant_id::text || '/'))
);

-- The local server's heartbeat (QR-008). The relay's clock decides when it was last seen.
CREATE TABLE relay.presence (
  tenant_id uuid PRIMARY KEY REFERENCES relay.tenants (id),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  server_version text CHECK (length(server_version) <= 40)
);

-- A diner's order on its way to the restaurant (QR-006, QR-007). What the diner submitted never
-- changes; the status moves only forward (relay.qr_order_rules).
CREATE TABLE relay.qr_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  table_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 100),
  browser_id text NOT NULL CHECK (length(browser_id) BETWEEN 8 AND 100),
  snapshot_version bigint NOT NULL CHECK (snapshot_version > 0),
  lines jsonb NOT NULL
    CHECK (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) BETWEEN 1 AND 100),
  customer_name text CHECK (length(customer_name) <= 60),
  instructions text CHECK (length(instructions) <= 500),
  status text NOT NULL DEFAULT 'SUBMITTED'
    CHECK (status IN ('SUBMITTED', 'RECEIVED', 'SENT_TO_KITCHEN', 'REJECTED', 'EXPIRED')),
  status_detail jsonb CHECK (status_detail IS NULL OR jsonb_typeof(status_detail) = 'object'),
  local_order_id uuid,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now(),
  received_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, table_id) REFERENCES relay.dining_tables (tenant_id, table_id),
  -- ORD-013: a replayed submission finds the original.
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX qr_orders_pickup_idx ON relay.qr_orders (tenant_id, status, submitted_at);
CREATE INDEX qr_orders_table_idx ON relay.qr_orders (tenant_id, table_id, submitted_at);
CREATE INDEX qr_orders_browser_idx ON relay.qr_orders (tenant_id, browser_id, submitted_at);

-- Triggers ---------------------------------------------------------------------------------------
CREATE FUNCTION relay.touch() RETURNS trigger
  LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER tenants_touch BEFORE UPDATE ON relay.tenants
  FOR EACH ROW EXECUTE FUNCTION relay.touch();
CREATE TRIGGER tenant_settings_touch BEFORE UPDATE ON relay.tenant_settings
  FOR EACH ROW EXECUTE FUNCTION relay.touch();
CREATE TRIGGER dining_tables_touch BEFORE UPDATE ON relay.dining_tables
  FOR EACH ROW EXECUTE FUNCTION relay.touch();
CREATE TRIGGER photos_touch BEFORE UPDATE ON relay.photos
  FOR EACH ROW EXECUTE FUNCTION relay.touch();

CREATE FUNCTION relay.presence_seen() RETURNS trigger
  LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  NEW.last_seen_at := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER presence_seen BEFORE INSERT OR UPDATE ON relay.presence
  FOR EACH ROW EXECUTE FUNCTION relay.presence_seen();

-- A new order starts as SUBMITTED, stamped by the relay, and expires after the tenant's pickup
-- timeout T (QR-007). Definer rights: it reads the tenant's settings whoever inserts.
CREATE FUNCTION relay.qr_order_submitted() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  timeout integer;
BEGIN
  SELECT pickup_timeout_seconds INTO timeout
    FROM relay.tenant_settings WHERE tenant_id = NEW.tenant_id;
  NEW.status := 'SUBMITTED';
  NEW.status_detail := NULL;
  NEW.local_order_id := NULL;
  NEW.received_at := NULL;
  NEW.submitted_at := now();
  NEW.expires_at := now() + make_interval(secs => coalesce(timeout, 60));
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER qr_orders_submitted BEFORE INSERT ON relay.qr_orders
  FOR EACH ROW EXECUTE FUNCTION relay.qr_order_submitted();

-- Status moves: SUBMITTED -> RECEIVED | EXPIRED; RECEIVED -> SENT_TO_KITCHEN | REJECTED; RECEIVED
-- and SENT_TO_KITCHEN may update their detail (item statuses). REJECTED and EXPIRED are final. An
-- order past its pickup time cannot be received: the local server rejects it as expired.
CREATE FUNCTION relay.qr_order_rules() RETURNS trigger
  LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.table_id, NEW.idempotency_key, NEW.browser_id,
      NEW.snapshot_version, NEW.lines, NEW.customer_name, NEW.instructions, NEW.submitted_at,
      NEW.expires_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.table_id, OLD.idempotency_key, OLD.browser_id,
      OLD.snapshot_version, OLD.lines, OLD.customer_name, OLD.instructions, OLD.submitted_at,
      OLD.expires_at) THEN
    RAISE EXCEPTION 'QR_ORDER_IMMUTABLE' USING ERRCODE = 'RL400',
      DETAIL = 'What the diner submitted never changes.';
  END IF;
  IF NOT (
    (OLD.status = 'SUBMITTED' AND NEW.status IN ('RECEIVED', 'EXPIRED'))
    OR (OLD.status = 'RECEIVED' AND NEW.status IN ('RECEIVED', 'SENT_TO_KITCHEN', 'REJECTED'))
    OR (OLD.status = 'SENT_TO_KITCHEN' AND NEW.status = 'SENT_TO_KITCHEN')
  ) THEN
    RAISE EXCEPTION 'QR_ORDER_TRANSITION' USING ERRCODE = 'RL409',
      DETAIL = format('%s cannot become %s.', OLD.status, NEW.status);
  END IF;
  IF OLD.status = 'SUBMITTED' AND NEW.status = 'RECEIVED' THEN
    IF now() > OLD.expires_at THEN
      RAISE EXCEPTION 'QR_ORDER_EXPIRED' USING ERRCODE = 'RL410',
        DETAIL = 'The order was not picked up in time.';
    END IF;
    NEW.received_at := now();
  ELSE
    NEW.received_at := OLD.received_at;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER qr_orders_rules BEFORE UPDATE ON relay.qr_orders
  FOR EACH ROW EXECUTE FUNCTION relay.qr_order_rules();

-- Row-Level Security: on for every table, and every policy names its role --------------------------
ALTER TABLE relay.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE relay.credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE relay.tenant_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE relay.dining_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE relay.menu_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE relay.photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE relay.presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE relay.qr_orders ENABLE ROW LEVEL SECURITY;

-- relay_server: a local server's Realtime subscription sees its own order queue, nothing else.
GRANT SELECT ON relay.qr_orders TO relay_server;
CREATE POLICY server_reads_own_orders ON relay.qr_orders FOR SELECT TO relay_server
  USING (tenant_id = (SELECT relay.claim_tenant()));

-- relay_writer: an edge function acting for a verified local server.
GRANT SELECT ON relay.tenants TO relay_writer;
CREATE POLICY writer_reads_own_tenant ON relay.tenants FOR SELECT TO relay_writer
  USING (id = (SELECT relay.claim_tenant()));

GRANT SELECT, INSERT (tenant_id, submissions_per_window, rate_limit_window_minutes,
  pickup_timeout_seconds, presence_interval_seconds, read_only_after_seconds),
  UPDATE (submissions_per_window, rate_limit_window_minutes, pickup_timeout_seconds,
  presence_interval_seconds, read_only_after_seconds)
  ON relay.tenant_settings TO relay_writer;
CREATE POLICY writer_reads_own_settings ON relay.tenant_settings FOR SELECT TO relay_writer
  USING (tenant_id = (SELECT relay.claim_tenant()));
CREATE POLICY writer_adds_own_settings ON relay.tenant_settings FOR INSERT TO relay_writer
  WITH CHECK (tenant_id = (SELECT relay.claim_tenant()));
CREATE POLICY writer_changes_own_settings ON relay.tenant_settings FOR UPDATE TO relay_writer
  USING (tenant_id = (SELECT relay.claim_tenant()))
  WITH CHECK (tenant_id = (SELECT relay.claim_tenant()));

GRANT SELECT, INSERT (tenant_id, table_id, label, token_hash, active),
  UPDATE (label, token_hash, active)
  ON relay.dining_tables TO relay_writer;
CREATE POLICY writer_reads_own_tables ON relay.dining_tables FOR SELECT TO relay_writer
  USING (tenant_id = (SELECT relay.claim_tenant()));
CREATE POLICY writer_adds_own_tables ON relay.dining_tables FOR INSERT TO relay_writer
  WITH CHECK (tenant_id = (SELECT relay.claim_tenant()));
CREATE POLICY writer_changes_own_tables ON relay.dining_tables FOR UPDATE TO relay_writer
  USING (tenant_id = (SELECT relay.claim_tenant()))
  WITH CHECK (tenant_id = (SELECT relay.claim_tenant()));

GRANT SELECT, INSERT (tenant_id, version, menu) ON relay.menu_snapshots TO relay_writer;
CREATE POLICY writer_reads_own_menu ON relay.menu_snapshots FOR SELECT TO relay_writer
  USING (tenant_id = (SELECT relay.claim_tenant()));
CREATE POLICY writer_publishes_own_menu ON relay.menu_snapshots FOR INSERT TO relay_writer
  WITH CHECK (tenant_id = (SELECT relay.claim_tenant()));

GRANT SELECT, INSERT (tenant_id, photo_id, storage_path, content_type, width, height, bytes,
  sha256, removed_at),
  UPDATE (storage_path, content_type, width, height, bytes, sha256, removed_at)
  ON relay.photos TO relay_writer;
CREATE POLICY writer_reads_own_photos ON relay.photos FOR SELECT TO relay_writer
  USING (tenant_id = (SELECT relay.claim_tenant()));
CREATE POLICY writer_adds_own_photos ON relay.photos FOR INSERT TO relay_writer
  WITH CHECK (tenant_id = (SELECT relay.claim_tenant()));
CREATE POLICY writer_changes_own_photos ON relay.photos FOR UPDATE TO relay_writer
  USING (tenant_id = (SELECT relay.claim_tenant()))
  WITH CHECK (tenant_id = (SELECT relay.claim_tenant()));

GRANT SELECT, INSERT (tenant_id, server_version), UPDATE (server_version)
  ON relay.presence TO relay_writer;
CREATE POLICY writer_reads_own_presence ON relay.presence FOR SELECT TO relay_writer
  USING (tenant_id = (SELECT relay.claim_tenant()));
CREATE POLICY writer_reports_own_presence ON relay.presence FOR INSERT TO relay_writer
  WITH CHECK (tenant_id = (SELECT relay.claim_tenant()));
CREATE POLICY writer_renews_own_presence ON relay.presence FOR UPDATE TO relay_writer
  USING (tenant_id = (SELECT relay.claim_tenant()))
  WITH CHECK (tenant_id = (SELECT relay.claim_tenant()));

GRANT SELECT, UPDATE (status, status_detail, local_order_id) ON relay.qr_orders TO relay_writer;
CREATE POLICY writer_reads_own_orders ON relay.qr_orders FOR SELECT TO relay_writer
  USING (tenant_id = (SELECT relay.claim_tenant()));
CREATE POLICY writer_updates_own_orders ON relay.qr_orders FOR UPDATE TO relay_writer
  USING (tenant_id = (SELECT relay.claim_tenant()))
  WITH CHECK (tenant_id = (SELECT relay.claim_tenant()));

-- relay_diner: an edge function acting for a browser whose table token resolved. It reads its
-- restaurant's menu and state, and orders for its own table only.
GRANT SELECT (id, name, status) ON relay.tenants TO relay_diner;
CREATE POLICY diner_reads_own_tenant ON relay.tenants FOR SELECT TO relay_diner
  USING (id = (SELECT relay.claim_tenant()));

GRANT SELECT ON relay.tenant_settings TO relay_diner;
CREATE POLICY diner_reads_own_settings ON relay.tenant_settings FOR SELECT TO relay_diner
  USING (tenant_id = (SELECT relay.claim_tenant()));

GRANT SELECT (tenant_id, table_id, label, active) ON relay.dining_tables TO relay_diner;
CREATE POLICY diner_reads_own_table ON relay.dining_tables FOR SELECT TO relay_diner
  USING (tenant_id = (SELECT relay.claim_tenant()) AND table_id = (SELECT relay.claim_table()));

GRANT SELECT ON relay.menu_snapshots TO relay_diner;
CREATE POLICY diner_reads_own_menu ON relay.menu_snapshots FOR SELECT TO relay_diner
  USING (tenant_id = (SELECT relay.claim_tenant()));

GRANT SELECT ON relay.photos TO relay_diner;
CREATE POLICY diner_reads_own_photos ON relay.photos FOR SELECT TO relay_diner
  USING (tenant_id = (SELECT relay.claim_tenant()));

GRANT SELECT ON relay.presence TO relay_diner;
CREATE POLICY diner_reads_own_presence ON relay.presence FOR SELECT TO relay_diner
  USING (tenant_id = (SELECT relay.claim_tenant()));

GRANT SELECT, INSERT (tenant_id, table_id, idempotency_key, browser_id, snapshot_version, lines,
  customer_name, instructions)
  ON relay.qr_orders TO relay_diner;
CREATE POLICY diner_reads_own_table_orders ON relay.qr_orders FOR SELECT TO relay_diner
  USING (tenant_id = (SELECT relay.claim_tenant()) AND table_id = (SELECT relay.claim_table()));
CREATE POLICY diner_orders_for_own_table ON relay.qr_orders FOR INSERT TO relay_diner
  WITH CHECK (
    tenant_id = (SELECT relay.claim_tenant()) AND table_id = (SELECT relay.claim_table())
  );

-- Token, credential and provisioning functions ------------------------------------------------------
-- Definer rights with an empty search_path; each is executable only by the role named below.

-- QR-001: the table a QR token opens, if the table is active and the restaurant is not suspended.
-- A token has at least 128 random bits (22 base64url characters).
CREATE FUNCTION relay.resolve_table_token(token text)
  RETURNS TABLE (tenant_id uuid, table_id uuid, label text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT t.tenant_id, t.table_id, t.label
  FROM relay.dining_tables AS t
  JOIN relay.tenants AS n ON n.id = t.tenant_id
  WHERE length(token) BETWEEN 22 AND 128
    AND t.token_hash = sha256(convert_to(token, 'UTF8'))
    AND t.active
    AND n.status = 'ACTIVE'
$$;

-- The tenant a local server's credential belongs to, if it is not revoked and the restaurant is
-- not suspended; notes when it was last used. A credential has 256 random bits.
CREATE FUNCTION relay.verify_credential(secret text)
  RETURNS TABLE (tenant_id uuid, credential_id uuid)
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
  WITH used AS (
    UPDATE relay.credentials AS c
    SET last_used_at = now()
    FROM relay.tenants AS n
    WHERE n.id = c.tenant_id
      AND length(secret) BETWEEN 43 AND 200
      AND c.secret_hash = sha256(convert_to(secret, 'UTF8'))
      AND c.revoked_at IS NULL
      AND n.status = 'ACTIVE'
    RETURNING c.tenant_id, c.id
  )
  SELECT used.tenant_id, used.id FROM used
$$;

-- VCP-002: the Control Plane creates (or renames) a restaurant in the relay.
CREATE FUNCTION relay.provision_tenant(tenant uuid, tenant_name text) RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
  INSERT INTO relay.tenants (id, name) VALUES (tenant, tenant_name)
  ON CONFLICT (id) DO UPDATE SET name = excluded.name;
  INSERT INTO relay.tenant_settings (tenant_id) VALUES (tenant)
  ON CONFLICT (tenant_id) DO NOTHING;
$$;

-- VCP-002: a scoped credential for one restaurant's local server; the Control Plane keeps the
-- secret and sends only its sha256.
CREATE FUNCTION relay.add_credential(tenant uuid, secret_hash bytea, credential_label text)
  RETURNS uuid
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
  INSERT INTO relay.credentials (tenant_id, secret_hash, label)
  VALUES (tenant, secret_hash, credential_label)
  RETURNING id
$$;

CREATE FUNCTION relay.revoke_credential(credential uuid) RETURNS boolean
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
  WITH revoked AS (
    UPDATE relay.credentials SET revoked_at = now()
    WHERE id = credential AND revoked_at IS NULL
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM revoked)
$$;

CREATE FUNCTION relay.set_tenant_status(tenant uuid, new_status text) RETURNS boolean
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
  WITH changed AS (
    UPDATE relay.tenants SET status = new_status WHERE id = tenant RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM changed)
$$;

-- Retention (BRD §9.3): orders 7 days after they were received or expired; every menu snapshot
-- but the latest after a day. Photo files and their metadata are swept with Storage (P5-03).
CREATE FUNCTION relay.purge(as_of timestamptz DEFAULT now())
  RETURNS TABLE (orders bigint, snapshots bigint)
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
  )
  SELECT (SELECT count(*) FROM old_orders), (SELECT count(*) FROM old_snapshots)
$$;

-- Function privileges: nothing for PUBLIC. A per-schema default cannot take back the global
-- EXECUTE for PUBLIC, so every migration that adds a function revokes it again (test/roles.test.ts
-- fails otherwise).
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA relay FROM PUBLIC;
GRANT EXECUTE ON FUNCTION relay.claim_uuid(text), relay.claim_tenant(), relay.claim_table()
  TO relay_server, relay_writer, relay_diner;
GRANT EXECUTE ON FUNCTION relay.resolve_table_token(text), relay.verify_credential(text)
  TO relay_edge;
GRANT EXECUTE ON FUNCTION relay.provision_tenant(uuid, text),
  relay.add_credential(uuid, bytea, text), relay.revoke_credential(uuid),
  relay.set_tenant_status(uuid, text)
  TO relay_provisioner;

-- Supabase ---------------------------------------------------------------------------------------
DO $$
DECLARE
  api_role text;
BEGIN
  -- Supabase grants its API roles broad default privileges; none of them reaches the relay.
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'authenticator'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA relay FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA relay FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA relay FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA relay FROM %I', api_role);
    END IF;
  END LOOP;

  -- Realtime tells a local server about new orders the moment they arrive (P5-03).
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE relay.qr_orders;
  END IF;

  -- Retention runs hourly where pg_cron is available (Supabase).
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
    EXECUTE $cron$SELECT cron.schedule('relay-purge', '17 * * * *', 'SELECT relay.purge()')$cron$;
  END IF;
END
$$;
