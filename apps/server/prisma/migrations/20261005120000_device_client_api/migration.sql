-- P7-04d: the client API each app last said it speaks (UPD-006), so the manager sees which phones,
-- tablets and screens need updating before the server stops serving them.
ALTER TABLE "devices" ADD COLUMN "client_api" TEXT;
