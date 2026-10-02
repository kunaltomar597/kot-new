-- P7-01b: licence terms per installation and every licence file issued (LIC-001, VCP-003).
CREATE TYPE "LicenceState" AS ENUM ('ACTIVE', 'PAYMENT_DUE', 'GRACE', 'RESTRICTED', 'TERMINATED');

CREATE TABLE "installation_licences" (
    "installation_id" UUID NOT NULL,
    "plan" TEXT NOT NULL,
    "modules" TEXT[],
    "device_limits" JSONB NOT NULL,
    "validity_days" INTEGER NOT NULL,
    "grace_days" INTEGER NOT NULL,
    "state" "LicenceState" NOT NULL DEFAULT 'ACTIVE',
    "grace_started_at" TIMESTAMPTZ(3),
    "reason" TEXT,
    "fingerprint" JSONB,
    "bound_at" TIMESTAMPTZ(3),
    "revision" INTEGER NOT NULL DEFAULT 1,
    "reactivation_counter" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "installation_licences_pkey" PRIMARY KEY ("installation_id")
);

CREATE TABLE "licence_files" (
    "id" UUID NOT NULL,
    "installation_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "state" "LicenceState" NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL,
    "valid_until" TIMESTAMPTZ(3) NOT NULL,
    "payload" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,

    CONSTRAINT "licence_files_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "licence_files_installation_id_issued_at_idx" ON "licence_files"("installation_id", "issued_at");

ALTER TABLE "installation_licences" ADD CONSTRAINT "installation_licences_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "installations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "licence_files" ADD CONSTRAINT "licence_files_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "installations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
