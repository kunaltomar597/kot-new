-- P8-03b2a (PC-S5, MOBILE-S3): wrong PINs and passwords counted per device as well as per person,
-- so guesses spread over many people still stop; at the limit the device takes none for a while.
ALTER TABLE "devices" ADD COLUMN "pin_failures" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "devices" ADD COLUMN "pin_failure_window_started_at" TIMESTAMPTZ(3);
ALTER TABLE "devices" ADD COLUMN "pins_locked_until" TIMESTAMPTZ(3);
