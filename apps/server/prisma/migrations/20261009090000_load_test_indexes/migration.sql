-- P8-01a: found by the load test at design capacity. A combo line's parts are read on every
-- kitchen step and by the live order feed; without an index each read scanned every order item
-- the restaurant ever had.

-- CreateIndex
CREATE INDEX "order_items_parent_order_item_id_idx" ON "order_items"("parent_order_item_id");
