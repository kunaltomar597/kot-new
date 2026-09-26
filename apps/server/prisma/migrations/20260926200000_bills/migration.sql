-- CreateEnum
CREATE TYPE "BillStatus" AS ENUM ('OPEN', 'INVOICED');

-- AlterTable
ALTER TABLE "discounts" ADD COLUMN     "bill_id" UUID,
ADD COLUMN     "revoked_at" TIMESTAMPTZ(3),
ADD COLUMN     "revoked_by_id" UUID;

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "bill_id" UUID,
ADD COLUMN     "customer_phone_consent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "particulars" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "bills" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "table_session_id" UUID,
    "order_id" UUID,
    "status" "BillStatus" NOT NULL DEFAULT 'OPEN',
    "service_charge_removed" BOOLEAN NOT NULL DEFAULT false,
    "customer_name" TEXT,
    "customer_phone" TEXT,
    "customer_phone_consent" BOOLEAN NOT NULL DEFAULT false,
    "customer_gstin" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bills_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bills_table_session_id_key" ON "bills"("table_session_id");

-- CreateIndex
CREATE UNIQUE INDEX "bills_order_id_key" ON "bills"("order_id");

-- CreateIndex
CREATE INDEX "bills_restaurant_id_business_date_idx" ON "bills"("restaurant_id", "business_date");

-- CreateIndex
CREATE INDEX "discounts_bill_id_idx" ON "discounts"("bill_id");

-- CreateIndex
CREATE INDEX "invoices_bill_id_idx" ON "invoices"("bill_id");

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_table_session_id_fkey" FOREIGN KEY ("table_session_id") REFERENCES "table_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bills"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bills"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Bills hold discounts and the service charge choice before printing: money records, so the app
-- never deletes them (AUD-004), like invoices and discounts.
REVOKE DELETE ON TABLE "bills" FROM rp_app;
GRANT SELECT, DELETE ON TABLE "bills" TO rp_purge;
