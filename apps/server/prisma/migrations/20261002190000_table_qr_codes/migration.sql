-- Table QR codes (P5-04, QR-001): each table's token, at least 128 random bits. The relay keeps only
-- its SHA-256 (P5-03a); this PC keeps the token so the table tent can be printed again.
ALTER TABLE "tables" ADD COLUMN "qr_token" TEXT;
ALTER TABLE "tables" ADD COLUMN "qr_token_issued_at" TIMESTAMPTZ(3);
CREATE UNIQUE INDEX "tables_qr_token_key" ON "tables"("qr_token");
