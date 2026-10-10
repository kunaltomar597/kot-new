-- P8-03b4a: threat-model fixes in the Control Plane (docs/security/threat-models/control-plane.md).

-- CP-E3: resetting a Super Admin takes two other Super Admins; the first one's request waits here.
ALTER TABLE "vendor_users"
  ADD COLUMN "reset_requested_by" UUID,
  ADD COLUMN "reset_requested_at" TIMESTAMPTZ(3);

-- CP-T2: the uploads a PC started in the last day, counted against its daily number.
CREATE INDEX "cloud_backups_installation_id_started_at_idx"
  ON "cloud_backups"("installation_id", "started_at");
