-- AlterTable
ALTER TABLE "devices" ADD COLUMN     "key_algorithm" TEXT,
ADD COLUMN     "staff_id" UUID,
ADD COLUMN     "station_id" UUID;

-- CreateTable
CREATE TABLE "pairing_codes" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "type" "DeviceType" NOT NULL,
    "name" TEXT NOT NULL,
    "table_id" UUID,
    "station_id" UUID,
    "staff_id" UUID,
    "created_by_id" UUID,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "device_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pairing_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pairing_codes_code_hash_key" ON "pairing_codes"("code_hash");

-- CreateIndex
CREATE INDEX "pairing_codes_restaurant_id_idx" ON "pairing_codes"("restaurant_id");

-- CreateIndex
CREATE INDEX "pairing_codes_expires_at_idx" ON "pairing_codes"("expires_at");

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_station_id_fkey" FOREIGN KEY ("station_id") REFERENCES "stations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Operational table: expired pairing codes are removed by the application (P0-08 rule).
GRANT DELETE ON pairing_codes TO rp_app;
