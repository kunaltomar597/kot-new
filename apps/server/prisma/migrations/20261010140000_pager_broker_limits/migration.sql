-- P8-03b2b (PAGER-R3): failed sign-ins to the pager broker counted per pager, until its
-- credential is replaced, so a manager sees a pager with an old credential or someone trying one.
ALTER TABLE "devices" ADD COLUMN "mqtt_sign_in_failures" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "devices" ADD COLUMN "mqtt_sign_in_failed_at" TIMESTAMPTZ(3);

-- P8-03b2b (PAGER-R2): an acknowledgement records the device it came from, the wearer's pager
-- among them, as well as the person.
ALTER TABLE "alerts" ADD COLUMN "acknowledged_by_device_id" UUID;
