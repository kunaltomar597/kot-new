-- P1-01a: whether prices include GST is the `billing.priceMode` setting (the settings registry),
-- not a restaurant column; one source of truth. Invoices keep their own `price_mode` snapshot.
ALTER TABLE "restaurants" DROP COLUMN "price_mode";
