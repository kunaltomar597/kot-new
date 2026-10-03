# Backups

How the restaurant PC backs itself up (DATA-002, DATA-005, SEC-007) and how a backup is restored
(DATA-004): the nightly full backup (P7-05a), restore (P7-05b) and the continuous backup with
restore to a moment (P7-05c). The cloud copy (P7-05d) will add its section.

## What a backup holds

Each backup is one encrypted file, for example `rp-backup-20261003T230000Z-nightly.rpbk`. The time
in the name is UTC. Inside it are:

- `backup.json`: the time it was made, the server version, the last database migration, the
  PostgreSQL version and the restaurant names;
- `database.dump`: the whole database, from `pg_dump --format=custom --no-owner`, with its grants;
- `secrets.json`: the local secrets the data needs on a new PC:
  - the PIN pepper;
  - the token, device and TOTP keys;
  - the TLS key encryption key;
  - the installation key;
  - the relay and licence keys.

  The backup key itself is never inside a backup.

- `files/photos/...`: the menu photos;
- `files/tls/...`: the LAN certificate authority and server certificate (still encrypted with their
  key);
- `manifest.json`: the size and SHA-256 of every other entry.

The file is encrypted with AES-256-GCM in 1 MiB chunks:

- Each file gets its own key, derived from the backup key with a random salt (HKDF-SHA256).
- Every chunk authenticates the file's header, the chunk's position and whether it is the last one.

So a changed byte, a swapped chunk, a cut-off file or the wrong key is detected before anything is
used. The header shows, without the key, what the file is, when it was made and which key opens
it. That key is the `keyId` on the System page.

The backup key is a local secret (`backup-key`). The installation makes it on first use: a file
under `<RP_DATA_DIR>/secrets` in development, the Windows DPAPI store on the restaurant PC (P0-16).
Without that key, a backup cannot be read. P7-05d escrows a copy with the vendor for a restore on a
new PC.

## When and where

- **Nightly**:
  - Runs at `backups.nightlyAt`, 04:30 India time by default, after the 04:00 business-day
    cut-off.
  - A PC that was off then backs up when it starts.
  - A failed nightly backup is tried again an hour later.
- **Back up now**: on the System page, for anyone who manages the restaurant's set-up. The request
  is audited.
- **Data drive**: `<RP_DATA_DIR>/backups/full/`.
- **Second location**:
  - Set it as `backups.secondLocation` in Settings (Owner only): a folder on a second disk, USB
    drive or NAS.
  - Backups go into its `rp-backups` subfolder.
  - Without one, a disk failure loses the backups too, so the System page asks for one.
- **Retention**:
  - Each location keeps the newest backup of each of the last `backups.keepDaily` days (14), and
    the newest of each of the last `backups.keepWeekly` weeks (8). The newest backup is always
    kept.
  - Partial files older than a day, left by a crash, are removed.

## How each backup is checked

1. The database is streamed into the encrypted file, through `<name>.partial` on the data drive.
2. The file is synced to disk, then read back in full:
   - every chunk must decrypt and authenticate;
   - every entry must match the manifest;
   - `pg_restore --list` must read the dump.
3. Only then does it get its name.
4. It is copied to the second location as `.partial`, checked there the same way, then named.

The outcome is kept in the `backup_runs` table. It also goes to the audit log as
`BACKUP_COMPLETED` or `BACKUP_FAILED` (and `BACKUP_REQUESTED` for "Back up now").

| Result      | Meaning                                                              |
| ----------- | -------------------------------------------------------------------- |
| `SUCCEEDED` | Checked on the data drive, and at the second location if one is set. |
| `PARTIAL`   | Checked on the data drive; the copy to the second location failed.   |
| `FAILED`    | No usable backup was made (the reason is shown).                     |

A backup still marked as running when the server starts was cut off by a crash or power cut, so it
is marked failed.

## Failures (DATA-005)

A `PARTIAL` or `FAILED` backup:

- raises a `DISK_OR_BACKUP` alert for the Owner and managers (repeated daily) until a backup
  succeeds;
- shows on the System page (`The last backup failed`, with the reason);
- is reported in the next heartbeat (`backup.lastFailureAt`, `lastError`). The vendor's fleet
  view then opens a backup alert (P7-03).

No successful backup for 26 hours shows as overdue.

Common causes:

| Reason shown                                                  | What to do                                                                                                            |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `The copy to the second location failed: ... ENOENT / EACCES` | Connect the USB drive or NAS, or check the folder in Settings. The service account needs write access to it.          |
| `pg_dump failed ... could not connect`                        | PostgreSQL is not running; see the server's health page and Windows services.                                         |
| `spawn pg_dump ENOENT`                                        | The PostgreSQL client programs are not found: set `RP_PG_BIN` to PostgreSQL's `bin` folder (the installer does this). |
| `ENOSPC`                                                      | The disk is full: see Storage on the System page (DATA-006).                                                          |

## Configuration (installer, P0-16)

- `RP_PG_BIN`: the folder with `pg_dump.exe` and `pg_restore.exe` (PostgreSQL 16), e.g.
  `C:\Program Files\PostgreSQL\16\bin`. Unset, they are looked up on the PATH.
- `RP_BACKUPS=off`: turns the nightly backup off, for development and the end-to-end tests where
  `pg_dump` may be missing. Refused in production. "Back up now" still works.
- `RP_ADMIN_DATABASE_URL`: a role that may create, rename and drop databases, used by the
  restore tool. The server needs it only to run a requested restore itself. Leave it unset for the
  server and let the Windows service run `restore-cli pending` before starting it, so the everyday
  server never holds the administrator's password.
- The Windows service restarts the server when it exits with code 75 (a restore was asked for).
- The DPAPI store must support `replace` (writing a backup's secrets during a restore), as
  `FileSecretStore` does.
- The database role in `DATABASE_URL` must be able to read every table (`pg_dump`). The password
  goes to `pg_dump` through its environment, never its command line.
- The DPAPI secret store must provide `backup-key` (32 random bytes, made at installation).
- `RP_BACKUP_DATABASE_URL`: the continuous backup's role (see "The continuous backup").

## The recovery key

A backup can only be read with the backup key of the PC that made it. The key stays on that PC,
in the DPAPI store. If the PC is lost, the backups on the USB drive or NAS need the key from
somewhere else:

- **The Owner's recovery key.** On the System page, "Show the recovery key" (Owner only, with a
  fresh second factor, audited as `BACKUP_RECOVERY_KEY_SHOWN`) shows the key written out, like
  `RPK1-ABCDE-...`, in 11 groups. The Owner writes it down and keeps it away from the PC. The last
  two bytes are a check, so a mistyped character is caught before a backup is tried.
- **The vendor's escrowed copy** (P7-05d), released for a restore once the Owner is verified.

## The continuous backup (P7-05c)

The nightly backup alone can lose up to a day. The continuous backup keeps the most a restore can
lose to minutes while the data drive survives (RPO ≤ 1 hour, DATA-004), and to what had reached the
second location when the data drive dies.

How it works:

1. PostgreSQL archives its write-ahead log (WAL) as it fills each 16 MB piece. Its
   `archive_command` is `wal-stage`, which copies the piece into
   `<RP_DATA_DIR>/backups/wal-staging/<system id>/`. That step needs no key, no database and no
   second drive, so an unplugged USB drive never stops PostgreSQL or fills the data drive.
2. Every 30 seconds the server:
   - compresses and encrypts each staged piece (kind WAL, the same format as a backup) into
     `<RP_DATA_DIR>/backups/wal/<system id>/`, reads it back and compares it, then removes it from
     staging;
   - copies the pieces the second location lacks to `<second location>/rp-backups/wal/<system id>/`,
     checked byte for byte;
   - closes the log every 5 minutes (`backups.walMode` CONTINUOUS) or every hour (HOURLY) with
     `pg_switch_wal()`, so a quiet restaurant's last orders are archived too. Nothing is archived
     while nothing changes.
3. Every night, at `backups.nightlyAt`, the server takes a base backup with
   `pg_basebackup --format=tar --wal-method=fetch`. It is compressed and encrypted on the way to
   disk (kind BASE), read back in full, then named `rp-base-<end>-<first WAL piece>.rpbase` under
   `backups/base/<system id>/`, and copied to the second location. A failed base backup is tried
   again an hour later.
4. Retention, in each place: the base backups of the last `backups.pointInTimeDays` days (2 by
   default) and the newest one before them, and the log from the oldest of those on. Older days are
   still covered by the nightly backups (14 daily, 8 weekly).

The system id is PostgreSQL's cluster identifier. It keeps the archives of two clusters apart: a
new PC numbers its log from the start again.

On the System page, Backups shows "Continuous backup on", "behind" (no base backup for a day, log
waiting, or pieces not yet at the second location) or "failing". Failing raises the same
`DISK_OR_BACKUP` alert as a failed backup (dedupe key `continuous-backup`) until it works again.

### Setting it up (installer, P0-16)

In `postgresql.conf` (then restart PostgreSQL):

```conf
wal_level = replica
archive_mode = on
archive_timeout = 3600          # a backstop while the server is stopped
archive_command = '"C:/Program Files/RestaurantPlatform/node/node.exe" "C:/Program Files/RestaurantPlatform/server/dist/backups/wal-stage.js" "%p" "%f" "D:/RestaurantData/backups/wal-staging"'
max_wal_senders = 4
```

In `pg_hba.conf`: `host replication rp_backup 127.0.0.1/32 scram-sha-256`. Then, as the
administrator:

```sql
CREATE ROLE rp_backup LOGIN REPLICATION PASSWORD '<random, kept by the installer>';
GRANT EXECUTE ON FUNCTION pg_switch_wal() TO rp_backup;
```

Give the server `RP_BACKUP_DATABASE_URL=postgresql://rp_backup:<password>@localhost:5432/postgres`.
Without it the continuous backup is off and the System page says so; the nightly backups still
run. The PostgreSQL service account needs write access to the staging folder, and the server's
account needs to read and delete there.

### Problems

| What the System page or the log says                            | What to do                                                                                                        |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `PostgreSQL cannot hand over its log (check wal-stage)`         | Read PostgreSQL's log for `archive command failed`: the node or script path, or the staging folder's rights.      |
| `... is archived already with different content`                | A staged piece clashes with the archive: move it out of `wal-staging` and tell support (it is never overwritten). |
| `The base backup failed: ... permission denied ... replication` | The `pg_hba.conf` line or the role's REPLICATION attribute is missing.                                            |
| `permission denied for function pg_switch_wal`                  | Run the `GRANT EXECUTE` above.                                                                                    |
| "behind", pieces not at the second location                     | Connect the USB drive or NAS: the server catches up by itself.                                                    |

## Restoring

A restore puts the whole restaurant back to the moment the backup was made: database, secrets,
photos and TLS files. Everything after that is lost, and devices paired since then must be paired
again. Every device does a full refresh when it reconnects, because the event stream starts again
(P0-12).

What the restore does, in order:

1. Checks the whole file: every chunk, the manifest and `pg_restore --list`. A damaged file, or the
   wrong key, stops it here.
2. Unpacks it into `<RP_DATA_DIR>/.restore-<time>` (removed afterwards).
3. Refuses while anything is connected to the database. Stop the server first.
4. Makes sure the roles `rp_owner`, `rp_app` and `rp_purge` exist.
5. Restores into a new database, `<name>_restoring`, owned by `rp_owner`, with
   `pg_restore --jobs=4`. The grants come with it (AUD-004). The default privileges are
   re-applied for `rp_owner`. The event stream id is removed, and a record is left for the server
   to audit.
6. Replaces the secrets with the backup's (not the backup key). The earlier ones are kept in
   `<RP_DATA_DIR>/secrets/before-restore-<time>/`.
7. Replaces `photos` and `tls`. The earlier folders are kept as `<folder>.before-restore-<time>`.
8. Swaps the databases by renaming them:
   - the database there before becomes `<name>_before_<time>`, and is kept to go back to;
   - it is dropped if it held no restaurant (a fresh install).

If step 6, 7 or 8 fails, the earlier steps are undone. If anything before step 6 fails, nothing has
changed. When the server next starts, it writes `BACKUP_RESTORED` to the audit log, naming the Owner
who asked for the restore.

### On the same PC, from the System page

1. The Owner opens System, then Backups, then "Restore from a backup…".
2. They pick the backup (from the data drive or the second location), give a reason and confirm.
   This needs the Owner with a fresh second factor; it is audited as `RESTORE_REQUESTED`.
3. The server checks that the file is there and opens with this PC's key. It saves the request in
   `<RP_DATA_DIR>/backups/restore-request.json`, then exits with code 75.
4. The Windows service runs `restore-cli pending` before it starts the server again (P0-16). A
   server given `RP_ADMIN_DATABASE_URL` does this itself when it starts.
5. The request is removed before the restore starts, so a failed restore is not tried again on
   every start.
6. The outcome goes to `restore-outcome.json` and shows on the System page.

### On a new PC

1. Install the software. Do not do the first run (no restaurant) or activate it with a new code,
   since the backup brings the installation's own identity. Then stop the server.
2. Ask the vendor to move the licence to the new PC (LIC-004). The restored installation key
   keeps the installation's identity.
3. Copy the backup file from the USB drive or NAS.
4. Run the restore tool with the Owner's recovery key:

   ```sh
   set RP_RECOVERY_KEY=RPK1-ABCDE-...        # or RP_RECOVERY_KEY_FILE=<file with the key>
   set RP_ADMIN_DATABASE_URL=postgresql://postgres:<password>@localhost:5432/postgres
   node dist\backups\restore-cli.js verify  D:\rp-backups\rp-backup-20261003T230000Z-nightly.rpbk
   node dist\backups\restore-cli.js restore D:\rp-backups\rp-backup-20261003T230000Z-nightly.rpbk
   ```

   `pnpm backup:restore restore <file>` does the same from `apps/server`.

5. Start the server. The staff sign in with their PINs as before, and paired devices reconnect.
   A device paired after the backup must be paired again.

### To a moment (P7-05c)

With the continuous backup on, the Owner can go back to the latest moment archived, or to any
minute since the oldest base backup kept ("Restore from a backup…", then "The latest moment" or "A
moment I choose", in India time). It needs the Owner with a fresh second factor and a reason, like
a file restore, and is audited (`RESTORE_REQUESTED` with the moment, then `BACKUP_RESTORED` with
`restoredTo`, the last change brought back).

What the restore tool does:

1. Picks the newest base backup that finished before the moment, from the data drive or the
   second location, and the log after it (the same cluster).
2. Unpacks it into `<RP_DATA_DIR>/.pitr-<time>/` and decrypts the log beside it.
3. Starts a temporary PostgreSQL there, on a free port on 127.0.0.1 only, which replays the log up
   to the moment and then stops (`recovery_target_time`, then `promote`). If the archive ends
   before the moment, it brings back everything archived and says so.
4. Dumps that database (`pg_dump`) and stops the temporary PostgreSQL.
5. Restores the dump exactly as a file restore does (steps 3 to 8 above), with the photos, TLS
   files and secrets of the nightly backup made before the moment.

Nothing on the PC changes before step 5. The temporary folder is removed at the end, whatever
happens.

From the command line (the server stopped), with the second location's folder when the data drive
is gone:

```sh
node dist\backups\restore-cli.js pitr latest E:\rp-backups
node dist\backups\restore-cli.js pitr 2026-10-03T14:30:00+05:30 E:\rp-backups
```

On a new PC, set `RP_RECOVERY_KEY` as for a file restore. The temporary PostgreSQL is reached as
the administrator role in `RP_ADMIN_DATABASE_URL`, by name: use the same administrator role name on
every PC (the installer does).

### Going back

The database as it was before is kept as `<name>_before_<time>`. To go back:

1. Stop the server.
2. Rename the databases back, as an administrator.
3. Restore the files from `secrets/before-restore-<time>/`, `photos.before-restore-<time>` and
   `tls.before-restore-<time>`.

Once the restore has been checked, drop the kept database and folders to free the space.

### Times

The measured times are in `docs/build/restore-timing.md`: 90 days at design capacity (1.3 GB)
restore in about 11 seconds, about 113 MB/s. A restore to a moment adds unpacking the base
backup, replaying the log and the dump. The RTO is two hours once the hardware is there. The
rehearsal before the pilot is `manual-tasks/25-restore-rehearsal.md`.

## Checking a backup by hand

From `apps/server` on the PC (this PC's key, or `RP_RECOVERY_KEY` for another PC's backup):

```sh
pnpm backup:restore verify <path-to-file.rpbk>
```

It says whether the backup is complete and unchanged, when it was made and for which restaurant.
