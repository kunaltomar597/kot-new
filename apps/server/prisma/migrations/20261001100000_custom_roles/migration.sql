-- P4-02e: custom roles (AUTH-012) are master data, archived instead of deleted (BRD §9.4).

-- AlterTable
ALTER TABLE "roles" ADD COLUMN     "archived_at" TIMESTAMPTZ(3);
