-- P1-02a: a waiter can be given one table rather than a whole section (TBL-002).
-- AlterTable
ALTER TABLE "shift_assignments" ADD COLUMN     "table_id" UUID;

-- AddForeignKey
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

