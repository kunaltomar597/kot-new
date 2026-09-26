-- P1-01b: the restaurant profile (ONB-004 step 1): contact details, opening hours and the logo.
-- The logo references a photo from the photo store (P1-04); a photo in use cannot be removed.
-- AlterTable
ALTER TABLE "restaurants" ADD COLUMN     "business_hours" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "email" TEXT,
ADD COLUMN     "logo_photo_id" UUID,
ADD COLUMN     "phone" TEXT;

-- AddForeignKey
ALTER TABLE "restaurants" ADD CONSTRAINT "restaurants_logo_photo_id_fkey" FOREIGN KEY ("logo_photo_id") REFERENCES "photos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

