-- MENU-007: a dish served only at some hours, e.g. breakfast 07:00-11:00. Local times "HH:MM";
-- an end before the start runs past midnight. Both or neither.
ALTER TABLE "items" ADD COLUMN "window_start" TEXT, ADD COLUMN "window_end" TEXT;
ALTER TABLE "items" ADD CONSTRAINT "items_window_check"
  CHECK (("window_start" IS NULL) = ("window_end" IS NULL));
