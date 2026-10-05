# Windows services on the restaurant PC

How the restaurant PC keeps its server running (ONB-001, NFR-A04, P0-16b): the three services, what
each does when something fails, the installation file, the secrets, the database logins and the
set-up tool the installer runs. The installer's own scripts (P0-16c, `windows-installer.md`) and
packaging (P0-16d) call what is described here.

## The services

| Service      | Runs                                                     | Account                       | Starts                      |
| ------------ | -------------------------------------------------------- | ----------------------------- | --------------------------- |
| `RPDatabase` | PostgreSQL 16, data in `<data>\postgres`                 | `NT AUTHORITY\NetworkService` | at boot (`pg_ctl register`) |
| `RPServer`   | the service host, which runs the server (`dist/main.js`) | `NT SERVICE\RPServer`         | at boot, after `RPDatabase` |
| `RPWatchdog` | the watchdog                                             | LocalSystem                   | at boot                     |

All three start before anyone signs in. The POS window (the Electron shell, P0-16a) starts when
someone signs in to Windows and waits until the server answers.

`RPServer` and `RPWatchdog` are WinSW 2 services: `<install>\services\RPServer.exe` with
`RPServer.xml` beside it (written by `setup-cli service-files`). Windows restarts either one 1, 2
and 5 seconds after it fails, and `RPDatabase` 5, 10 and 30 seconds after. WinSW installs a service
once and reads the XML at every start; repair sets the rest with `sc.exe` (`windows-installer.md`).

## What happens when something fails

| What fails                                    | What happens                                                                                                                                                | How fast                                          |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| The server process crashes                    | The service host starts it again.                                                                                                                           | 0.5 s, never more than 5 s                        |
| The server stops answering (hung)             | The service host ends it and starts it again.                                                                                                               | after 20 s without an answer (60 s after a start) |
| The server answers 503 (its database is down) | The watchdog starts `RPDatabase` if it is stopped; the server reconnects. If it is still 503 after two minutes, the host starts the server again.           | 5 s (watchdog), 2 min (host)                      |
| The service host itself crashes               | Windows restarts `RPServer`. The new host ends the server the old one left running, so the ports are free.                                                  | 1 s                                               |
| The service host is stuck                     | When it has not written its heartbeat for 45 s and the server does not answer, the watchdog stops `RPServer` (ending it if it will not stop) and starts it. | about a minute                                    |
| A service is stopped (by hand or a failure)   | The watchdog starts it again, unless the maintenance flag is set.                                                                                           | 5 s                                               |
| `RPServer` stuck starting or stopping         | The watchdog ends and restarts it after two minutes.                                                                                                        | 2 min                                             |

The watchdog never ends PostgreSQL: after a power cut it may take minutes to recover, and ending it
then would only make that longer. It never restarts a server that answers its health check.

To stop the services on purpose, set the maintenance flag first (below), or stop `RPWatchdog`
before the others.

The watchdog also starts the updater (P7-04c). When the server leaves an update request in
`<data>\run\update-request.json`, the watchdog starts the scheduled task
`\RestaurantPlatform\Update` once for that request; if the task cannot be started, it tries again
a minute later. The task runs as SYSTEM, outside every service, because the installer stops them
all (`software-updates.md`).

## Before the server starts

Each time `RPServer` starts, and each time the server asks for a restart (exit code 75, a restore
requested on the System page), the service host:

1. waits for PostgreSQL to accept connections (at boot it may still be starting);
2. after a failed update, switches back to the database copied before it, when the updater asked
   for it (`%ProgramData%\RestaurantPlatform\update-rollback.json`, P7-04c; once per request). The
   failed version's database is kept as `restaurant_failed_update`;
3. runs the restore asked for on the System page, if there is one, with the administrator's login
   (`restore-cli pending`). The server itself never gets that login;
4. applies the migrations that are pending, as `rp_migrator`;
5. starts the server.

If a migration fails, the migration is undone whole, the server is not started, and the host tries
again every 30 seconds. Its state file says why (`lastError`). Restore the last backup or ask
support.

## Where things are

| What                     | Where                                                        |
| ------------------------ | ------------------------------------------------------------ |
| The installation file    | `%ProgramData%\RestaurantPlatform\installation.json`         |
| The service host's state | `<data>\run\service-host.json`                               |
| The maintenance flag     | `<data>\run\maintenance.json`                                |
| Logs                     | `<data>\logs\RPServer.out.log`, `RPWatchdog.out.log`, ...    |
| PostgreSQL's log         | `<data>\postgres\log\postgresql-<day>.log` (a week of files) |
| Secrets                  | `<data>\secrets\<name>.dpapi`                                |

The installation file holds no secret: the folders, the product version, the ports and the vendor
services' addresses. Only administrators may change it.

The state file has the host's and the server's process IDs, what the host is doing
(`WAITING_FOR_DATABASE`, `RESTORING`, `MIGRATING`, `RUNNING`, `RESTARTING`, `STOPPING`, `STOPPED`),
a heartbeat written every 2 seconds, how often the server was started again and why it last
ended.

## Secrets

On the PC every local secret is 32 random bytes protected with Windows DPAPI (SEC-006,
`RP_SECRET_STORE=dpapi`), one file each under `<data>\secrets`. The protection uses the PC's own
DPAPI key, so the files are useless on another PC. The folder's permissions (P0-16c) let only
administrators and the server's account read them.

Besides the server's own secrets, the store holds the database logins' passwords
(`db-*-password`). Those are never in a backup: a restore on a new PC keeps that PC's logins.

## Database logins

| Login         | What it is for                                                              |
| ------------- | --------------------------------------------------------------------------- |
| `rp_admin`    | The cluster's superuser (from `initdb`): set-up and restore only.           |
| `rp_migrator` | Runs the migrations. Its sessions act as `rp_owner`, which owns the schema. |
| `rp_server`   | The server, a member of `rp_app`: no DELETE on financial or audit records.  |
| `rp_purger`   | Archive-then-purge only (`rp_purge`, DATA-008).                             |
| `rp_backup`   | The continuous backup: replication and `pg_switch_wal()` (P7-05c).          |

Passwords are SCRAM; PostgreSQL listens on `localhost` only, and `pg_hba.conf` allows nothing but
this PC. Only `rp_owner`, `rp_app` and `rp_purge` may connect to the restaurant's database.

## The set-up tool

The installer runs these in order; each can run again (repair) without losing data:

```text
node dist\installation\setup-cli.js write-installation --install-dir ... --data-dir ... --product-version ...
node dist\installation\setup-cli.js secrets
node dist\installation\setup-cli.js postgres-init        (initdb; settings; pg_hba.conf)
node dist\installation\setup-cli.js postgres-register    (the RPDatabase service)
   ... start RPDatabase ...
node dist\installation\setup-cli.js database             (logins and the database)
node dist\installation\setup-cli.js migrate
node dist\installation\setup-cli.js service-files        (RPServer.xml, RPWatchdog.xml)
```

`Install-RestaurantPlatform.ps1` runs them in this order, with the folders' permissions, the
services' accounts and recovery, and the firewall around them (`windows-installer.md`).

Other commands:

- `maintenance on --minutes 60 --reason "update 1.5.0"` and `maintenance off`: while on, the
  watchdog leaves the services alone. It always expires (at most 4 hours), so an installer that
  crashed cannot leave the server down.
- `status`: the service host's state and the maintenance flag, as JSON.
- `health`: the server's health check over TLS (trusting only the installation's CA) with the
  host's phase, server process and restarts, as JSON. Exit code 0 when the host runs the server and
  it answers ok. The updater's health check after an update (P7-04c).
- `update-snapshot create` and `update-snapshot drop`: the copy of the database the updater makes
  before an update (the server must be stopped; it checks that no migration was left half done and
  that the drive has room), and drops once the new version is healthy (`software-updates.md`).
- `write-installation --update-publisher <subject> --allow-unsigned-updates on|off`: the signer
  updates must carry (UPD-007); repair keeps the publisher when not given.
- `paths`: the folders, ports and service names, as JSON, for the set-up scripts.
- `data-deletion`: whether the Owner allowed the uninstaller to delete the data (exit code 0 when
  allowed, 3 when not; `windows-installer.md`).

`postgres-init` writes these settings into `postgresql.conf` between two marker lines (repair
replaces the block): `listen_addresses = 'localhost'`, the port, `timezone = 'UTC'`,
`wal_level = replica`, `archive_mode = on`, `archive_timeout = 3600`, the `archive_command` that
runs `wal-stage.js` into `<data>\backups\wal-staging`, `max_wal_senders = 4` and a week of daily
logs. `initdb` runs with `--data-checksums`, so a bad disk block is found when it is read.

## Checking a PC

1. `sc query RPDatabase`, `sc query RPServer`, `sc query RPWatchdog`: all `RUNNING`.
2. `node dist\installation\setup-cli.js status`: phase `RUNNING`, a heartbeat from the last few
   seconds, `lastError` null.
3. `https://localhost:<port>/api/v1/health` answers `{"status":"ok"}`.
4. End the server process in Task Manager (`node.exe`, the child of the service host): it is back
   within 10 seconds (`restarts` goes up by one).
