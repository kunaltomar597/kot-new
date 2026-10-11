# User acceptance test plan (P8-06)

BRD §18.2 lists 14 critical scenarios that must pass before the pilot. Each is covered by an
automated test where one can exist, and by a run with real people and devices where it cannot.
The Business Owner signs the result in `go-live-checklist.md`.

## 1. The 14 critical scenarios

| ID  | Scenario                             | Automated evidence                                                                                | Run with people or devices                                  |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| S1  | Dinner rush, 600 orders in 3 hours   | `[S1]` `apps/server/test/integration/load-rush.int.test.ts`, `pnpm --filter @rp/server test:perf` | Real phones, tablets and pagers on the site Wi-Fi (task 11) |
| S2  | Internet out for 30 minutes          | `[S2]` Phase 5 exit test                                                                          | Router off for 30 minutes (task 18)                         |
| S3  | Server restart mid-service           | Watchdog and reconnect tests; `api-client.int.test.ts` resumes after a restart                    | Restart the service during a busy hour (task 18)            |
| S4  | Printer failure                      | `print-queue.int.test.ts` (offline alert, redirect, reprint)                                      | Unplug a kitchen printer (tasks 13, 18)                     |
| S5  | Pager out of range or battery dead   | Pager and notification tests (`notifications.int.test.ts`, P2-06a)                                | Carry a pager out of range; let one die (task 10)           |
| S6  | Tablet session                       | `[S6]` Phase 3 exit test                                                                          | Two real diners on a tablet                                 |
| S7  | Move table with tickets in progress  | `[S7]` `table-sessions.int.test.ts`                                                               | Once on the floor                                           |
| S8  | Licence: overdue, grace, restriction | `[S8]` `licence-exit.int.test.ts`                                                                 | Reactivation offline with a real code (task 23)             |
| S9  | Update failure and rollback          | `[S9]` `update-exit.int.test.ts`                                                                  | Forced failure on the installed PC (task 14)                |
| S10 | Backup, restore to a new PC, archive | `[S10]` `data-exit.int.test.ts`                                                                   | Restore on a spare PC, timed (task 25)                      |
| S11 | Cross-tenant isolation               | `[S11]` `qr-exit.int.test.ts`, Control Plane authorisation sweep                                  | Penetration test (task 36)                                  |
| S12 | Fraud patterns in reports            | `[S12]` `suspicious-activity.int.test.ts`                                                         | Staged void, reprint and discount on the floor              |
| S13 | QR order with the restaurant offline | `[S13]` `qr-exit.int.test.ts`                                                                     | Phone on mobile data, router off                            |
| S14 | Unacknowledged alert escalates       | `notifications.int.test.ts` ([NTF-002] [NTF-005])                                                 | Ignore a table-tablet request on the floor                  |

Before the run, `pnpm check`, `pnpm trace --strict` and the Playwright suites must pass on the
release candidate.

## 2. Role scripts

Each person performs their role's tasks from the manual in `docs/manuals/` with an observer who
helps only when asked. Record: pass or fail, time taken, the observer's note.

| ID   | Who          | Task                                                                                | Pass when                                         |
| ---- | ------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------- |
| U-01 | Cashier      | Sign in, open the shift, take a dine-in order, print the bill, settle it            | Invoice numbers are gap-free, the Z-report ties   |
| U-02 | Waiter       | Sign in on the phone, open a table, order, send KOT, move the table                 | KOT reaches the right station once                |
| U-03 | Kitchen      | Receive tickets on the KDS, bump, recall, Notify manager                            | Pager vibrates, waiter app shows Ready            |
| U-04 | Manager      | Approve a tablet order, give a discount over the limit, void after print            | Each action is in the audit log with its approver |
| U-05 | Manager      | Assign sections, add a staff member, pair a device                                  | Assignment and device show live                   |
| U-06 | Owner        | Change a tax group, read the Z-report, export a report                              | Export carries a stamp and is audited             |
| U-07 | Owner        | Day-end and a backup                                                                | Backup passes its integrity check                 |
| U-08 | Manager      | Run the first-run wizard and import the menu from the template                      | Done in one business day (ONB-009)                |
| U-09 | Diner        | Place a first order on the tablet unaided                                           | Within 2 minutes (TAB-016)                        |
| U-10 | Diner        | Order from the QR menu                                                              | Order arrives for approval                        |
| U-11 | Manager      | Read the dashboard in a rush: late dishes, alerts, pagers                           | Finds each in under 30 seconds                    |
| U-12 | Vendor staff | Remote onboarding or support through a screen-sharing session the restaurant starts | No access without the session (ONB-008, UPD-009)  |

## 3. Results

Copy this table for each run. A scenario passes only if both columns pass. Any Sev-1 or Sev-2
defect (BRD §18.3) blocks the pilot.

| ID  | Date | Build | Result | Defect IDs | Signed by |
| --- | ---- | ----- | ------ | ---------- | --------- |
|     |      |       |        |            |           |
