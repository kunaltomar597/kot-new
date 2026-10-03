# Data lifecycle

How long the restaurant PC keeps each kind of data (BRD §9.3), and how it is removed. The
automatic retention is P7-06a; archive-then-purge of business records (DATA-008) is P7-06b.

## What is kept, and for how long

| Data                                                         | Kept                                              | How it goes                                              |
| ------------------------------------------------------------ | ------------------------------------------------- | -------------------------------------------------------- |
| Orders, bills, invoices, payments, cash, day ends, audit log | At least the statutory period (72 months, §12)    | Only archive-then-purge, by the Owner (DATA-008)         |
| Alerts (cleared or acknowledged), closed service calls       | `retention.operationalDays` (90 days)             | Daily, automatically                                     |
| Kitchen print notices (printed or failed), idempotency keys  | 90 days                                           | Daily, automatically                                     |
| The server's log files (`<RP_DATA_DIR>\logs`)                | 90 days                                           | Daily, automatically                                     |
| Restore leftovers, downloaded cloud backups                  | A day (leftover folders), 90 days (downloads)     | Daily, automatically                                     |
| Event outbox and inbox                                       | Until every device has caught up                  | The event bus prunes them itself                         |
| Menu photos                                                  | While in use, then 90 days                        | The photo store prunes them itself                       |
| A diner's phone number and consent                           | `retention.dinerContactMonths` (24) after a visit | Anonymised daily; or erased on request (DATA-011)        |
| Feedback                                                     | Comments `retention.feedbackMonths` (24)          | The comment and the diner link are removed; ratings stay |

The settings are in Settings, "Keeping data" (the Owner only).

## The daily run (P7-06a)

Ten minutes after the server starts, then every day, the retention:

1. for each restaurant, in one transaction:
   - removes cleared or acknowledged alerts older than the operational period, except one a
     service call still points at;
   - removes closed service calls, printed or failed print notices and expired idempotency
     records older than it;
   - anonymises the phone number of each diner whose last visit (the consent, or their latest
     feedback) is older than `retention.dinerContactMonths`;
   - removes the comment and the diner link from feedback older than `retention.feedbackMonths`,
     keeping its ratings for the reports;
   - writes `RETENTION_APPLIED` to the audit log with the counts, when anything changed;
2. removes log files and downloaded cloud backups older than the operational period, and restore
   or recovery work folders older than a day.

The System page's "Data drive" section says when it last ran and how many items it removed.

The application's database role may delete only these operational rows. Orders, bills,
payments and the audit log stay protected from it (AUD-004).
