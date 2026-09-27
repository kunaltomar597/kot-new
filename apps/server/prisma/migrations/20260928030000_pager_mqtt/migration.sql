-- AlterTable
ALTER TABLE "devices" ADD COLUMN     "battery_percent" INTEGER,
ADD COLUMN     "firmware_version" TEXT,
ADD COLUMN     "mqtt_secret_hash" TEXT,
ADD COLUMN     "online" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "rssi" INTEGER,
ADD COLUMN     "serial" TEXT;

-- CreateIndex
CREATE INDEX "devices_restaurant_id_serial_idx" ON "devices"("restaurant_id", "serial");

