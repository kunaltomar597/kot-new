-- P2-06d: service requests from the table tablet (TAB-004, WTR-005). Like every table created
-- after P0-08, rp_app gets SELECT, INSERT and UPDATE by default and no DELETE: requests are kept.

-- CreateEnum
CREATE TYPE "ServiceRequestType" AS ENUM ('WATER', 'WAITER', 'BILL');

-- CreateEnum
CREATE TYPE "ServiceRequestState" AS ENUM ('ACTIVE', 'ESCALATED', 'ACKNOWLEDGED', 'CANCELLED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "ServiceRequestSource" AS ENUM ('TABLE_TABLET', 'QR');

-- CreateTable
CREATE TABLE "service_requests" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "table_session_id" UUID NOT NULL,
    "table_id" UUID NOT NULL,
    "type" "ServiceRequestType" NOT NULL,
    "state" "ServiceRequestState" NOT NULL DEFAULT 'ACTIVE',
    "source" "ServiceRequestSource" NOT NULL,
    "raised_by_device_id" UUID,
    "alert_id" UUID,
    "escalated_at" TIMESTAMPTZ(3),
    "acknowledged_at" TIMESTAMPTZ(3),
    "acknowledged_by_id" UUID,
    "closed_at" TIMESTAMPTZ(3),
    "closed_by_id" UUID,
    "closed_by_device_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "service_requests_alert_id_key" ON "service_requests"("alert_id");

-- CreateIndex
CREATE INDEX "service_requests_restaurant_id_state_idx" ON "service_requests"("restaurant_id", "state");

-- CreateIndex
CREATE INDEX "service_requests_table_session_id_state_idx" ON "service_requests"("table_session_id", "state");

-- AddForeignKey
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_table_session_id_fkey" FOREIGN KEY ("table_session_id") REFERENCES "table_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

