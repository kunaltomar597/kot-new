-- P7-03a: fleet monitoring (VCP-005, AUD-003, DATA-005).

-- The audit chain heads each PC reported, so later tampering with its local database shows: the
-- log only grows, so a head may never go back, and the hash at a sequence may never change.
CREATE TABLE "audit_chain_heads" (
    "id" UUID NOT NULL,
    "installation_id" UUID NOT NULL,
    "sequence" BIGINT NOT NULL,
    "hash" TEXT NOT NULL,
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- The last time an answered audit check found the PC still holding this hash.
    "verified_at" TIMESTAMPTZ(3),
    -- Set aside when a person closed a chain alert: the chain counts from its new head.
    "superseded_at" TIMESTAMPTZ(3),

    CONSTRAINT "audit_chain_heads_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "audit_chain_heads_current" ON "audit_chain_heads"("installation_id", "sequence")
  WHERE "superseded_at" IS NULL;
CREATE INDEX "audit_chain_heads_installation_id_first_seen_at_idx"
  ON "audit_chain_heads"("installation_id", "first_seen_at");

CREATE TYPE "FleetAlertKind" AS ENUM ('OFFLINE', 'DISK_FULL', 'BACKUP_FAILED', 'AUDIT_CHAIN_MISMATCH');

CREATE TABLE "fleet_alerts" (
    "id" UUID NOT NULL,
    "installation_id" UUID NOT NULL,
    "kind" "FleetAlertKind" NOT NULL,
    "opened_at" TIMESTAMPTZ(3) NOT NULL,
    "resolved_at" TIMESTAMPTZ(3),
    "details" JSONB,
    "resolved_by" TEXT,
    "resolution" TEXT,
    -- Sent to the alert webhook (opened, then closed); retried until sent.
    "notified_at" TIMESTAMPTZ(3),
    "resolution_notified_at" TIMESTAMPTZ(3),

    CONSTRAINT "fleet_alerts_pkey" PRIMARY KEY ("id")
);
-- One open alert of each kind per PC.
CREATE UNIQUE INDEX "fleet_alerts_one_open" ON "fleet_alerts"("installation_id", "kind")
  WHERE "resolved_at" IS NULL;
CREATE INDEX "fleet_alerts_opened_at_idx" ON "fleet_alerts"("opened_at");

ALTER TABLE "audit_chain_heads" ADD CONSTRAINT "audit_chain_heads_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "installations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fleet_alerts" ADD CONSTRAINT "fleet_alerts_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "installations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
