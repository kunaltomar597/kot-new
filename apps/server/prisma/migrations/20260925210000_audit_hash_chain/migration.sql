-- P0-09: hash-chain position and required hashes. Safe as generated: no installation has audit
-- rows before P0-09.
-- AlterTable
ALTER TABLE "audit_log" ADD COLUMN     "chain_seq" BIGINT NOT NULL,
ALTER COLUMN "prev_hash" SET NOT NULL,
ALTER COLUMN "hash" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "audit_log_chain_seq_key" ON "audit_log"("chain_seq");

