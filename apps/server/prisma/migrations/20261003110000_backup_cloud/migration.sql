-- P7-05d: the copy of each nightly backup in the cloud (DATA-003).
ALTER TABLE "backup_runs"
  ADD COLUMN "cloud_status" TEXT,
  ADD COLUMN "cloud_attempted_at" TIMESTAMPTZ(3),
  ADD COLUMN "cloud_uploaded_at" TIMESTAMPTZ(3),
  ADD COLUMN "cloud_error" TEXT,
  ADD COLUMN "cloud_backup_id" UUID;
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_cloud_status_check"
  CHECK ("cloud_status" IS NULL OR "cloud_status" IN ('PENDING', 'UPLOADED', 'FAILED', 'SKIPPED'));
-- New nightly backups wait for their upload; earlier ones were never meant for the cloud.
CREATE INDEX "backup_runs_cloud_status_idx" ON "backup_runs"("cloud_status");
