-- P7-05d: restaurant PCs' encrypted backups in object storage (DATA-003).
CREATE TYPE "CloudBackupStatus" AS ENUM ('UPLOADING', 'COMPLETE', 'ABORTED', 'DELETED');

CREATE TABLE "cloud_backups" (
    "id" UUID NOT NULL,
    "installation_id" UUID NOT NULL,
    -- `backups/<tenant>/<installation>/<file name>` in the bucket.
    "object_key" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "backup_created_at" TIMESTAMPTZ(3) NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,
    -- Which backup key opens it (not the key).
    "key_id" TEXT NOT NULL,
    "status" "CloudBackupStatus" NOT NULL DEFAULT 'UPLOADING',
    "upload_id" TEXT,
    "part_size" INTEGER NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),

    CONSTRAINT "cloud_backups_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "cloud_backups_object_key_key" ON "cloud_backups"("object_key");
CREATE INDEX "cloud_backups_installation_id_status_backup_created_at_idx"
  ON "cloud_backups"("installation_id", "status", "backup_created_at");

ALTER TABLE "cloud_backups" ADD CONSTRAINT "cloud_backups_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "installations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
