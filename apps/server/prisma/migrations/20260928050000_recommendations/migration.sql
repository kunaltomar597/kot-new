-- P3-04: recommendation rules (REC-002) and tracking (REC-008), and the suggestion an order line
-- was ordered from. Like every table created after P0-08, rp_app gets SELECT, INSERT and UPDATE
-- by default and no DELETE: rules are archived and events are kept for the reports (RPT-012).

-- CreateEnum
CREATE TYPE "RecommendationLayer" AS ENUM ('RULE', 'LEARNED', 'BEST_SELLER');

-- CreateEnum
CREATE TYPE "RecommendationEventKind" AS ENUM ('IMPRESSION', 'TAP', 'ADD_TO_CART', 'ORDERED');

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "recommendation_layer" "RecommendationLayer",
ADD COLUMN     "recommendation_rule_id" UUID;

-- CreateTable
CREATE TABLE "recommendation_rules" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "when_item_id" UUID,
    "when_category_id" UUID,
    "suggest_item_id" UUID,
    "suggest_category_id" UUID,
    "priority" INTEGER NOT NULL,
    "channels" "SalesChannel"[],
    "window_start" TEXT,
    "window_end" TEXT,
    "active_from" DATE,
    "active_until" DATE,
    "label" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "archived_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recommendation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendation_events" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "kind" "RecommendationEventKind" NOT NULL,
    "layer" "RecommendationLayer" NOT NULL,
    "item_id" UUID NOT NULL,
    "rule_id" UUID,
    "channel" "SalesChannel" NOT NULL,
    "table_session_id" UUID,
    "order_item_id" UUID,
    "device_id" UUID,
    "staff_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recommendation_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recommendation_rules_restaurant_id_archived_at_idx" ON "recommendation_rules"("restaurant_id", "archived_at");

-- CreateIndex
CREATE UNIQUE INDEX "recommendation_events_order_item_id_key" ON "recommendation_events"("order_item_id");

-- CreateIndex
CREATE INDEX "recommendation_events_restaurant_id_business_date_kind_idx" ON "recommendation_events"("restaurant_id", "business_date", "kind");


-- Each side of a rule is an item or a category, exactly one of the two.
ALTER TABLE "recommendation_rules"
    ADD CONSTRAINT "recommendation_rules_when_check" CHECK (num_nonnulls("when_item_id", "when_category_id") = 1),
    ADD CONSTRAINT "recommendation_rules_suggest_check" CHECK (num_nonnulls("suggest_item_id", "suggest_category_id") = 1);
