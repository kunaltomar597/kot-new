-- P0-16b: the server's login takes the nightly backup (`pg_dump` of the whole database) and records
-- the newest migration in it (DATA-002, P7-05a). On the restaurant PC, where the migrations are
-- recorded in _prisma_migrations, rp_app could not read that table, so both failed. Reading it is
-- enough; writing it stays with the migrations' owner.
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    GRANT SELECT ON public._prisma_migrations TO rp_app;
  END IF;
END
$$;
