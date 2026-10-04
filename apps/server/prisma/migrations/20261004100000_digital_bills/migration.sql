-- P7-09b: digital bills (BILL-012) sent through the vendor's Control Plane, only with the diner's
-- consent (BILL-011). The whole number stays only until the bill is sent or given up.

CREATE TYPE "DigitalBillStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');

CREATE TABLE "digital_bills" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "channel" TEXT NOT NULL,
    "phone" TEXT,
    "phone_masked" TEXT NOT NULL,
    "status" "DigitalBillStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "link" TEXT,
    "expires_at" TIMESTAMPTZ(3),
    "requested_by_id" UUID,
    "sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "digital_bills_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "digital_bills_channel_check" CHECK ("channel" IN ('WHATSAPP', 'SMS'))
);

CREATE INDEX "digital_bills_status_next_attempt_at_idx" ON "digital_bills"("status", "next_attempt_at");
CREATE INDEX "digital_bills_invoice_id_idx" ON "digital_bills"("invoice_id");

ALTER TABLE "digital_bills" ADD CONSTRAINT "digital_bills_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "digital_bills" ADD CONSTRAINT "digital_bills_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- With the year's invoices go their digital bills (DATA-008).
GRANT SELECT, DELETE ON "digital_bills" TO rp_purge;
