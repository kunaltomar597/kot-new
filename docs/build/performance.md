# Performance at design capacity (P8-01a and P8-01b: NFR-P01 to NFR-P12)

BRD §7.1 sets the response targets; §7.2 says they must hold at design capacity: 100 tables, 60
table tablets, 30 pagers, 20 waiter devices, 6 kitchen screens, 8 printers, 2,000 orders a day
with a peak of 300 an hour, 200 live connections, 1,000 dishes and years of history.

**Result: every NFR-P target of §7.1 is met, with nothing lost or duplicated.**

| Target  | Budget         | Measured (p95)               | Where                                       |
| ------- | -------------- | ---------------------------- | ------------------------------------------- |
| NFR-P01 | 1 s            | 436 ms                       | the simulated rush                          |
| NFR-P02 | 3 s            | 63 ms                        | the simulated rush                          |
| NFR-P03 | 2 s            | 75 ms                        | the simulated rush                          |
| NFR-P04 | 2 s            | 25 ms                        | the simulated rush                          |
| NFR-P05 | 30 s           | 20.8 s (2.5 s at the relay)  | the rush, QR pages through the relay        |
| NFR-P06 | 5 s            | 363 ms                       | the rush, QR orders through the relay       |
| NFR-P07 | 100 ms, 300 ms | taps 24 ms, screens 36 ms    | the console in Chromium, CPU 4 times slower |
| NFR-P08 | 3 s            | 105 ms                       | the simulated rush                          |
| NFR-P09 | 200 ms         | 37 ms                        | the simulated rush                          |
| NFR-P10 | 5 s            | 3.2 s                        | the simulated rush                          |
| NFR-P11 | 30 s (each)    | 3.9 s for the slowest client | the simulated rush                          |
| NFR-P12 | 2.5 s LCP      | 544 ms                       | the QR site on a Pixel 7 profile, Slow 4G   |

The measurements found nine faults first, all fixed (see "What the measurements found"): a screen
that fell behind a busy kitchen, a deadlock, two queries that grew with the restaurant's history,
reports near their limit, QR pages that showed a dish's availability up to a minute late, a relay
that read the whole menu for every page that already had it, QR pages that followed an order for
the whole visit, and a kitchen screen whose first touch took 112 ms.

S1 with real devices on the lab rig, the phones' and tablets' own taps (NFR-P07) and the online
targets against the deployed relay are P8-01c.

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

- **QR diners** (P8-01b): the QR relay runs in the harness (`@rp/relay/testing`: its database,
  functions and a stand-in for Supabase Realtime), and the server syncs with it as on the
  restaurant PC, rung by Realtime for new orders. Two simulated internet lines delay every byte
  each way: 20 ms for the restaurant's broadband to Mumbai, 75 ms for diners' phones on 4G (150 ms
  there and back, as NFR-P12's test). At each table without a tablet (40 of the 100) a diner opens
  the QR page when the table is seated; the page asks for the menu every 20 s, as the QR site
  does, follows each order every 3 s and closes when the bill is paid. 15 % of the hour's orders
  are diners' orders on a QR page, approved by the waiter (the order mix is 35 % rounds from the
  waiter's phone, 15 % tablet orders, 15 % QR orders, 25 % new parties, 10 % takeaway).
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
- **NFR-P05**: per availability change and per QR page open when it was made, until that page
  shows it. A page that never showed it (the dish came back before it looked) counts until it
  next looked, which is past 30 s. The relay's own time, what a page opened then would show, is
  given too.
- **NFR-P06**: from the diner's send (the request to the relay) until the dashboard hears the
  server's `OrderSubmitted` for it.
- **NFR-P08**: from opening the bill to its last byte at the counter's printer (preview, invoice,
  print).
- **NFR-P09** and **NFR-P10**: the HTTP round trip.
- **NFR-P11**: from the kill to each client's resynchronisation, judged by the slowest.

Percentiles are nearest-rank: the p95 of 100 samples is the 95th smallest.

To run it: `pnpm build`, then `RP_PERF=1 pnpm --filter @rp/server test:perf load`. See
`apps/server/README.md` for reusing a set-up history (`RP_LOAD_BASE`).

## The simulated rush, measured on 2026-10-10

Run of 2026-10-09 19:44 UTC (2026-10-10 01:14 IST) on darwin 25.5.0, Apple M5 (10 cores), 16 GB, Node.js v24.13.0, PostgreSQL 16.10.
Command: `RP_PERF=1 pnpm --filter @rp/server test:perf load`.

- 100 tables, 1000 dishes, 6 stations with a kitchen screen and a ticket printer each, 2 bill printers;
- 200 live connections (60 tablets, 20 waiter phones, 6 kitchen screens, 2 POS, 2 dashboards, the rest console screens with the alert centre) and 30 pagers;
- 300 orders an hour for 20.0 minutes after 80 tables were seated, on 365 days of history at 2000 orders a day.
- The tables without a tablet order on their QR page through the relay, which the server reaches over a line of 20 ms each way and the diners' phones over 4G at 75 ms each way; each open page asks for the menu every 20.0 s.

| Target  | What                                                                   |        Budget | Samples |     p50 |     p95 |     p99 |     Max | Met |
| ------- | ---------------------------------------------------------------------- | ------------: | ------: | ------: | ------: | ------: | ------: | --- |
| NFR-P01 | Order sent (or a diner’s order approved) → on its kitchen screen       | p95 ≤ 1000 ms |     250 |  363 ms |  436 ms |  485 ms |  486 ms | yes |
| NFR-P02 | Order sent → KOT out of the station printer                            | p95 ≤ 3000 ms |     250 |   33 ms |   63 ms |  130 ms |  131 ms | yes |
| NFR-P03 | Kitchen “Ready”, or a diner’s call → the waiter’s pager                | p95 ≤ 2000 ms |     391 |   27 ms |   75 ms |  120 ms |  132 ms | yes |
| NFR-P04 | Availability change → every connected device (the last of each change) | p95 ≤ 2000 ms |      39 |   20 ms |   25 ms |   70 ms |   70 ms | yes |
| NFR-P05 | Availability change → each open QR page (online)                       |  p95 ≤ 30.0 s |    1465 |  11.9 s |  20.8 s |  21.8 s |  21.9 s | yes |
| NFR-P06 | QR order sent from a diner’s phone → received by the server (online)   | p95 ≤ 5000 ms |       9 |  337 ms |  363 ms |  363 ms |  363 ms | yes |
| NFR-P08 | Bill opened → printed at the counter                                   | p95 ≤ 3000 ms |      26 |   34 ms |  105 ms |  113 ms |  113 ms | yes |
| NFR-P09 | Recommendations on a phone or tablet                                   |  p95 ≤ 200 ms |     715 |   15 ms |   37 ms |   82 ms |  120 ms | yes |
| NFR-P10 | A report over the last twelve months                                   | p95 ≤ 5000 ms |      10 | 1133 ms | 3181 ms | 3181 ms | 3181 ms | yes |
| NFR-P11 | Server killed → every client reconnected and in sync (each one)        |  max ≤ 30.0 s |     200 | 1614 ms | 2135 ms | 2289 ms | 3903 ms | yes |

NFR-P01: the ticket’s event at the kitchen screen: p50 29 ms, p95 57 ms, max 120 ms (250).
NFR-P05: the change at the relay (a page opened then shows it): p50 2357 ms, p95 2487 ms, max 2497 ms (39).
NFR-P06: the diner’s page says the restaurant has it (it asks every 3 s): p50 3480 ms, p95 3493 ms, max 3493 ms (9).

| Check                                                     | Result | Detail       |
| --------------------------------------------------------- | ------ | ------------ |
| Every order stored once, none extra                       | pass   | 172 checked  |
| Every order sent twice was answered with the first        | pass   | 21 checked   |
| One KOT per station of each order, none duplicated        | pass   | 172 checked  |
| Every KOT on its station’s kitchen screen                 | pass   | 477 checked  |
| Every KOT printed once at its station                     | pass   | 477 checked  |
| Every bill printed once at its counter                    | pass   | 26 checked   |
| Every alert reached the pagers of its people              | pass   | 439 checked  |
| Every availability change reached every device            | pass   | 42 checked   |
| Every device stayed paired and signed in                  | pass   | 200 checked  |
| Every QR order the relay took was made once by the server | pass   | 9 checked    |
| Every availability change reached every open QR page      | pass   | 1465 checked |
| No request failed                                         | pass   | 0 checked    |

The server was killed after the rush and was answering again 989 ms later; the pagers were back after 1131 ms (median) and 1166 ms (the last).

The server's process during the rush: 16 % of one core on average, 71 % at most; memory 966 MB in the first minute, 915 MB in the last, 1007 MB at most (240 samples, every 5 s).
The load generator's own timers ran up to 13 ms late (p99), 80 ms at worst.

| What happened                  | Times |
| ------------------------------ | ----: |
| alerts without a trigger found |     1 |
| availability changes           |    42 |
| bills paid                     |    26 |
| diners’ calls                  |    26 |
| diners’ orders approved        |    26 |
| orders from QR pages           |     9 |
| orders from tablets            |    18 |
| orders from waiters            |   136 |
| orders sent twice              |    21 |
| pager messages                 |   878 |
| QR pages opened                |    45 |
| reports run                    |    10 |
| suggestions looked at          |   641 |
| tables seated                  |   108 |
| takeaway orders                |     9 |
| tickets cooked                 |   468 |

Requests during the rush, by operation:

| Operation                  | Calls |     p50 |     p95 |     p99 |     Max |
| -------------------------- | ----: | ------: | ------: | ------: | ------: |
| `acknowledgeDeviceAlert`   |   168 |    6 ms |   31 ms |   47 ms |   48 ms |
| `approveOrder`             |    26 |   29 ms |   53 ms |  119 ms |  119 ms |
| `bumpKot`                  |   453 |   11 ms |   60 ms |   98 ms |  115 ms |
| `getDiscountReport`        |     1 |  271 ms |  271 ms |  271 ms |  271 ms |
| `getGstSummary`            |     1 | 2872 ms | 2872 ms | 2872 ms | 2872 ms |
| `getItemSales`             |     1 | 2859 ms | 2859 ms | 2859 ms | 2859 ms |
| `getKdsTickets`            |  1698 |   59 ms |  119 ms |  135 ms |  174 ms |
| `getKitchenReport`         |     1 | 1132 ms | 1132 ms | 1132 ms | 1132 ms |
| `getOrder`                 |   360 |    3 ms |    8 ms |   47 ms |   79 ms |
| `getOrderFeed`             |  1752 |   66 ms |  116 ms |  129 ms |  175 ms |
| `getPaymentModes`          |     1 |  291 ms |  291 ms |  291 ms |  291 ms |
| `getRecommendationReport`  |     1 | 1384 ms | 1384 ms | 1384 ms | 1384 ms |
| `getRecommendations`       |    56 |   13 ms |   46 ms |  120 ms |  120 ms |
| `getSalesSummary`          |     1 |  837 ms |  837 ms |  837 ms |  837 ms |
| `getSourceSales`           |     1 | 3181 ms | 3181 ms | 3181 ms | 3181 ms |
| `getStaffPerformance`      |     1 | 3172 ms | 3172 ms | 3172 ms | 3172 ms |
| `getTableOverview`         | 22422 |   66 ms |  108 ms |  120 ms |  167 ms |
| `getTableRecommendations`  |   659 |   15 ms |   33 ms |   75 ms |   98 ms |
| `getTableReport`           |     1 |  722 ms |  722 ms |  722 ms |  722 ms |
| `issueInvoice`             |    26 |   17 ms |   27 ms |   35 ms |   35 ms |
| `listAlerts`               | 71586 |   73 ms |  101 ms |  117 ms |  143 ms |
| `listDeviceAlerts`         |   843 |   37 ms |   76 ms |   84 ms |  111 ms |
| `listPendingApprovals`     |  2680 |   90 ms |  130 ms |  155 ms |  167 ms |
| `listServiceRequests`      |  1885 |   88 ms |  114 ms |  122 ms |  128 ms |
| `listSessionOrders`        |   376 |    5 ms |   52 ms |   92 ms |  100 ms |
| `listTableServiceRequests` |   149 |   35 ms |   87 ms |   97 ms |   98 ms |
| `listTabletOrders`         |   681 |   48 ms |  106 ms |  116 ms |  121 ms |
| `openBill`                 |    26 |   12 ms |   92 ms |   95 ms |   95 ms |
| `openTable`                |    28 |   13 ms |   55 ms |   87 ms |   87 ms |
| `printInvoice`             |    26 |    8 ms |   12 ms |   12 ms |   12 ms |
| `raiseServiceRequest`      |    26 |   16 ms |   39 ms |   50 ms |   50 ms |
| `recordPayments`           |    26 |    9 ms |   12 ms |   16 ms |   16 ms |
| `relay order-status`       |   359 |  155 ms |  159 ms |  165 ms |  179 ms |
| `relay qr-menu`            |  2280 |  163 ms |  177 ms |  183 ms |  213 ms |
| `relay submit-order`       |    10 |  170 ms |  184 ms |  184 ms |  184 ms |
| `requestBill`              |    17 |    8 ms |   34 ms |   34 ms |   34 ms |
| `resolveServiceRequest`    |    25 |    6 ms |   10 ms |   10 ms |   10 ms |
| `setItemAvailability`      |    42 |   12 ms |   18 ms |   67 ms |   67 ms |
| `setOrderItemStatus`       |  2049 |    9 ms |   25 ms |   79 ms |  105 ms |
| `submitOrder`              |    70 |   22 ms |   35 ms |   81 ms |   81 ms |
| `submitTabletOrder`        |    20 |   18 ms |   34 ms |   47 ms |   47 ms |

No request failed.

NFR-P06 had 9 samples: of the hour's QR orders, those that found no seated table without a tablet
free of an order on its way became rounds from a waiter's phone. The slowest was 363 ms against
5 s, and the run before this one (with a fault in a check of the harness, since fixed) gave 422 ms
over 14.

The database spent 69 s in all on the rush's 1.2 million statements (the relay's included), most
of it on the ten twelve-month reports (`pg_stat_statements`).

## The screens' own speed (NFR-P07), measured on 2026-10-10

`apps/console/e2e/speed.e2e.ts` (P8-01b) runs the built console and server in Chromium on a
restaurant of the design capacity's size (the development seed grown to 1,000 dishes and 100
tables), with the browser's CPU slowed down 4 times (Lighthouse's mobile setting: the restaurant
PC and the kitchen screens are slower than the build Mac). A cashier seats table 11 and sends ten
dishes from five sections of the menu; the kitchen starts, readies and bumps the ticket; a manager
walks through ten pages of the dashboard. The browser measures itself:

- **a tap**: the longest event of the interaction (pointerdown, pointerup, click) from the input
  to the next painted frame (Event Timing). Under 16 ms the browser does not report it; it counts
  as 16 ms.
- **a screen change**: from the tap's input to the first frame that shows the new screen's
  heading; until nothing on it is loading any more is recorded too.

| What                               | Budget           | Samples |   p50 |    p95 |    Max |
| ---------------------------------- | ---------------- | ------: | ----: | -----: | -----: |
| A tap, to its answer on the screen | p95 ≤ 100 ms     |      51 | 16 ms |  24 ms |  40 ms |
| A screen change, to the new screen | p95 ≤ 300 ms     |      17 | 16 ms |  36 ms |  36 ms |
| A screen change, to its data on it | (for the record) |      17 | 41 ms | 276 ms | 276 ms |

The slowest tap was a dashboard link (40 ms). The slowest screen to fill was the menu editor with
its 1,000 dishes (about 260 ms); every other screen had its data within 170 ms. Run with
`pnpm --filter @rp/console e2e` after `pnpm build`; it prints these figures.

The waiter phones and table tablets are Android apps that Playwright cannot drive; their taps are
measured on real devices in P8-01c.

## The QR menu's first view (NFR-P12), measured on 2026-10-10

The QR site's Playwright test (P5-05b, `apps/qr-menu/e2e/qr-menu.e2e.ts`) opens a 300-dish menu
on a Pixel 7 profile over Slow 4G (150 ms, 1.6 Mbps down, 750 kbps up) with a CPU 4 times slower:
**LCP 544 ms** against 2.5 s, for a page of 406 kB. Photos come from the relay's bucket in the
sizes the phone needs. Run with `pnpm --filter @rp/qr-menu e2e` after `pnpm build`.

## What the measurements found

The short run in the integration suite found the first two; the full run, with the year of
history and the 200 devices at once, found the next three (P8-01a). The QR pages and the speed
test found the rest (P8-01b). All are fixed, each with a test:

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
   paisa. In the rush of P8-01a the slowest report took 3.4 s; in the one above, 3.2 s.

6. **An open QR page showed a dish's availability up to a minute late** (NFR-P05, MENU-006: "the
   QR menu within 30 s"). The relay had the change 2.5 s after it was made, but a page asked for
   the menu every 60 s. It now asks every 20 s (`QR_MENU_REFRESH_MS` in `@rp/ordering`), and at
   once when the diner comes back to the page after the phone's screen was off. Pages now show a
   change within 21 s at p95.

7. **The relay read the whole menu for every page that already had it**: the `?known=` call that
   answers "no change" read the menu document (about 0.5 MB at 1,000 dishes) out of the database
   and parsed it, and pages now ask three times as often. It now leaves the menu unread when the
   browser has the latest version.

8. **A QR page followed every order every 3 s for the rest of the visit**, since "sent to the
   kitchen" was never final: hundreds of calls to the relay's functions per order. An order is now
   settled once every dish is served or taken off (`qrOrderSettled`).

9. **The kitchen screen's first touch took 112 ms** (NFR-P07): the touch that unlocks the sound
   (KDS-009) made the browser's Web Audio context first. It is now made, silent, when the browser
   is idle after the board is painted; the first touch only resumes it, under 16 ms.

## What it means for the restaurant PC

The run was on the build Mac, a fanless MacBook Air (Apple M5, 10 cores, 16 GB, NVMe), which was
also in use during the run. The restaurant PC of §11 has 4 cores, 8 GB and a SATA SSD. During the
rush the server used 16 % of one core on average (71 % at most) and about 1 GB of memory, and the
database worked 69 s in 20 minutes (the relay's database included). That leaves room for a
machine three to four times slower, as in `restore-timing.md`. The figures to watch on a slower
PC are the twelve-month reports (NFR-P10), the only ones that take seconds. P8-01c measures S1 on
the lab rig's PC.

The online figures leave out Supabase's own time: an edge function starting, and the Mumbai
region's distance from the restaurant beyond the lines simulated here. NFR-P06's 363 ms leaves
4.6 s for it; NFR-P05's pages, 9 s. Both are measured again on the deployed relay in P8-01c
(manual task 20).
