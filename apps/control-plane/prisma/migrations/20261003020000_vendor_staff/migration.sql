-- P7-02a: vendor staff accounts and sessions (VCP-001, SEC-018).
CREATE TYPE "VendorRole" AS ENUM ('SUPER_ADMIN', 'ONBOARDING', 'SUPPORT', 'FINANCE', 'READ_ONLY');

CREATE TABLE "vendor_users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "VendorRole" NOT NULL,
    "password_hash" TEXT,
    "totp_secret" TEXT,
    "totp_last_step" INTEGER,
    "activated_at" TIMESTAMPTZ(3),
    "setup_token_hash" TEXT,
    "setup_expires_at" TIMESTAMPTZ(3),
    "failed_sign_ins" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "disabled_at" TIMESTAMPTZ(3),
    "last_sign_in_at" TIMESTAMPTZ(3),
    "reviewed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vendor_users_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "vendor_users_email_lower" CHECK ("email" = lower("email"))
);

CREATE UNIQUE INDEX "vendor_users_email_key" ON "vendor_users"("email");
CREATE UNIQUE INDEX "vendor_users_setup_token_hash_key" ON "vendor_users"("setup_token_hash");

CREATE TABLE "vendor_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "ended_at" TIMESTAMPTZ(3),
    "address" TEXT,

    CONSTRAINT "vendor_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "vendor_sessions_token_hash_key" ON "vendor_sessions"("token_hash");
CREATE INDEX "vendor_sessions_user_id_idx" ON "vendor_sessions"("user_id");

ALTER TABLE "vendor_sessions" ADD CONSTRAINT "vendor_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "vendor_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
