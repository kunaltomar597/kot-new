-- P7-02b: a tenant's contacts, GSTIN and state (VCP-002).
ALTER TABLE "tenants"
  ADD COLUMN "legal_name" TEXT,
  ADD COLUMN "gstin" TEXT,
  ADD COLUMN "state_code" TEXT,
  ADD COLUMN "contact_name" TEXT,
  ADD COLUMN "contact_email" TEXT,
  ADD COLUMN "contact_phone" TEXT,
  ADD CONSTRAINT "tenants_gstin_upper" CHECK ("gstin" = upper("gstin"));
