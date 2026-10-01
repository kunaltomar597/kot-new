-- P3-01a: the table tablets' brand colour (TAB-003) and what apps report about themselves
-- (TAB-015): charging and the kind of connection, beside the battery and signal pagers already
-- report.

-- AlterTable
ALTER TABLE "restaurants" ADD COLUMN "accent_color" TEXT;

-- AlterTable
ALTER TABLE "devices" ADD COLUMN "charging" BOOLEAN,
ADD COLUMN "network" TEXT;
