-- P3-05b: diners' feedback after the bill (TAB-014, RPT-013) and their contacts, kept only with
-- consent recorded with its purpose, words and time (BILL-011, SEC-019) and erasable (DATA-011).
-- Like every business table, the app may read, add and change rows but never delete them: erasure
-- clears the phone number and keeps the record that consent was given and withdrawn.

-- CreateEnum
CREATE TYPE "FeedbackSource" AS ENUM ('TABLE_TABLET', 'QR');

-- CreateTable
CREATE TABLE "feedback" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "source" "FeedbackSource" NOT NULL,
    "table_session_id" UUID,
    "table_id" UUID,
    "device_id" UUID,
    "food_rating" INTEGER NOT NULL,
    "service_rating" INTEGER NOT NULL,
    "comment" TEXT,
    "diner_contact_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "feedback_food_rating_check" CHECK ("food_rating" BETWEEN 1 AND 5),
    CONSTRAINT "feedback_service_rating_check" CHECK ("service_rating" BETWEEN 1 AND 5)
);

-- CreateTable
CREATE TABLE "diner_contacts" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "phone" TEXT,
    "consent_purpose" TEXT NOT NULL,
    "consent_text" TEXT NOT NULL,
    "consent_given_at" TIMESTAMPTZ(3) NOT NULL,
    "consent_source" TEXT NOT NULL,
    "device_id" UUID,
    "erased_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "diner_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "feedback_table_session_id_key" ON "feedback"("table_session_id");

-- CreateIndex
CREATE INDEX "feedback_restaurant_id_business_date_idx" ON "feedback"("restaurant_id", "business_date");

-- CreateIndex
CREATE INDEX "diner_contacts_restaurant_id_phone_idx" ON "diner_contacts"("restaurant_id", "phone");

-- AddForeignKey
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_diner_contact_id_fkey" FOREIGN KEY ("diner_contact_id") REFERENCES "diner_contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
