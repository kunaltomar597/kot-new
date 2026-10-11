-- P8-03b (threat model "Data on the restaurant PC", PC-T3): payments, cash movements and day-ends
-- are written once and never changed by the application, so its role loses UPDATE on them. A
-- payment's mode or amount, a cash movement or a closed day's figures can then no longer be
-- changed with the server's own database login, only by the database owner (AUD-004, SEC-007).
-- Corrections stay what they were: a new record (a refund, a correcting cash movement) with its
-- audit entry.
REVOKE UPDATE ON payments, cash_movements, day_ends FROM rp_app;
