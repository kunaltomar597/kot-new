-- P4-05c: each invoice line keeps its dish and its share of the invoice's tax, as issued, so the
-- item-wise report (RPT-002) over a year sums them instead of re-spreading every invoice's tax
-- (RPT-018). Existing lines are filled in the same way the report spread them: each tax group's
-- tax over the version's lines by taxable value, largest remainder first, ties to the earlier line.

-- AlterTable
ALTER TABLE "invoice_lines" ADD COLUMN "item_id" UUID, ADD COLUMN "tax_share" INTEGER;

-- Issued lines are protected (BILL-010); this one-off fill adds derived figures only.
ALTER TABLE "invoice_lines" DISABLE TRIGGER "invoice_lines_guard";

UPDATE "invoice_lines" AS il SET "item_id" = oi."item_id"
FROM "order_items" AS oi WHERE oi."id" = il."order_item_id";

WITH "groups" AS (
  SELECT g."invoice_id", g."version", g."tax_group_id", g."weight", t."tax"
  FROM (
    SELECT "invoice_id", "version", "tax_group_id", sum("taxable_value") AS "weight"
    FROM "invoice_lines" WHERE "tax_group_id" IS NOT NULL GROUP BY 1, 2, 3
  ) g
  JOIN (
    SELECT "invoice_id", "version", "tax_group_id", sum("amount") AS "tax"
    FROM "tax_lines" GROUP BY 1, 2, 3
  ) t ON t."invoice_id" = g."invoice_id" AND t."version" = g."version"
     AND t."tax_group_id" = g."tax_group_id"
), "base" AS (
  SELECT il."id", il."invoice_id", il."version", il."tax_group_id", gr."tax",
         CASE WHEN gr."weight" = 0 THEN 0
              ELSE (gr."tax"::bigint * il."taxable_value") / gr."weight" END AS "share",
         CASE WHEN gr."weight" = 0 THEN 0
              ELSE (gr."tax"::bigint * il."taxable_value") % gr."weight" END AS "remainder"
  FROM "invoice_lines" il
  JOIN "groups" gr ON gr."invoice_id" = il."invoice_id" AND gr."version" = il."version"
                  AND gr."tax_group_id" = il."tax_group_id"
), "shares" AS (
  SELECT "id",
         "share" + CASE WHEN "remainder" > 0 AND row_number() OVER (
             PARTITION BY "invoice_id", "version", "tax_group_id" ORDER BY "remainder" DESC, "id"
           ) <= "tax" - sum("share") OVER (PARTITION BY "invoice_id", "version", "tax_group_id")
         THEN 1 ELSE 0 END AS "tax_share"
  FROM "base"
)
UPDATE "invoice_lines" AS il SET "tax_share" = s."tax_share"
FROM "shares" s WHERE s."id" = il."id";

UPDATE "invoice_lines" SET "tax_share" = 0 WHERE "tax_share" IS NULL;

ALTER TABLE "invoice_lines" ENABLE TRIGGER "invoice_lines_guard";
