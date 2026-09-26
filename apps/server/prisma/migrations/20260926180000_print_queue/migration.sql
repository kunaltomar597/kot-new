-- AlterTable
ALTER TABLE "printers" ADD COLUMN     "last_error" TEXT,
ADD COLUMN     "offline_since" TIMESTAMPTZ(3),
ADD COLUMN     "redirect_to_id" UUID;

-- CreateTable
CREATE TABLE "print_notices" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "station_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "lines" JSONB NOT NULL,
    "print_status" "KotPrintStatus" NOT NULL DEFAULT 'PENDING',
    "printed_at" TIMESTAMPTZ(3),
    "print_attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "print_notices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "print_notices_restaurant_id_print_status_idx" ON "print_notices"("restaurant_id", "print_status");

-- CreateIndex
CREATE INDEX "print_notices_station_id_business_date_idx" ON "print_notices"("station_id", "business_date");

-- CreateIndex
CREATE INDEX "kots_restaurant_id_print_status_idx" ON "kots"("restaurant_id", "print_status");

-- AddForeignKey
ALTER TABLE "printers" ADD CONSTRAINT "printers_redirect_to_id_fkey" FOREIGN KEY ("redirect_to_id") REFERENCES "printers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "print_notices" ADD CONSTRAINT "print_notices_station_id_fkey" FOREIGN KEY ("station_id") REFERENCES "stations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

