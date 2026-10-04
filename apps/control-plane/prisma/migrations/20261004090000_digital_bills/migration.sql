-- Digital bills (BILL-012, P7-09a): what was sent for each restaurant, and the bill behind its
-- link until it expires.
CREATE TABLE "digital_bills" (
    "id" UUID NOT NULL,
    "installation_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "phone_masked" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "restaurant_name" TEXT NOT NULL,
    "invoice_number" TEXT NOT NULL,
    "invoice_date" DATE NOT NULL,
    "grand_total" INTEGER NOT NULL,
    "lines" JSONB,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL,
    "provider_message_id" TEXT,
    "error" TEXT,
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(3),
    "purged_at" TIMESTAMPTZ(3),

    CONSTRAINT "digital_bills_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "digital_bills_token_hash_key" ON "digital_bills"("token_hash");
CREATE UNIQUE INDEX "digital_bills_installation_id_request_id_key" ON "digital_bills"("installation_id", "request_id");
CREATE INDEX "digital_bills_installation_id_created_at_idx" ON "digital_bills"("installation_id", "created_at");
CREATE INDEX "digital_bills_expires_at_idx" ON "digital_bills"("expires_at");

ALTER TABLE "digital_bills" ADD CONSTRAINT "digital_bills_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "installations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "digital_bills" ADD CONSTRAINT "digital_bills_status_check" CHECK ("status" IN ('SENT', 'FAILED'));
ALTER TABLE "digital_bills" ADD CONSTRAINT "digital_bills_channel_check" CHECK ("channel" IN ('WHATSAPP', 'SMS'));
