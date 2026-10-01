-- P4-07b: the suspicious-activity report (RPT-014, AUD-006) looks up whether an item sent to the
-- kitchen is on a settled bill, and which printed bill an item was taken off, by order item.

-- CreateIndex
CREATE INDEX "invoice_lines_order_item_id_idx" ON "invoice_lines"("order_item_id");
