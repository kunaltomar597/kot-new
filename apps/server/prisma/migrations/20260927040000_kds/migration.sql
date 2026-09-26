-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'CLEARED');

-- AlterTable
ALTER TABLE "kots" ADD COLUMN     "bumped_at" TIMESTAMPTZ(3),
ADD COLUMN     "bumped_by_device_id" UUID,
ADD COLUMN     "bumped_by_id" UUID;

-- CreateTable
CREATE TABLE "alerts" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "type" TEXT NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'OPEN',
    "kot_id" UUID,
    "table_id" UUID,
    "raised_by_id" UUID,
    "raised_by_device_id" UUID,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "acknowledged_at" TIMESTAMPTZ(3),
    "acknowledged_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "alerts_restaurant_id_status_idx" ON "alerts"("restaurant_id", "status");

-- CreateIndex
CREATE INDEX "alerts_kot_id_idx" ON "alerts"("kot_id");

-- CreateIndex
CREATE INDEX "kots_station_id_bumped_at_idx" ON "kots"("station_id", "bumped_at");

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_kot_id_fkey" FOREIGN KEY ("kot_id") REFERENCES "kots"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Alerts are operational history (who asked for a manager, when it was acknowledged): the default
-- privileges give the app no DELETE on them, and none is granted here.
