-- AlterTable
ALTER TABLE "credentials" ADD COLUMN     "confirmed_at" TIMESTAMPTZ(3),
ADD COLUMN     "failure_window_started_at" TIMESTAMPTZ(3),
ADD COLUMN     "last_totp_step" BIGINT,
ADD COLUMN     "pending_secret" TEXT;

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "previous_token_hash" TEXT,
ADD COLUMN     "second_factor_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "recovery_codes" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "override_grants" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "requester_id" UUID NOT NULL,
    "requester_session_id" UUID NOT NULL,
    "approver_id" UUID NOT NULL,
    "capability" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" UUID,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "override_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "recovery_codes_code_hash_key" ON "recovery_codes"("code_hash");

-- CreateIndex
CREATE INDEX "recovery_codes_restaurant_id_idx" ON "recovery_codes"("restaurant_id");

-- CreateIndex
CREATE INDEX "recovery_codes_staff_id_idx" ON "recovery_codes"("staff_id");

-- CreateIndex
CREATE UNIQUE INDEX "override_grants_token_hash_key" ON "override_grants"("token_hash");

-- CreateIndex
CREATE INDEX "override_grants_restaurant_id_idx" ON "override_grants"("restaurant_id");

-- CreateIndex
CREATE INDEX "override_grants_expires_at_idx" ON "override_grants"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_previous_token_hash_key" ON "sessions"("previous_token_hash");

-- AddForeignKey
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Operational tables: expired override grants and replaced recovery codes are removed by the
-- application, so rp_app may delete them (P0-08 rule: DELETE is granted explicitly per table).
GRANT DELETE ON recovery_codes, override_grants TO rp_app;
