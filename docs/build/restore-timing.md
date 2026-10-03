# Backup and restore timing (DATA-004, P7-05b)

The BRD's targets:

- RTO ≤ 2 hours, once the replacement hardware is there.
- RPO ≤ 1 hour with local backups (P7-05c adds the WAL archiving for this). With the nightly
  backup alone, the RPO is up to 24 hours; that is also the cloud-only RPO.

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
