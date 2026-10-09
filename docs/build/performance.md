# Performance at design capacity (P8-01a: NFR-P01 to NFR-P04, NFR-P08 to NFR-P11)

BRD §7.1 sets the response targets; §7.2 says they must hold at design capacity: 100 tables, 60
table tablets, 30 pagers, 20 waiter devices, 6 kitchen screens, 8 printers, 2,000 orders a day
with a peak of 300 an hour, 200 live connections, 1,000 dishes and years of history.

**Result: every target the simulated rush covers is met, with nothing lost or duplicated.** The
load test found five faults first: a screen that fell behind a busy kitchen, a deadlock, two
queries that grew with the restaurant's history, and reports near their limit. All are fixed (see
"What the load test found").

The online targets (NFR-P05, NFR-P06 through the QR relay), the screens' own speed (NFR-P07) and
the QR menu's first view (NFR-P12) are P8-01b; S1 with real devices on the lab rig is P8-01c.

## How it is measured

`apps/server/test/load/` (ADR-0020) simulates the restaurant against the built server, which runs
in a process of its own with TLS and the pager broker, on a PostgreSQL as durable as the restaurant
PC's: fsync, synchronous commit, full-page writes, and WAL archived during the rush.

- **The restaurant**: 100 tables in 4 sections, each waiter given 5 for the day; 1,000 dishes, one
  in ten with sizes and some with options; 6 stations, each with a kitchen screen in station mode
  and a ticket printer; 2 bill printers at the counter.
- **The devices**, all with the apps' own client (`@rp/api-client`), each re-reading its screens
  after the events that change them, as the apps do:
  - 60 table tablets (on tables 1 to 60), 20 waiter phones, 6 kitchen screens, 2 POS and 2
    managers' dashboards;
  - 110 more console screens showing the alert centre, signed in as managers, to make 200 live
    connections. They hear every alert and read the alert list again after each one: the
    heaviest a console screen can be, about 45 reads a second during the rush.
- **30 pagers** on MQTTS (20 waiters, 8 runners, 2 managers) and **8 printers** on raw TCP.
- **The history**: 365 days at 2,000 orders a day (730,000 orders, 2.9 million order lines, 1.5
  million audit entries) from the reports test's generator, left as a year of service leaves it:
  90 days of alerts, today's suggestions learned, vacuumed and analysed.
- **The rush**: 80 tables are seated first. Then 20 minutes at 300 orders an hour, arriving
  whether or not the server keeps up:
  - 45 % another round from a waiter's phone;
  - 20 % diners' orders on a tablet, approved by the waiter;
  - 25 % new parties, 10 % takeaway at the counter;
  - a bill as often as a new party;
  - 90 diners' calls and 1,800 looks at the suggestions an hour;
  - a dish out of stock every minute and back 30 s later;
  - a twelve-month report every 2 minutes;
  - one order in ten sent twice with the same key, as the phones' outbox does after a timeout.

  The kitchen starts, cooks (30 to 120 s), marks ready and bumps each ticket. Waiters approve,
  acknowledge on the pager or the phone, pick up and serve, and resolve calls; cashiers bill,
  print and take payment. The kitchen is faster than a real one so that tables turn over within
  the run.

- **The restart**: after the rush the server is killed (SIGKILL) and started again, and every
  connection and pager must come back by itself.

What each figure is (decision 690):

- **NFR-P01**: from the request that sends the order (or approves the diner's order) to the read
  of the station's kitchen screen that first shows the ticket. The screen's own 250 ms wait after
  the event is included.
- **NFR-P02**: to the ticket's last byte at the station's printer.
- **NFR-P03**: from the kitchen's "Ready" (the first since the table's last ready alert closed),
  or the tablet's call, to the alert on each recipient's pager.
- **NFR-P04**: per change, until the last of the 200 devices has heard it.
- **NFR-P08**: from opening the bill to its last byte at the counter's printer (preview, invoice,
  print).
- **NFR-P09** and **NFR-P10**: the HTTP round trip.
- **NFR-P11**: from the kill to each client's resynchronisation, judged by the slowest.

Percentiles are nearest-rank: the p95 of 100 samples is the 95th smallest.

To run it: `pnpm build`, then `RP_PERF=1 pnpm --filter @rp/server test:perf load`. See
`apps/server/README.md` for reusing a set-up history (`RP_LOAD_BASE`).

## Measured on 2026-10-09

Run of 2026-10-09 18:11 UTC on darwin 25.5.0, Apple M5 (10 cores), 16 GB, Node.js v24.13.0, PostgreSQL 16.10.
Command: `RP_PERF=1 pnpm --filter @rp/server test:perf load`, with `RP_LOAD_ADMIN_URL` (a
PostgreSQL 16 with the restaurant PC's durability, WAL archiving and `pg_stat_statements`) and
`RP_LOAD_BASE` (the year of history set up once, copied for the run).

| Target  | What                                                                   |        Budget | Samples |     p50 |     p95 |     p99 |     Max | Met |
| ------- | ---------------------------------------------------------------------- | ------------: | ------: | ------: | ------: | ------: | ------: | --- |
| NFR-P01 | Order sent (or a diner’s order approved) → on its kitchen screen       | p95 ≤ 1000 ms |     253 |  364 ms |  425 ms |  459 ms |  464 ms | yes |
| NFR-P02 | Order sent → KOT out of the station printer                            | p95 ≤ 3000 ms |     253 |   34 ms |   51 ms |   87 ms |   89 ms | yes |
| NFR-P03 | Kitchen “Ready”, or a diner’s call → the waiter’s pager                | p95 ≤ 2000 ms |     370 |   28 ms |   78 ms |  113 ms |  135 ms | yes |
| NFR-P04 | Availability change → every connected device (the last of each change) | p95 ≤ 2000 ms |      39 |   21 ms |   75 ms |   88 ms |   88 ms | yes |
| NFR-P08 | Bill opened → printed at the counter                                   | p95 ≤ 3000 ms |      31 |   33 ms |   47 ms |   70 ms |   70 ms | yes |
| NFR-P09 | Recommendations on a phone or tablet                                   |  p95 ≤ 200 ms |     740 |   15 ms |   27 ms |   69 ms |   98 ms | yes |
| NFR-P10 | A report over the last twelve months                                   | p95 ≤ 5000 ms |      10 | 1622 ms | 3370 ms | 3370 ms | 3370 ms | yes |
| NFR-P11 | Server killed → every client reconnected and in sync (each one)        |  max ≤ 30.0 s |     200 | 1688 ms | 2288 ms | 3542 ms | 3904 ms | yes |

NFR-P01: the ticket’s event at the kitchen screen: p50 30 ms, p95 45 ms, max 86 ms (253).

| Check                                              | Result | Detail      |
| -------------------------------------------------- | ------ | ----------- |
| Every order stored once, none extra                | pass   | 172 checked |
| Every order sent twice was answered with the first | pass   | 16 checked  |
| One KOT per station of each order, none duplicated | pass   | 172 checked |
| Every KOT on its station’s kitchen screen          | pass   | 473 checked |
| Every KOT printed once at its station              | pass   | 473 checked |
| Every bill printed once at its counter             | pass   | 31 checked  |
| Every alert reached the pagers of its people       | pass   | 416 checked |
| Every availability change reached every device     | pass   | 42 checked  |
| Every device stayed paired and signed in           | pass   | 200 checked |
| No request failed                                  | pass   | 0 checked   |

The server was killed after the rush and was answering again 1192 ms later; the pagers were back after 1146 ms (median) and 2115 ms (the last).

The server's process during the rush: 15 % of one core on average, 66 % at most; memory 970 MB in the first minute, 596 MB in the last, 992 MB at most (239 samples, every 5 s).
The load generator's own timers ran up to 12 ms late (p99), 76 ms at worst.

| What happened                  | Times |
| ------------------------------ | ----: |
| alerts without a trigger found |     0 |
| availability changes           |    42 |
| bills paid                     |    31 |
| diners’ calls                  |    16 |
| diners’ orders approved        |    19 |
| orders from tablets            |    19 |
| orders from waiters            |   141 |
| orders sent twice              |    16 |
| pager messages                 |   832 |
| reports run                    |    10 |
| suggestions looked at          |   660 |
| tables seated                  |    97 |
| takeaway orders                |    12 |
| tickets cooked                 |   449 |

Requests during the rush, by operation:

| Operation                  | Calls |     p50 |     p95 |     p99 |     Max |
| -------------------------- | ----: | ------: | ------: | ------: | ------: |
| `acknowledgeDeviceAlert`   |   165 |    5 ms |   27 ms |   50 ms |   54 ms |
| `approveOrder`             |    19 |   33 ms |   84 ms |   84 ms |   84 ms |
| `bumpKot`                  |   428 |   12 ms |   45 ms |   85 ms |  103 ms |
| `getDiscountReport`        |     1 |  242 ms |  242 ms |  242 ms |  242 ms |
| `getGstSummary`            |     1 | 3173 ms | 3173 ms | 3173 ms | 3173 ms |
| `getItemSales`             |     1 | 2616 ms | 2616 ms | 2616 ms | 2616 ms |
| `getKdsTickets`            |  1661 |   62 ms |  115 ms |  126 ms |  185 ms |
| `getKitchenReport`         |     1 | 1622 ms | 1622 ms | 1622 ms | 1622 ms |
| `getOrder`                 |   340 |    3 ms |    7 ms |   18 ms |  109 ms |
| `getOrderFeed`             |  1714 |   67 ms |  115 ms |  125 ms |  169 ms |
| `getPaymentModes`          |     1 |  306 ms |  306 ms |  306 ms |  306 ms |
| `getRecommendationReport`  |     1 | 1845 ms | 1845 ms | 1845 ms | 1845 ms |
| `getRecommendations`       |    61 |   13 ms |   17 ms |   20 ms |   20 ms |
| `getSalesSummary`          |     1 |  847 ms |  847 ms |  847 ms |  847 ms |
| `getSourceSales`           |     1 | 3370 ms | 3370 ms | 3370 ms | 3370 ms |
| `getStaffPerformance`      |     1 | 3252 ms | 3252 ms | 3252 ms | 3252 ms |
| `getTableOverview`         | 21583 |   65 ms |  107 ms |  117 ms |  221 ms |
| `getTableRecommendations`  |   679 |   15 ms |   35 ms |   69 ms |   98 ms |
| `getTableReport`           |     1 |  705 ms |  705 ms |  705 ms |  705 ms |
| `issueInvoice`             |    31 |   14 ms |   27 ms |   27 ms |   27 ms |
| `listAlerts`               | 70188 |   72 ms |  100 ms |  110 ms |  165 ms |
| `listDeviceAlerts`         |   799 |   36 ms |   71 ms |   87 ms |  139 ms |
| `listPendingApprovals`     |  2540 |   89 ms |  128 ms |  166 ms |  236 ms |
| `listServiceRequests`      |  1356 |   84 ms |  104 ms |  106 ms |  109 ms |
| `listSessionOrders`        |   367 |    6 ms |   46 ms |   81 ms |  107 ms |
| `listTableServiceRequests` |   121 |    9 ms |   79 ms |   89 ms |  101 ms |
| `listTabletOrders`         |   772 |   51 ms |  103 ms |  117 ms |  181 ms |
| `openBill`                 |    31 |   12 ms |   26 ms |   54 ms |   54 ms |
| `openTable`                |    17 |   11 ms |   35 ms |   35 ms |   35 ms |
| `printInvoice`             |    31 |    7 ms |   12 ms |   23 ms |   23 ms |
| `raiseServiceRequest`      |    16 |   18 ms |   55 ms |   55 ms |   55 ms |
| `recordPayments`           |    31 |    8 ms |   22 ms |   31 ms |   31 ms |
| `requestBill`              |    19 |    9 ms |   11 ms |   11 ms |   11 ms |
| `resolveServiceRequest`    |    16 |    6 ms |   10 ms |   10 ms |   10 ms |
| `setItemAvailability`      |    42 |   12 ms |   41 ms |   72 ms |   72 ms |
| `setOrderItemStatus`       |  2009 |    9 ms |   27 ms |   77 ms |  121 ms |
| `submitOrder`              |    80 |   23 ms |   34 ms |   80 ms |   80 ms |
| `submitTabletOrder`        |    22 |   19 ms |   28 ms |   81 ms |   81 ms |

No request failed.

The database spent 49 s in all on the rush's million statements, most of it on the ten
twelve-month reports; the busiest statements, each screen's reads, take 0.1 to 0.6 ms
(`pg_stat_statements`).

## What the load test found

The short run in the integration suite found the first two; the full run, with the year of
history and the 200 devices at once, found the others and the reports' margin. All are fixed in
this work package, each with a test:

1. **A live screen could fall a second behind a busy kitchen** (NFR-P01). Screens read again
   250 ms after the last event of a burst, so a kitchen's steady stream of events kept a new
   ticket off its screen: up to 1.3 s in the first short run. They now read 250 ms after the
   first event (`@rp/ordering` `liveRefresh`, in the console's and the phones' `useLive`).
2. **An order and a payment at the same table deadlocked**: both failed with a 500. The payment
   locked the audit chain, then the table; the order locked the table, then the audit chain.
   Audit entries are now written when their transaction ends, so the chain's lock is the last
   lock any transaction takes, held for milliseconds (`lock-order.int.test.ts`).
3. **The kitchen screen read every ticket its station never bumped**, which a kitchen that serves
   from the pass never does. With a year of them (730,000 tickets) the screen failed, Prisma
   P2029. Its tickets now come from the dishes still at the station; the not-collected sweep
   likewise (`kds.int.test.ts`).
4. **With the history, a kitchen step took 0.7 s and the live order feed 0.8 s**, and the
   notification consumer fell 18 s behind (NFR-P03 p95 18 s). There were three causes:
   - a combo line's parts were read by an unindexed `parent_order_item_id` (migration
     `20261009090000_load_test_indexes`);
   - the order feed checked every order the restaurant ever took for a live item;
   - it counted each line's parts with Prisma's `_count`, which aggregates the whole
     `order_items` table on every read.

   Afterwards the database's busiest statements take 0.1 to 0.5 ms each.

5. **Two twelve-month reports came close to their 5 s** (NFR-P10): sales by source took 5.1 s
   and the GST summary 4.4 s during the rush. Both now go over each table once (decision 697):
   on their own, 2.45 s became 1.56 s and 3.7 s became 2.3 s, with the same figures to the
   paisa. In the rush above the slowest report took 3.4 s.

## What it means for the restaurant PC

The run was on the build Mac, a fanless MacBook Air (Apple M5, 10 cores, 16 GB, NVMe), which was
also in use during the run. The restaurant PC of §11 has 4 cores, 8 GB and a SATA SSD. During the
rush the server used 15 % of one core on average (66 % at most) and under 1 GB of memory, and the
database worked 49 s in 20 minutes. That leaves room for a machine three to four times slower, as
in `restore-timing.md`. The figures to watch on a
slower PC are the twelve-month reports (NFR-P10), the only ones that take seconds. P8-01c
measures S1 on the lab rig's PC.
