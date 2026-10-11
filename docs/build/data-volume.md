# Data volume over five years (DATA-012, P7-06d)

The BRD's target: five years of transactions for a restaurant at design capacity (§7.2: 2,000
orders a day, 100 tables, 1,000 dishes), photos and backups aside, fit in 100 GB.

**Result: about 50 GB, half the target.** Measured on 2026-10-04.

## How it is measured

`apps/server/test/performance/volume.perf.test.ts` takes two measurements, then projects them with
`volume-model.ts`:

1. **A service day through the real API.** This is P1-14's scenario: about 100 orders with
   variants, modifiers, combos, cancellations, voids, discounts, split bills, reprints and a day
   end. It gives how many rows of each table an order writes, every table the app touches, and the
   average size of a row.
2. **Days at design capacity.** `generate-year` writes 2,000 orders a day on the 1,000-dish
   restaurant. It gives what a row really costs on disk with its indexes, once a table holds
   hundreds of thousands of them.

For each table:

- **Rows per order** is the larger of the two counts.
- **Bytes per row** comes from the bulk run where it has at least 1,000 rows (MEASURED). Otherwise
  it is the row's own size plus its header, times the median index overhead (ESTIMATED).
- **Kept for** five years, 1,826 days or 3,652,000 orders. Tables that the daily retention or the
  event bus empty are kept for 90 days only: alerts, service requests, print notices, idempotency
  records, the outbox and the inbox.
- **Tables neither run writes** get stated, generous figures (ASSUMED):
  - QR orders' inbox rows (one order in four, 2 kB each);
  - diners' calls from QR;
  - feedback and diners' numbers (one bill in five);
  - waiter-app approvals;
  - cash in and out.

On top of the growing tables:

- 30 % for dead rows and free space that updates leave behind. Orders, bills and sessions change
  several times before they settle.
- The fixed part:
  - the schema and the 1,000-dish menu;
  - 1 GB of write-ahead log (PostgreSQL's default `max_wal_size`).

## The numbers

The projection comes out the same from 30 days (60,000 orders) and from 180 days (360,000 orders),
50,346 and 50,353 MB, so the costs per row have settled.

|                                      |         MB |
| ------------------------------------ | ---------: |
| Growing tables, five years           |     37,898 |
| With 30 % for updates                |     49,267 |
| Fixed: schema, menu, write-ahead log |      1,086 |
| **Total**                            | **50,353** |
| Target                               |    100,000 |

The largest tables over five years (180-day run):

| Table                 | Rows per order | Bytes per row | Basis     | Five years (MB) |
| --------------------- | -------------: | ------------: | --------- | --------------: |
| audit_log             |           4.85 |           406 | MEASURED  |           7,193 |
| order_items           |           4.00 |           419 | MEASURED  |           6,117 |
| invoice_lines         |           3.98 |           300 | MEASURED  |           4,366 |
| invoices              |           1.00 |           838 | MEASURED  |           3,059 |
| recommendation_events |           2.69 |           192 | MEASURED  |           1,881 |
| kot_lines             |           2.33 |           221 | ESTIMATED |           1,877 |
| relay_orders          |           0.25 |         2,000 | ASSUMED   |           1,826 |
| tax_lines             |           2.00 |           221 | MEASURED  |           1,615 |
| kots                  |           1.32 |           325 | MEASURED  |           1,568 |
| order_events          |           1.19 |           359 | ESTIMATED |           1,562 |
| outbox (90 days)      |           6.63 |           985 | ESTIMATED |           1,176 |
| orders                |           1.00 |           284 | MEASURED  |           1,036 |
| payments              |           1.00 |           235 | MEASURED  |             856 |
| table_sessions        |           0.80 |           205 | MEASURED  |             599 |

Every other table is under 500 MB over five years. The test prints the full table.

As a cross-check, the design-capacity database after 180 days took 2,626 MB on disk. Scaled to five
years that is 26.6 GB for the generator's tables alone. The projection adds the tables only the
real service day writes, the assumed ones and the 30 %.

## What it means

- A 256 GB SSD (§11) holds five years of data with room for the backups on the same drive: the
  nightly backups compress to about a fifth of the database (`restore-timing.md`).
- The audit log is the largest table. It is kept whole: AUD-004 forbids deleting it, except with a
  financial year through archive-then-purge (P7-06b).
- Archiving the oldest years (P7-06b) brings the database back down when the drive needs room.

## Running it again

```sh
cd apps/server
RP_PERF=1 RP_PERF_DAYS=30 pnpm exec vitest run --silent=false --project performance test/performance/volume.perf.test.ts
```

`RP_PERF_DAYS` defaults to 30. 30 days take about 25 seconds and 180 days about 2 minutes on the build
Mac. The test fails if the projection passes 100 GB, so a schema change that blows up a table shows
up the next time it runs. Record new numbers here.
