-- Call waiter / request bill from the QR page (P5-05c, QR-011): the inbox of requests picked up
-- from the relay, written first so a second pickup or a restart never raises one twice, and what
-- the relay was last told.
CREATE TABLE "relay_service_requests" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "relay_request_id" UUID NOT NULL,
    "table_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "outcome" TEXT,
    "service_request_id" UUID,
    "rejection_reason" TEXT,
    "pushed_hash" TEXT,
    "pushed_status" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "relay_service_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "relay_service_requests_type_check" CHECK ("type" IN ('WATER', 'WAITER', 'BILL')),
    CONSTRAINT "relay_service_requests_outcome_check" CHECK ("outcome" IN ('RAISED', 'REJECTED', 'EXPIRED'))
);

CREATE UNIQUE INDEX "relay_service_requests_relay_request_id_key" ON "relay_service_requests"("relay_request_id");
CREATE INDEX "relay_service_requests_service_request_id_idx" ON "relay_service_requests"("service_request_id");
CREATE INDEX "relay_service_requests_restaurant_id_outcome_idx" ON "relay_service_requests"("restaurant_id", "outcome");

ALTER TABLE "relay_service_requests" ADD CONSTRAINT "relay_service_requests_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "relay_service_requests" ADD CONSTRAINT "relay_service_requests_service_request_id_fkey" FOREIGN KEY ("service_request_id") REFERENCES "service_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
