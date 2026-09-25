-- AlterTable
ALTER TABLE "outbox" ADD COLUMN     "audience" JSONB,
ADD COLUMN     "sequence" BIGINT,
ADD COLUMN     "write_order" BIGSERIAL NOT NULL;

-- CreateTable
CREATE TABLE "event_consumer_cursors" (
    "id" UUID NOT NULL,
    "consumer" TEXT NOT NULL,
    "last_sequence" BIGINT NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_consumer_cursors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "event_consumer_cursors_consumer_key" ON "event_consumer_cursors"("consumer");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_sequence_key" ON "outbox"("sequence");


-- P0-12, hand-written from here: grants and the wake-up trigger.

-- Operational table: cursors of retired consumers can be removed (P0-08 rule for DELETE).
GRANT DELETE ON event_consumer_cursors TO rp_app;

-- write_order is the first sequence object in the schema: the runtime draws from it on every
-- outbox insert, and later sequences get the same right by default.
GRANT USAGE, SELECT ON SEQUENCE outbox_write_order_seq TO rp_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO rp_app;

-- Wakes the event dispatcher when events commit (LISTEN rp_outbox). PostgreSQL delivers a
-- notification only when the inserting transaction commits and folds duplicates, so one statement
-- or a hundred inserts wake it once; the dispatcher also polls in case a notification is missed.
CREATE OR REPLACE FUNCTION rp_outbox_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('rp_outbox', '');
  RETURN NULL;
END
$$;

CREATE TRIGGER outbox_notify
  AFTER INSERT ON outbox
  FOR EACH STATEMENT EXECUTE FUNCTION rp_outbox_notify();
