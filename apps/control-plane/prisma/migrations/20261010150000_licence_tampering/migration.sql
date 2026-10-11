-- P8-03b3a: tampering a PC reports calls for a person (SEC-015, LIC-007), and the offline
-- reactivation codes issued are kept, so the code a PC says it took can be checked (LIC-006).
ALTER TYPE "FleetAlertKind" ADD VALUE IF NOT EXISTS 'LICENCE_TAMPERING';

CREATE TABLE "licence_reactivation_codes" (
    "installation_id" UUID NOT NULL,
    "counter" INTEGER NOT NULL,
    "valid_until" DATE NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issued_by" TEXT NOT NULL,
    "used_at" TIMESTAMPTZ(3),

    CONSTRAINT "licence_reactivation_codes_pkey" PRIMARY KEY ("installation_id", "counter")
);

ALTER TABLE "licence_reactivation_codes" ADD CONSTRAINT "licence_reactivation_codes_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "installations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The codes issued before: their day and counter are in the audit log, never the code itself.
INSERT INTO "licence_reactivation_codes" ("installation_id", "counter", "valid_until", "issued_at", "issued_by")
SELECT "target_id"::uuid, ("details"->>'counter')::int, ("details"->>'validUntil')::date, "occurred_at", "actor"
FROM "audit_log"
WHERE "action" = 'licence.reactivation_code' AND "target_type" = 'installation'
ON CONFLICT DO NOTHING;
