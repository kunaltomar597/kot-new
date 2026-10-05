-- P2-04b: each pager's update to a firmware version the PC passes on (PGR-011): offered over MQTT
-- when the pager is free, downloaded from this PC, run, failed or rolled back. Operational rows
-- kept with the pager; the application only adds and changes them.
CREATE TABLE "pager_firmware_updates" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "version" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "offers" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "requested_at" TIMESTAMPTZ(3),
    "requested_by_id" UUID,
    "changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pager_firmware_updates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pager_firmware_updates_state_check" CHECK (
        "state" IN ('WAITING', 'OFFERED', 'DOWNLOADING', 'UPDATED', 'FAILED', 'ROLLED_BACK')
    )
);

CREATE UNIQUE INDEX "pager_firmware_updates_device_id_version_key" ON "pager_firmware_updates"("device_id", "version");
CREATE INDEX "pager_firmware_updates_restaurant_id_version_idx" ON "pager_firmware_updates"("restaurant_id", "version");

ALTER TABLE "pager_firmware_updates" ADD CONSTRAINT "pager_firmware_updates_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
