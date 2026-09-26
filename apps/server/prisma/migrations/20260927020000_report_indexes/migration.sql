-- CreateIndex
CREATE INDEX "invoices_restaurant_id_invoice_date_idx" ON "invoices"("restaurant_id", "invoice_date");

