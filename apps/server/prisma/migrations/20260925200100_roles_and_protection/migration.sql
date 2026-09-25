-- P0-08: least-privilege roles and database-level protection of financial and audit records
-- (AUD-004, SEC-007). Hand-written; Prisma does not model roles, grants or triggers.
--
-- Roles are NOLOGIN group roles. The installer (P0-16) creates login users that are members of
-- them, with passwords from the secret store (SEC-002). Roles are cluster-wide, so this migration
-- creates them only when missing and can run against every database of a cluster.
--
--   rp_owner  runs migrations; owns the schema objects.
--   rp_app    the server at runtime: SELECT/INSERT/UPDATE everywhere, DELETE only on tables that
--             are not financial or audit records, no UPDATE on the audit log.
--   rp_purge  archive-then-purge only (P7-06): SELECT and DELETE on the protected tables.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rp_owner') THEN
    CREATE ROLE rp_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rp_app') THEN
    CREATE ROLE rp_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rp_purge') THEN
    CREATE ROLE rp_purge NOLOGIN;
  END IF;
END
$$;

GRANT USAGE, CREATE ON SCHEMA public TO rp_owner;
GRANT ALL ON ALL TABLES IN SCHEMA public TO rp_owner;

GRANT USAGE ON SCHEMA public TO rp_app, rp_purge;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO rp_app;

-- Tables created by later migrations get the same runtime rights. DELETE is never a default: a
-- later migration grants it explicitly for a table that is not a financial or audit record.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO rp_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO rp_owner;

-- DELETE for rp_app on everything except the protected records below.
DO $$
DECLARE
  protected CONSTANT text[] := ARRAY[
    'orders', 'order_items', 'order_item_modifiers', 'order_events', 'kots', 'kot_lines',
    'approvals', 'invoices', 'invoice_lines', 'tax_lines', 'discounts', 'payments',
    'cash_movements', 'shifts', 'day_ends', 'business_days', 'audit_log', '_prisma_migrations'
  ];
  t record;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND NOT (tablename = ANY (protected))
  LOOP
    EXECUTE format('GRANT DELETE ON public.%I TO rp_app', t.tablename);
  END LOOP;
  FOR t IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename = ANY (protected) AND tablename <> '_prisma_migrations'
  LOOP
    EXECUTE format('REVOKE DELETE ON public.%I FROM rp_app', t.tablename);
    EXECUTE format('GRANT SELECT, DELETE ON public.%I TO rp_purge', t.tablename);
  END LOOP;
END
$$;

-- The audit log is append-only for the application.
REVOKE UPDATE ON audit_log FROM rp_app;

-- The runtime never needs the migration history (it exists when Prisma applies this migration).
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    REVOKE ALL ON public._prisma_migrations FROM rp_app;
  END IF;
END
$$;

-- Triggers apply to every role (including owners), so a mistake in code or a manual query cannot
-- rewrite history either. Only purge (P7-06) may delete audit rows, after archiving them.
CREATE OR REPLACE FUNCTION rp_audit_log_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'audit_log rows cannot be changed (AUD-004)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' AND NOT pg_has_role(current_user, 'rp_purge', 'MEMBER') THEN
    RAISE EXCEPTION 'audit_log rows can only be removed by the archive-and-purge job (AUD-004)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

CREATE TRIGGER audit_log_guard
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION rp_audit_log_guard();

-- A settled or voided invoice keeps its number and amounts forever (BILL-003, BILL-010): it can
-- only be voided (settled → voided) and re-issued as a new invoice.
CREATE OR REPLACE FUNCTION rp_invoice_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('SETTLED', 'VOIDED') AND (
       NEW.invoice_number, NEW.sequence, NEW.series_id, NEW.financial_year, NEW.invoice_date,
       NEW.business_date, NEW.price_mode, NEW.subtotal, NEW.discount_total, NEW.service_charge,
       NEW.tax_total, NEW.round_off, NEW.grand_total
     ) IS DISTINCT FROM (
       OLD.invoice_number, OLD.sequence, OLD.series_id, OLD.financial_year, OLD.invoice_date,
       OLD.business_date, OLD.price_mode, OLD.subtotal, OLD.discount_total, OLD.service_charge,
       OLD.tax_total, OLD.round_off, OLD.grand_total
     ) THEN
    RAISE EXCEPTION 'invoice % is %; its number and amounts cannot change (BILL-010)',
      OLD.invoice_number, OLD.status USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'VOIDED' AND NEW.status <> 'VOIDED' THEN
    RAISE EXCEPTION 'voided invoice % cannot be reopened', OLD.invoice_number
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'SETTLED' AND NEW.status = 'ISSUED' THEN
    RAISE EXCEPTION 'settled invoice % cannot be reopened; void and re-issue it (BILL-010)',
      OLD.invoice_number USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER invoice_guard
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION rp_invoice_guard();

-- Lines and tax lines of a settled or voided invoice are frozen too.
CREATE OR REPLACE FUNCTION rp_invoice_child_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_status "InvoiceStatus";
BEGIN
  SELECT status INTO parent_status FROM invoices
    WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END;
  IF parent_status IN ('SETTLED', 'VOIDED') THEN
    RAISE EXCEPTION '% of a % invoice cannot change (BILL-010)', TG_TABLE_NAME, parent_status
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

CREATE TRIGGER invoice_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION rp_invoice_child_guard();

CREATE TRIGGER tax_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON tax_lines
  FOR EACH ROW EXECUTE FUNCTION rp_invoice_child_guard();
