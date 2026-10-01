-- P4-05a: indexes for the full report suite (RPT-003, RPT-007 to RPT-009, RPT-018): audit entries
-- by action and business date, alerts and service requests by business date.

-- CreateIndex
CREATE INDEX "audit_log_restaurant_id_action_business_date_idx" ON "audit_log"("restaurant_id", "action", "business_date");

-- CreateIndex
CREATE INDEX "alerts_restaurant_id_business_date_idx" ON "alerts"("restaurant_id", "business_date");

-- CreateIndex
CREATE INDEX "service_requests_restaurant_id_business_date_idx" ON "service_requests"("restaurant_id", "business_date");
