-- QR orders from the relay (P5-03b, QR-009, QR-010, ORD-013).

-- The diner's own id of each line, so the item's state can be told back to the QR page (QR-007).
ALTER TABLE "order_items" ADD COLUMN "client_line_id" UUID;

-- The inbox of orders picked up from the QR relay: one row per relay order, written before anything
-- else, so a retry, a second pickup or a restart never creates the order twice. It also remembers
-- what the relay was last told about the order.
CREATE TABLE "relay_orders" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "relay_order_id" UUID NOT NULL,
    "table_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "outcome" TEXT,
    "order_id" UUID,
    "rejection_reason" TEXT,
    "pushed_hash" TEXT,
    "pushed_status" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "relay_orders_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "relay_orders_outcome_check" CHECK ("outcome" IN ('CREATED', 'REJECTED', 'EXPIRED'))
);

CREATE UNIQUE INDEX "relay_orders_relay_order_id_key" ON "relay_orders"("relay_order_id");
CREATE UNIQUE INDEX "relay_orders_order_id_key" ON "relay_orders"("order_id");
CREATE INDEX "relay_orders_restaurant_id_outcome_idx" ON "relay_orders"("restaurant_id", "outcome");

ALTER TABLE "relay_orders" ADD CONSTRAINT "relay_orders_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "relay_orders" ADD CONSTRAINT "relay_orders_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
