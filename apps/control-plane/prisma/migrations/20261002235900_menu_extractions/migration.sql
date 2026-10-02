-- AI-assisted menu import (P6-04a, ONB-006, VCP-008): the jobs, and the files waiting to be read.
CREATE TYPE "MenuExtractionStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED');

CREATE TABLE "menu_extractions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "installation_id" UUID NOT NULL,
    "status" "MenuExtractionStatus" NOT NULL DEFAULT 'QUEUED',
    "files" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "draft" JSONB,
    "error_code" TEXT,
    "error_message" TEXT,
    "model" TEXT,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "not_before" TIMESTAMPTZ(3),
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "menu_extractions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "menu_extractions_files_check" CHECK ("files" BETWEEN 1 AND 10 AND "bytes" > 0)
);

CREATE INDEX "menu_extractions_tenant_id_created_at_idx" ON "menu_extractions"("tenant_id", "created_at");
CREATE INDEX "menu_extractions_status_idx" ON "menu_extractions"("status");

CREATE TABLE "menu_extraction_files" (
    "id" UUID NOT NULL,
    "extraction_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "content" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "menu_extraction_files_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "menu_extraction_files_extraction_id_position_key" ON "menu_extraction_files"("extraction_id", "position");

ALTER TABLE "menu_extractions" ADD CONSTRAINT "menu_extractions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "menu_extractions" ADD CONSTRAINT "menu_extractions_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "installations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "menu_extraction_files" ADD CONSTRAINT "menu_extraction_files_extraction_id_fkey" FOREIGN KEY ("extraction_id") REFERENCES "menu_extractions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
