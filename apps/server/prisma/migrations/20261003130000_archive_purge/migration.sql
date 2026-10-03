-- P7-06b: archive-then-purge of whole financial years (DATA-008, AUD-004).

CREATE TYPE "ArchiveStatus" AS ENUM ('ARCHIVING', 'VERIFYING', 'PURGING', 'DONE', 'FAILED');

-- Each archive-then-purge; once DONE it is the purge record (DATA-008 step 4), kept for good.
CREATE TABLE "archive_runs" (
    "id" UUID NOT NULL,
    "financial_year" TEXT NOT NULL,
    "status" "ArchiveStatus" NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "finished_at" TIMESTAMPTZ(3),
    "requested_by_id" UUID,
    "reason" TEXT NOT NULL,
    "folder" TEXT,
    "archive_file" TEXT,
    "size_bytes" BIGINT,
    "sha256" TEXT,
    -- Rows archived, then deleted, per table.
    "counts" JSONB,
    -- The audit chain archived: up to this entry, whose hash it was.
    "audit_chain_to" BIGINT,
    "audit_chain_hash" TEXT,
    "error" TEXT,
    "cloud_status" TEXT,
    "cloud_attempted_at" TIMESTAMPTZ(3),
    "cloud_uploaded_at" TIMESTAMPTZ(3),
    "cloud_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "archive_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "archive_runs_financial_year_idx" ON "archive_runs"("financial_year");

-- The purge (a login in rp_purge) marks its record DONE in the same transaction as the deletes.
GRANT SELECT, UPDATE ON "archive_runs" TO rp_purge;
-- With the year's orders go their relay copies and the suggestions' outcomes (derived data).
GRANT SELECT, DELETE ON "relay_orders", "recommendation_events" TO rp_purge;

-- Lines and tax lines of a settled or voided invoice stay frozen, except:
-- - the purge deletes them with their invoice;
-- - a line of a later year's invoice loses its link to an order item the purge removed (the
--   foreign key's ON DELETE SET NULL); nothing else about the line may change.
CREATE OR REPLACE FUNCTION rp_invoice_child_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_status "InvoiceStatus";
BEGIN
  IF TG_OP = 'DELETE' AND pg_has_role(current_user, 'rp_purge', 'MEMBER') THEN
    RETURN OLD;
  END IF;
  -- Through jsonb, so the same function serves tax_lines, which have no order_item_id.
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'invoice_lines'
     AND to_jsonb(NEW) ->> 'order_item_id' IS NULL
     AND (to_jsonb(NEW) - 'order_item_id') = (to_jsonb(OLD) - 'order_item_id') THEN
    RETURN NEW;
  END IF;
  SELECT status INTO parent_status FROM invoices
    WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END;
  IF parent_status IN ('SETTLED', 'VOIDED') THEN
    RAISE EXCEPTION '% of a % invoice cannot change (BILL-010)', TG_TABLE_NAME, parent_status
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
