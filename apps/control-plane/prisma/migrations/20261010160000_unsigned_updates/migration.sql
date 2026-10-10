-- P8-03b3b: a PC that takes unsigned updates, a test build at a restaurant, alerts the vendor
-- (UPD-007; threat model "The update pipeline", UPDATE-E3) until it is reinstalled with a
-- signed build.
ALTER TYPE "FleetAlertKind" ADD VALUE IF NOT EXISTS 'UNSIGNED_UPDATES';
