-- P7-05a: each backup (DATA-002, DATA-005): the nightly full backup or a "Back up now", whether it
-- worked, the file it made and whether the copy reached the second location. An installation-wide
-- record (the backup holds the whole database), so it has no restaurant.

-- CreateEnum
CREATE TYPE "BackupKind" AS ENUM ('NIGHTLY', 'MANUAL');

-- CreateEnum
CREATE TYPE "BackupStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED');

-- CreateTable
CREATE TABLE "backup_runs" (
    "id" UUID NOT NULL,
    "kind" "BackupKind" NOT NULL,
    "status" "BackupStatus" NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "finished_at" TIMESTAMPTZ(3),
    "file_name" TEXT,
    "size_bytes" BIGINT,
    "sha256" TEXT,
    "second_copy" TEXT,
    "error" TEXT,
    "requested_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backup_runs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "backup_runs_second_copy_check"
        CHECK ("second_copy" IS NULL OR "second_copy" IN ('COPIED', 'NOT_SET', 'FAILED'))
);

-- CreateIndex
CREATE INDEX "backup_runs_started_at_idx" ON "backup_runs"("started_at");
