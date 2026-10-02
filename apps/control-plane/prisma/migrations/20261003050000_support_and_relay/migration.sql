-- P7-02d: support notes (VCP-007) and QR relay provisioning (VCP-002, VCP-008).
CREATE TABLE "support_notes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "author" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_notes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "support_notes_tenant_id_created_at_idx" ON "support_notes"("tenant_id", "created_at");

-- Notes are kept as written: never changed or deleted.
CREATE FUNCTION support_notes_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'support notes are append-only';
END;
$$;
CREATE TRIGGER support_notes_append_only BEFORE UPDATE OR DELETE ON "support_notes"
  FOR EACH ROW EXECUTE FUNCTION support_notes_append_only();

CREATE TABLE "relay_provisioning" (
    "tenant_id" UUID NOT NULL,
    "credential_id" UUID NOT NULL,
    "credential_sealed" TEXT NOT NULL,
    "credential_digest" TEXT NOT NULL,
    "provisioned_at" TIMESTAMPTZ(3) NOT NULL,
    "credential_issued_at" TIMESTAMPTZ(3) NOT NULL,
    "delivered_at" TIMESTAMPTZ(3),

    CONSTRAINT "relay_provisioning_pkey" PRIMARY KEY ("tenant_id")
);

ALTER TABLE "support_notes" ADD CONSTRAINT "support_notes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "relay_provisioning" ADD CONSTRAINT "relay_provisioning_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
