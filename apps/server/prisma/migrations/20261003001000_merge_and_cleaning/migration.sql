-- TBL-004 (S): "Needs cleaning" after the guests leave, behind the setting tables.needsCleaning.
ALTER TYPE "TableState" ADD VALUE 'NEEDS_CLEANING';

-- TBL-006: a session merged into another table's session, for one bill.
ALTER TABLE "table_sessions" ADD COLUMN "merged_into_session_id" UUID;
