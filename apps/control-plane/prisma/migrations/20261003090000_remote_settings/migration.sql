-- P7-08c: vendor settings and feature flags pushed to restaurant PCs (UPD-010).
CREATE TABLE "remote_settings" (
    -- 'fleet' for every PC, or an installation's id for its own values.
    "scope" TEXT NOT NULL,
    "values" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by" TEXT NOT NULL,

    CONSTRAINT "remote_settings_pkey" PRIMARY KEY ("scope")
);

-- What each PC last reported holding (the digest of its vendor settings).
ALTER TABLE "installations" ADD COLUMN "settings_digest" TEXT;
