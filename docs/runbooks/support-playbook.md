# Support playbook

For vendor support answering a restaurant. First rule: **get service running, then find the
cause.** Never ask for the Owner's password, TOTP or recovery key. Never take a copy of customer
data except through the Control Plane's diagnostics or backups (`vendor-access-policy.md`).

## Triage

| Severity | Meaning                                  | First reply                     |
| -------- | ---------------------------------------- | ------------------------------- |
| 1        | Cannot take orders or bill               | 15 minutes, call the restaurant |
| 2        | Part broken (printer, pager, one device) | 2 hours                         |
| 3        | Question or small fault                  | next working day                |

Anything that looks like theft, a breach or tampering is an incident: stop and use
`docs/security/incident-response.md`.

## Paper fallback while the PC is down

Waiters write orders with table and time on numbered paper slips; the kitchen cooks from the
slips; the cashier bills on a manual bill book. After recovery a manager enters them as orders
and marks the paper bills in the notes, so invoice numbers stay gap-free. Never reuse a paper
number for a system invoice.

## Common problems

| Symptom                          | Check                                                                                                                            |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| A phone or tablet cannot connect | Same Wi-Fi as the PC, PC powered, CA installed, app version not too old (the app says). `lan-tls.md`, `client-compatibility.md`. |
| No alert on a waiter phone       | Phone battery and notification settings (`waiter-phone.md`).                                                                     |
| Kitchen ticket did not print     | Printing page: printer offline or paper out; the order is safe and prints when back.                                             |
| Pager silent                     | Pagers page: battery, last heartbeat, firmware (`pager-firmware.md`).                                                            |
| Table QR shows an error          | Relay status, table's code (`qr-relay.md`).                                                                                      |
| Sign-in locked                   | A manager unlocks the person on the Staff page; a device lock is cleared on the Devices page.                                    |
| Update stuck                     | System page reason; `software-updates.md`.                                                                                       |
| Backup failed alert              | `backups.md` → Failures.                                                                                                         |
| Licence warning                  | Licence page; `control-plane.md`.                                                                                                |
| Wrong bill                       | Bills are not edited after printing without approval; use void and reissue with a reason. The audit page shows who did what.     |

## Collecting information

Ask for: the restaurant name, time, what the person did, the screen's message and its
correlation id (shown in errors and in the log). Prefer a diagnostics bundle sent from the System
page over remote access. Remote access needs the Owner's agreement each time and is audited.

## Closing a ticket

Write what was wrong, what fixed it, whether it can recur and whether a bug or a doc change is
needed. Repeated problems become a change to the product or to these runbooks.
