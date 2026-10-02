# Onboarding timing notes (ONB-009)

ONB-009 asks that a restaurant with up to 150 dishes and 40 tables be fully operational within
one business day, with the menu imported in an hour at most. These notes record what the
software takes, measured, and what the people take, estimated. Update them after the pilot
onboarding (P8).

## Measured by the software (P7-07b)

The Playwright test `apps/console/e2e/first-run.e2e.ts` starts from an empty database. It creates
the restaurant and the Owner, the PC pairs itself, the Owner signs in with the new PIN, and the
Owner confirms the first set-up step:

| From an empty database to                | Time (2026-10-03, Apple M-series, local PostgreSQL) |
| ---------------------------------------- | --------------------------------------------------- |
| the Owner signed in on the restaurant PC | 0.4 s                                               |
| the first set-up step confirmed          | 0.5 s                                               |

The software is never the slow part: every step after this is someone typing, checking or
walking around the restaurant.

## Estimated for people, step by step

For a restaurant of 150 dishes, 40 tables, 8 staff, 2 kitchen stations, 6 waiter phones,
10 table tablets and 6 pagers, with the installer on site:

| Step (set-up page)       | Who                  | Estimate     | Notes                                                                                                                                                                                     |
| ------------------------ | -------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install and first run    | Installer            | 30 min       | Windows installer (P0-16), then the first run in the console.                                                                                                                             |
| 1. Restaurant details    | Owner                | 15 min       | Needs the GST and FSSAI certificates at hand.                                                                                                                                             |
| 2. Taxes                 | Owner, with their CA | 15 min       | Usually two or three tax groups.                                                                                                                                                          |
| 3. Invoices              | Owner                | 10 min       | Check the sample invoice, confirm.                                                                                                                                                        |
| 4. Owner and managers    | Owner                | 15 min       | Password, authenticator app, recovery codes; managers.                                                                                                                                    |
| 5. Floor                 | Manager              | 30 min       | 40 tables in sections; the drag-and-drop plan is optional.                                                                                                                                |
| 6. Stations and printers | Installer            | 30 min       | Printer discovery, a test print from each printer.                                                                                                                                        |
| 7. Menu                  | Manager              | 45 to 60 min | Excel template: about 20 min to fill from an existing menu plus a check. AI from photos: about 10 min to read and 30 to 40 min to check 150 dishes (ONB-006). Within the hour either way. |
| 8. Staff and PINs        | Manager              | 20 min       | 8 people, sections.                                                                                                                                                                       |
| 9. Devices               | Installer            | 60 min       | About 2 to 3 min a device (NFR: at most 5 min), 22 devices.                                                                                                                               |
| 10. QR table tents       | Manager              | 20 min       | Print, fold and place 40 tents.                                                                                                                                                           |
| 11. Go-live test         | Everyone             | 30 min       | One test order through every path (P7-07c), then void it.                                                                                                                                 |
| Training                 | Staff                | 2 to 3 h     | In parallel with steps 9 to 10 where possible.                                                                                                                                            |

The total is about 6 to 7 hours of work, within one business day with the installer on site. The
menu fits the one-hour target with either import.

## Still to measure at the pilot

- Real times per step with a non-technical manager (ONB-004).
- Device pairing at the restaurant's Wi-Fi strength.
- The AI menu reading time for the pilot's real menu photos.
