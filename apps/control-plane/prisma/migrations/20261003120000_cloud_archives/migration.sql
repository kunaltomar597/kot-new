-- P7-06b: archived financial years go to the cloud too (DATA-008), kept for good: the retention
-- and a restore use nightly backups only.
ALTER TABLE "cloud_backups" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'BACKUP';
ALTER TABLE "cloud_backups" ADD CONSTRAINT "cloud_backups_kind_check"
  CHECK ("kind" IN ('BACKUP', 'ARCHIVE'));
