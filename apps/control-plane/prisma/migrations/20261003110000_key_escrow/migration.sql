-- P7-05e: escrowed backup keys and the restore codes that release them (DATA-003, OI-10).
CREATE TABLE "backup_key_escrows" (
    "id" UUID NOT NULL,
    "installation_id" UUID NOT NULL,
    "key_id" TEXT NOT NULL,
    "escrow_key_id" TEXT NOT NULL,
    -- RSA-OAEP (SHA-256) with the vendor's escrow key, whose private half stays in the KMS.
    "wrapped_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "backup_key_escrows_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "backup_key_escrows_installation_id_key_id_key"
  ON "backup_key_escrows"("installation_id", "key_id");
ALTER TABLE "backup_key_escrows" ADD CONSTRAINT "backup_key_escrows_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "installations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "restore_codes" (
    "id" UUID NOT NULL,
    "installation_id" UUID NOT NULL,
    -- SHA-256 of the code; the code is shown once.
    "code_hash" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "owner_verification" TEXT NOT NULL,
    "issued_by" TEXT NOT NULL,
    "issuer_name" TEXT NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "used_from" TEXT,
    "notified_at" TIMESTAMPTZ(3),

    CONSTRAINT "restore_codes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "restore_codes_code_hash_key" ON "restore_codes"("code_hash");
CREATE INDEX "restore_codes_installation_id_issued_at_idx" ON "restore_codes"("installation_id", "issued_at");
ALTER TABLE "restore_codes" ADD CONSTRAINT "restore_codes_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "installations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
