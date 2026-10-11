# Backup and restore timing (DATA-004, P7-05b, P7-05c)

The BRD's targets:

- RTO ≤ 2 hours, once the replacement hardware is there.
- RPO ≤ 1 hour with local backups: the continuous backup (P7-05c). With the nightly backup alone,
  the RPO is up to 24 hours; that is also the cloud-only RPO.

## Measured on 2026-10-03

The machine was the build Mac: Apple Silicon, NVMe SSD, PostgreSQL 16 and the EDB 16.10 client
programs. The data was made by `test/performance/restore.perf.test.ts`, which uses the reports
run's generator at design capacity: 2,000 orders a day, 100 tables, 1,000 dishes.

| Data                     | Database | Backup file | Backup (dump, encrypt, check, prune) | Restore (check, unpack, `pg_restore --jobs=4`, swap) |
| ------------------------ | -------- | ----------- | ------------------------------------ | ---------------------------------------------------- |
| 90 days (180,000 orders) | 1,261 MB | 233 MB      | 26 s                                 | 11 s (113 MB/s of database)                          |
| Integration test (tiny)  | < 20 MB  | < 1 MB      | < 1 s                                | 0.34 s                                               |

The same run without `--jobs` (in one transaction) took 19 s to restore. That is why the restore
runs in parallel into a separate database, which is dropped if anything fails.

## What it means for the restaurant PC

- The 5-year sizing target is 100 GB. At the rate above, it restores in about 15 minutes.
- The restaurant PC is slower: 4 cores, a SATA SSD (§11). Assume 3 to 4 times slower, which
  gives about an hour. That is inside the two-hour RTO.
- The rest of a recovery adds to that:
  - installing the software: about 15 minutes, see `docs/build/onboarding-timing.md`;
  - the vendor moving the licence;
  - copying the backup from the USB drive or NAS: about 1 minute per GB over USB 3.
- The rehearsal before the pilot (`manual-tasks/25-restore-rehearsal.md`) measures all of it on
  the real PC. Record its numbers here.

To run the measurement again (it takes a few minutes for 90 days):

```sh
cd apps/server
RP_PERF=1 RP_PERF_DAYS=90 pnpm exec vitest run --silent=false --project performance test/performance/restore.perf.test.ts
```

## Restore to a moment (P7-05c), measured on 2026-10-03

Same Mac. The data came from `test/performance/point-in-time.perf.test.ts`, at design capacity, on
a PostgreSQL cluster with WAL archiving on and `wal-stage` as its archive_command.

| Data                    | Database | Base backup file | Base backup | Restore to the latest moment (unpack, replay, dump, restore) |
| ----------------------- | -------- | ---------------- | ----------- | ------------------------------------------------------------ |
| 30 days (60,000 orders) | 429 MB   | 142 MB           | 3 s         | 13 s (33 MB/s of database)                                   |
| Integration test (tiny) | < 20 MB  | < 5 MB           | < 1 s       | 2.0 s                                                        |

The RPO, measured by `test/integration/continuous-backup.int.test.ts`: the PC was "lost" right
after a last change that had not been archived. Everything archived came back; the restore reached
the last archived change, 0.17 s before the loss. The change made after it was lost, as expected.
On the restaurant PC the RPO is set by `backups.walMode`:

- CONTINUOUS: the log is closed every 5 minutes and archived within 30 seconds, so at most about
  5.5 minutes are lost while the data drive survives;
- HOURLY: at most about an hour;
- the data drive lost: the same, plus whatever had not reached the second location yet (it is
  copied within 30 seconds while it is connected).

What it means for the restaurant PC:

- A restore to a moment runs at about a third of the speed of a file restore here, because it
  dumps the recovered database and restores it again. At 33 MB/s, 100 GB takes about 52 minutes on
  this Mac, and about 3 hours on a PC 3 to 4 times slower. That is over the two-hour RTO for the
  5-year sizing target, but within it up to about 60 GB.
- For a larger database, restore the nightly backup file (within the RTO, at the cost of the day's
  changes). Or let P0-16 switch PostgreSQL's data folder in place, which skips the dump and the
  restore (see PROGRESS, P0-16 notes).

To run the measurement again:

```sh
cd apps/server
RP_PERF=1 RP_PERF_DAYS=30 pnpm exec vitest run --silent=false --project performance test/performance/point-in-time.perf.test.ts
```
