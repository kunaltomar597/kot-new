-- P2-04b: pager firmware is released like the restaurant PC's installer (PGR-011, UPD-002,
-- UPD-003): on a channel, rolled out by percentage or cohort, paused or halted. Each PC fetches
-- it, checks it and passes it on to its pagers.
ALTER TYPE "ReleaseComponent" ADD VALUE IF NOT EXISTS 'PAGER_FIRMWARE';
