-- P7-04a: staged rollouts, holding a PC at a version, hotfixes and install outcomes (UPD-002,
-- UPD-003, UPD-004).
ALTER TYPE "FleetAlertKind" ADD VALUE 'UPDATE_FAILED';

ALTER TABLE "releases"
  ADD COLUMN "security_critical" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "rollout_percent" INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN "rollout_state" TEXT NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "rollout_cohort" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  ADD COLUMN "halt_reason" TEXT,
  ADD COLUMN "rollout_changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "target_installation_id" UUID,
  ADD CONSTRAINT "releases_rollout_percent_check" CHECK ("rollout_percent" BETWEEN 0 AND 100),
  ADD CONSTRAINT "releases_rollout_state_check" CHECK ("rollout_state" IN ('ACTIVE', 'PAUSED', 'HALTED')),
  ADD CONSTRAINT "releases_target_installation_id_fkey" FOREIGN KEY ("target_installation_id")
    REFERENCES "installations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "installations" ADD COLUMN "pinned_version" TEXT;

CREATE TABLE "release_installs" (
    "release_id" UUID NOT NULL,
    "installation_id" UUID NOT NULL,
    "outcome" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(3),
    "installed_at" TIMESTAMPTZ(3),
    "failed_at" TIMESTAMPTZ(3),
    "error" TEXT,
    "errors_after" INTEGER NOT NULL DEFAULT 0,
    "error_spike" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "release_installs_pkey" PRIMARY KEY ("release_id", "installation_id"),
    CONSTRAINT "release_installs_outcome_check"
      CHECK ("outcome" IN ('INSTALLING', 'INSTALLED', 'ROLLED_BACK', 'FAILED', 'SILENT'))
);
CREATE INDEX "release_installs_outcome_started_at_idx" ON "release_installs"("outcome", "started_at");
ALTER TABLE "release_installs" ADD CONSTRAINT "release_installs_release_id_fkey" FOREIGN KEY ("release_id") REFERENCES "releases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "release_installs" ADD CONSTRAINT "release_installs_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "installations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
