-- P7-06a: the automatic retention (DATA-007, BRD §9.3) removes old operational rows. These tables
-- came after the roles migration, whose loop granted DELETE only on the tables then present.
-- Orders, bills, payments and the audit log stay protected (AUD-004).
GRANT DELETE ON "alerts", "service_requests", "print_notices" TO rp_app;
