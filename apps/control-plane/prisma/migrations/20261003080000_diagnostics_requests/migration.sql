-- P7-08b: support asks a restaurant for diagnostics (UPD-008); its manager allows or declines.
CREATE TYPE "DiagnosticsRequestState" AS ENUM ('PENDING', 'FULFILLED', 'DECLINED');

CREATE TABLE "diagnostics_requests" (
    "id" UUID NOT NULL,
    "installation_id" UUID NOT NULL,
    -- `vendor:<id>`, and the person's name as the restaurant sees it.
    "requested_by" TEXT NOT NULL,
    "requester_name" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL,
    -- Still PENDING after this: lapsed (shown as EXPIRED).
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "state" "DiagnosticsRequestState" NOT NULL DEFAULT 'PENDING',
    "answered_at" TIMESTAMPTZ(3),
    -- { name, role } of the manager who answered.
    "answered_by" JSONB,
    "bundle_id" UUID,

    CONSTRAINT "diagnostics_requests_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "diagnostics_requests_installation_id_requested_at_idx"
  ON "diagnostics_requests"("installation_id", "requested_at");

ALTER TABLE "diagnostics_requests" ADD CONSTRAINT "diagnostics_requests_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "installations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
