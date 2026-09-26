
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "InstallationStatus" AS ENUM ('PENDING', 'ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "ReleaseChannel" AS ENUM ('STABLE', 'PILOT');

-- CreateEnum
CREATE TYPE "ReleaseComponent" AS ENUM ('RESTAURANT_PC');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "installations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "InstallationStatus" NOT NULL DEFAULT 'PENDING',
    "channel" "ReleaseChannel" NOT NULL DEFAULT 'STABLE',
    "public_key" TEXT,
    "enrolment_code_hash" TEXT,
    "enrolment_code_expires_at" TIMESTAMPTZ(3),
    "enrolled_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "last_seen_at" TIMESTAMPTZ(3),
    "last_heartbeat" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "installations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "heartbeats" (
    "installation_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "sent_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB NOT NULL,

    CONSTRAINT "heartbeats_pkey" PRIMARY KEY ("installation_id","id")
);

-- CreateTable
CREATE TABLE "request_nonces" (
    "installation_id" UUID NOT NULL,
    "nonce" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "request_nonces_pkey" PRIMARY KEY ("installation_id","nonce")
);

-- CreateTable
CREATE TABLE "releases" (
    "id" UUID NOT NULL,
    "component" "ReleaseComponent" NOT NULL,
    "channel" "ReleaseChannel" NOT NULL,
    "version" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "notes" TEXT,
    "published_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_by" TEXT NOT NULL,

    CONSTRAINT "releases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT,
    "details" JSONB,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "installations_enrolment_code_hash_key" ON "installations"("enrolment_code_hash");

-- CreateIndex
CREATE INDEX "installations_tenant_id_idx" ON "installations"("tenant_id");

-- CreateIndex
CREATE INDEX "heartbeats_installation_id_received_at_idx" ON "heartbeats"("installation_id", "received_at");

-- CreateIndex
CREATE INDEX "request_nonces_expires_at_idx" ON "request_nonces"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "releases_component_channel_version_key" ON "releases"("component", "channel", "version");

-- CreateIndex
CREATE INDEX "audit_log_target_type_target_id_idx" ON "audit_log"("target_type", "target_id");

-- AddForeignKey
ALTER TABLE "installations" ADD CONSTRAINT "installations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "heartbeats" ADD CONSTRAINT "heartbeats_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "installations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_nonces" ADD CONSTRAINT "request_nonces_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "installations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Releases download over HTTPS only and carry a SHA-256 to check (UPD-007).
ALTER TABLE "releases" ADD CONSTRAINT "releases_url_https" CHECK ("url" LIKE 'https://%');
ALTER TABLE "releases" ADD CONSTRAINT "releases_sha256_hex" CHECK ("sha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "releases" ADD CONSTRAINT "releases_size_positive" CHECK ("size_bytes" > 0);

-- The audit log is append-only (VCP-001: every action is audited).
CREATE FUNCTION cp_audit_log_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log rows cannot be changed or removed (VCP-001)';
END;
$$;

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION cp_audit_log_guard();

CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON "audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION cp_audit_log_guard();
