-- P4-02e: custom roles (AUTH-012). A custom role is a row of "roles" with built_in = false: its
-- base role, the capabilities it adds ("capabilities", there since P0-08) and those it takes away.
-- Like other master data, custom roles are archived, never deleted: people keep theirs.

-- AlterTable
ALTER TABLE "roles" ADD COLUMN     "archived_at" TIMESTAMPTZ(3),
ADD COLUMN     "removed_capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[];
