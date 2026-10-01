-- Learned recommendations (P6-02, REC-003): the association rules the nightly job learns from the
-- restaurant's own orders, replaced as a whole by each run, and a record of each run.
CREATE TABLE "learned_associations" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "from_item_id" UUID NOT NULL,
    "to_item_id" UUID NOT NULL,
    "pair_count" INTEGER NOT NULL,
    "support_bp" INTEGER NOT NULL,
    "confidence_bp" INTEGER NOT NULL,
    "lift_percent" INTEGER NOT NULL,
    "score" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "learned_associations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "learned_associations_rates_check" CHECK (
      "pair_count" > 0 AND "support_bp" BETWEEN 0 AND 10000
      AND "confidence_bp" BETWEEN 0 AND 10000 AND "lift_percent" >= 0 AND "score" >= 0
    ),
    CONSTRAINT "learned_associations_pair_check" CHECK ("from_item_id" <> "to_item_id")
);

CREATE UNIQUE INDEX "learned_associations_restaurant_id_from_item_id_to_item_id_key" ON "learned_associations"("restaurant_id", "from_item_id", "to_item_id");

CREATE TABLE "learning_runs" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "window_from" DATE NOT NULL,
    "window_to" DATE NOT NULL,
    "orders" INTEGER NOT NULL,
    "baskets" INTEGER NOT NULL,
    "associations" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "learning_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "learning_runs_restaurant_id_created_at_idx" ON "learning_runs"("restaurant_id", "created_at");

-- Derived data, rebuilt every night: the app replaces it.
GRANT DELETE ON "learned_associations" TO rp_app;
