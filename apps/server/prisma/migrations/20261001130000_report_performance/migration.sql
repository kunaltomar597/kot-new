-- P4-05c: payments by shift, for the shift report and the drawer (RPT-005, RPT-018).

-- CreateIndex
CREATE INDEX "payments_shift_id_idx" ON "payments"("shift_id");
