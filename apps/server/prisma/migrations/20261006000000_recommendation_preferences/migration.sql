-- P4-03c: the manager's pinned, boosted and blocked dishes (REC-009), and the two layers that carry
-- them in suggestions, tracking and order lines. Like every table created after P0-08, rp_app gets
-- SELECT, INSERT and UPDATE by default and no DELETE: a preference is changed in place, back to
-- NORMAL, and its history is in the audit log.

-- AlterEnum
ALTER TYPE "RecommendationLayer" ADD VALUE 'PINNED' BEFORE 'RULE';
ALTER TYPE "RecommendationLayer" ADD VALUE 'BOOSTED' BEFORE 'BEST_SELLER';

-- CreateEnum
CREATE TYPE "RecommendationPreferenceKind" AS ENUM ('NORMAL', 'PIN', 'BOOST', 'BLOCK');

-- CreateTable
CREATE TABLE "recommendation_preferences" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "preference" "RecommendationPreferenceKind" NOT NULL,
    "label" TEXT,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recommendation_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "recommendation_preferences_restaurant_id_item_id_key" ON "recommendation_preferences"("restaurant_id", "item_id");


-- Words only for a pinned or boosted dish.
ALTER TABLE "recommendation_preferences"
    ADD CONSTRAINT "recommendation_preferences_label_check" CHECK ("label" IS NULL OR "preference" IN ('PIN', 'BOOST'));
