# Backups

How the restaurant PC backs itself up (DATA-002, DATA-005, SEC-007). Restoring a backup is in
P7-05b, continuous WAL archiving in P7-05c and the cloud copy in P7-05d. Each will add its section
here.

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
- The database role in `DATABASE_URL` must be able to read every table (`pg_dump`). The password
  goes to `pg_dump` through its environment, never its command line.
- The DPAPI secret store must provide `backup-key` (32 random bytes, made at installation).

## Checking a backup by hand

From `apps/server` on the PC (or a copy of the server), with the backup key available:

```sh
node -e "
const { createReadStream } = require('node:fs');
import('./dist/backups/backup-contents.js').then(async ({ verifyBackupFile }) => {
  const { createSecretStore } = await import('./dist/auth/secret-store.js');
  const key = await createSecretStore({ dataDir: process.env.RP_DATA_DIR }).get('backup-key');
  const result = await verifyBackupFile(createReadStream(process.argv[1]), key,
    { pgBin: process.env.RP_PG_BIN, databaseUrl: process.env.DATABASE_URL });
  console.log(result.info, result.entries.length, 'entries');
});" <path-to-file.rpbk>
```

The restore tool (P7-05b) adds a proper `verify` command.
