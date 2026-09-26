-- AlterTable
ALTER TABLE "bills" ADD COLUMN     "edit_approved_by_id" UUID,
ADD COLUMN     "edit_reason" TEXT,
ADD COLUMN     "edit_requested_by_id" UUID,
ADD COLUMN     "editing_invoice_id" UUID;

-- AlterTable
ALTER TABLE "invoice_lines" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "tax_lines" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

