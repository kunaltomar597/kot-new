-- P7-02c: plans, subscriptions, the vendor's invoices and payments (VCP-003). Money in paise.
CREATE TYPE "BillingCycle" AS ENUM ('MONTHLY', 'QUARTERLY', 'YEARLY');
CREATE TYPE "VendorInvoiceStatus" AS ENUM ('ISSUED', 'PAID', 'VOID');
CREATE TYPE "PaymentMode" AS ENUM ('UPI', 'BANK_TRANSFER', 'CHEQUE', 'CASH', 'CARD', 'OTHER');

CREATE TABLE "plans" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "monthly_price" INTEGER,
    "quarterly_price" INTEGER,
    "yearly_price" INTEGER,
    "device_limits" JSONB NOT NULL,
    "modules" TEXT[],
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "plans_prices_paise" CHECK (
      coalesce("monthly_price", 0) >= 0 AND coalesce("quarterly_price", 0) >= 0
      AND coalesce("yearly_price", 0) >= 0
    )
);
CREATE UNIQUE INDEX "plans_code_key" ON "plans"("code");

CREATE TABLE "subscriptions" (
    "tenant_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "cycle" "BillingCycle" NOT NULL,
    "price" INTEGER NOT NULL CHECK ("price" >= 0),
    "started_on" DATE NOT NULL,
    "next_invoice_on" DATE NOT NULL,
    "cancelled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("tenant_id")
);

CREATE TABLE "vendor_invoices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "amount" INTEGER NOT NULL CHECK ("amount" >= 0),
    "due_on" DATE NOT NULL,
    "status" "VendorInvoiceStatus" NOT NULL DEFAULT 'ISSUED',
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMPTZ(3),
    "voided_at" TIMESTAMPTZ(3),
    "void_reason" TEXT,

    CONSTRAINT "vendor_invoices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "vendor_invoices_number_key" ON "vendor_invoices"("number");
CREATE UNIQUE INDEX "vendor_invoices_tenant_id_period_start_key" ON "vendor_invoices"("tenant_id", "period_start");
CREATE INDEX "vendor_invoices_status_due_on_idx" ON "vendor_invoices"("status", "due_on");

CREATE TABLE "vendor_payments" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "amount" INTEGER NOT NULL CHECK ("amount" > 0),
    "mode" "PaymentMode" NOT NULL,
    "reference" TEXT,
    "received_on" DATE NOT NULL,
    "recorded_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_payments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "vendor_payments_invoice_id_idx" ON "vendor_payments"("invoice_id");

ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vendor_invoices" ADD CONSTRAINT "vendor_invoices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vendor_payments" ADD CONSTRAINT "vendor_payments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "vendor_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Whether billing set a licence's current state, so a payment lifts only what billing did.
ALTER TABLE "installation_licences" ADD COLUMN "set_by_billing" BOOLEAN NOT NULL DEFAULT false;
