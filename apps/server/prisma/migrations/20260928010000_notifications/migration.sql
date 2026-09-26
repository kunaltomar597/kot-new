-- AlterTable
ALTER TABLE "alerts" ADD COLUMN     "channels" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "cleared_at" TIMESTAMPTZ(3),
ADD COLUMN     "dedupe_key" TEXT,
ADD COLUMN     "escalate_at" TIMESTAMPTZ(3),
ADD COLUMN     "escalated_at" TIMESTAMPTZ(3),
ADD COLUMN     "escalated_to" UUID[] DEFAULT ARRAY[]::UUID[],
ADD COLUMN     "next_repeat_at" TIMESTAMPTZ(3),
ADD COLUMN     "order_id" UUID,
ADD COLUMN     "pager_text" TEXT,
ADD COLUMN     "recipient_ids" UUID[] DEFAULT ARRAY[]::UUID[],
ADD COLUMN     "repeat_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "table_session_id" UUID;

-- CreateIndex
CREATE INDEX "alerts_status_escalate_at_idx" ON "alerts"("status", "escalate_at");

-- CreateIndex
CREATE INDEX "alerts_status_next_repeat_at_idx" ON "alerts"("status", "next_repeat_at");

-- CreateIndex
CREATE INDEX "alerts_restaurant_id_dedupe_key_idx" ON "alerts"("restaurant_id", "dedupe_key");

