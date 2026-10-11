-- P7-08a: diagnostics bundles a manager sent to support (UPD-008, VCP-007).
CREATE TABLE "diagnostics_bundles" (
    "id" UUID NOT NULL,
    "installation_id" UUID NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    -- { name, role } of the manager who sent it.
    "sent_by" JSONB,
    -- The support request it answered (P7-08b), if any.
    "request_id" UUID,
    "size_bytes" INTEGER NOT NULL,
    -- Scrubbed of secrets and personal data on the PC before it was sent.
    "bundle" JSONB NOT NULL,

    CONSTRAINT "diagnostics_bundles_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "diagnostics_bundles_installation_id_received_at_idx"
  ON "diagnostics_bundles"("installation_id", "received_at");

ALTER TABLE "diagnostics_bundles" ADD CONSTRAINT "diagnostics_bundles_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "installations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
