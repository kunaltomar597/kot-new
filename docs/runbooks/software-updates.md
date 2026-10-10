# Software updates on the restaurant PC

How a new version reaches the restaurant PC and installs itself safely (UPD-004, UPD-005, UPD-007,
P7-04c). Publishing releases and staged rollouts are the Control Plane's (`control-plane.md`,
"Releases"); this runbook covers the PC.

## In short

1. The Control Plane offers a release with each heartbeat answer (P0-17b, P7-04a): version, HTTPS
   address, SHA-256, size, and whether it is security-critical.
2. The server's **update agent** downloads it in the background, over HTTPS only, to
   `<data>\updates\RestaurantPlatform-Setup-<version>.exe`, and checks its size, SHA-256 and
   Authenticode signature.
3. It waits for the **maintenance window** (`updates.maintenanceWindow`, 03:00-06:00 by default)
   or a manager's **Install now** on the System page. It never installs while a table is open,
   unless the release is security-critical and a manager pressed Install now.
4. It makes a **full backup** (kind "Before an update" in the backups list), checked end to end,
   and checks that no migration was left half done (the integrity check).
5. It reports `INSTALLING` to the vendor and leaves `<data>\run\update-request.json`.
6. The **watchdog** (LocalSystem) sees the request and starts the updater's scheduled task
   `\RestaurantPlatform\Update`, which runs `Update-RestaurantPlatform.ps1` as SYSTEM.
7. The **updater** checks the installer again, stops the server, copies the database, runs the
   installer silently and checks the new version's health. When the check fails, it goes back to
   the previous version **and its database**.
8. It writes `%ProgramData%\RestaurantPlatform\update-outcome.json`. The server records it,
   audits it and reports it to the vendor with its next heartbeat: `INSTALLED`, `ROLLED_BACK` or
   `FAILED`.

The System page (Manage → System → Updates) shows each step: downloading, downloaded and checked,
waiting for the window or for open tables, backing up, installing, and how the last update went.

## Who does what, and why

The server runs as `NT SERVICE\RPServer`, which cannot install software. Installing needs an
administrator, and the installer stops every service, so it cannot run inside one of them. The
watchdog runs as LocalSystem and may start the scheduled task, which runs as SYSTEM outside every
service.

The updater trusts nothing the server's account wrote:

- The request must be well formed: a version, an installer named after that version, a SHA-256.
- The version must be newer than the installed one. The updater never installs an older version,
  except the one it goes back to.
- The installer is copied to `%ProgramData%\RestaurantPlatform\installers` and checked there.
  Only administrators and SYSTEM may write or read that folder. The SHA-256 must match. The
  Authenticode signature must be valid and its signer must be the publisher this installation
  names (the installation file's `updates.publisher`). Only then does it run, from that copy.
- It never writes or deletes anything in the data folder. The server's account could replace a
  folder there with a link to somewhere else and so steer what SYSTEM writes. The updater only
  reads there: the request, the downloaded installer, and the service host's rollback outcome.
  It writes its outcome and its rollback request in `%ProgramData%\RestaurantPlatform`, which
  administrators write and the server reads.
- Each request runs once. Its id goes into `updater\taken.json`, and the outcome says `RUNNING`
  until the end. If the watchdog starts the task again for a request the server still holds,
  nothing happens. If a run was cut short (the PC restarted), the next start ends it as `FAILED`.

The updater's scripts live in `%ProgramData%\RestaurantPlatform\updater`, which only
administrators and SYSTEM may read. Each install or repair copies them there, closes both folders
and registers the task again.

The watchdog starts the task once for each request. If the updater has not taken the request two
minutes later (the task did not start, or an instance still running ignored the start), the
watchdog starts it again.

## Signing (UPD-007)

The installer's build names the signer every update must carry:

| Build variable                | Meaning                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| `RP_UPDATE_PUBLISHER`         | The code-signing certificate's subject, e.g. `CN=..., O=..., L=..., C=IN`. Set it with the certificate. |
| `RP_ALLOW_UNSIGNED_UPDATES=1` | Test builds only: unsigned updates are accepted. Refused together with a publisher.                     |

In CI they come from the repository variable `RP_UPDATE_PUBLISHER`, on pushes to `main` only.
While it is unset, and on every other branch and pull request, CI builds are unsigned test builds
that accept unsigned updates; only `main` reaches the certificate, in the environment
`release-signing` (SEC-013, `manual-tasks/01-github-access.md`). **Never install an unsigned build at a
restaurant**: each heartbeat says the PC takes unsigned updates, and the vendor's fleet shows it as
an alert until a signed build replaces it (`docs/runbooks/control-plane.md`).

The release guard (`apps/desktop/src/packaging/release-guard.ts`) refuses a build signed with the
certificate (`WIN_CSC_LINK`, or `CSC_LINK` when that is unset) that has no `RP_UPDATE_PUBLISHER`,
allows unsigned updates, was staged off Windows, or whose staged server has no vendor licence key
(manual task 23) or no pager firmware key digest (manual task 30).

An installation with neither (for example, installed by hand from a build without a certificate)
shows "Updates are unavailable here" on the System page. Install updates on it by hand.

The certificate's subject is in its details (`certutil -dump <file>.p12`, "Subject:"). It must
match exactly, so renew the certificate with the same subject. If the subject changes, release one
version signed with the old certificate whose build names the new subject first.

## What can go wrong

| What the System page or the vendor sees                  | What it means and what to do                                                                                                                                                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "The download failed ... tried again at ..."             | No internet, or the file does not match the release (SHA-256, size, signature, or the installer is another version than the release says). It waits 5 minutes, then twice as long each time, up to 6 hours.              |
| "The update waits: the backup before the update failed"  | Fix the backup (`backups.md`); the update tries again 30 minutes later.                                                                                                                                                  |
| "... a migration was left half done"                     | The database needs support before any update. Restore the last backup or ask support.                                                                                                                                    |
| `FAILED`, "The updater did not start"                    | The watchdog did not start the task within 10 minutes. Check that `RPWatchdog` runs and the task exists (`schtasks /Query /TN \RestaurantPlatform\Update`). Run the installer's repair.                                  |
| `FAILED`, "... Nothing was changed"                      | The updater refused before stopping anything: wrong hash or signature, an older version, an installer whose product version is not the one asked for, or the installed version's installer is missing from `installers`. |
| `ROLLED_BACK`                                            | The new version failed its health check. The previous version runs again with the database from just before the update. The release is not tried again by itself; "Install now" tries again.                             |
| `FAILED`, "... Going back ... failed too. Call support." | See "When going back fails" below.                                                                                                                                                                                       |

The vendor sees every `ROLLED_BACK` and `FAILED` as a fleet alert. Repeated failures halt the
rollout automatically (P7-04a).

## The health check

After the installer ends, `setup-cli health` must report `RUNNING` with the new version, and the
server must answer its health check over TLS. It must then stay so for 2 minutes: the same server
process, with no restart. The updater waits up to 10 minutes for the first answer.

## Going back (UPD-005)

Before the installer runs, with the server stopped, the updater copies the restaurant's database
to `restaurant_before_update` (`setup-cli update-snapshot create`, a file copy inside PostgreSQL).
That copy holds everything up to the moment the server stopped, so going back loses nothing
written before the update. When the new version is healthy, the copy is dropped.

When the new version fails:

1. The updater writes `%ProgramData%\RestaurantPlatform\update-rollback.json`, with the request's
   id.
2. It runs the previous version's installer from `installers`, silently. That installer replaces
   the files, and runs the previous version's set-up (repair).
3. Before the previous version's server starts, its service host swaps the databases. The copy
   becomes `restaurant` again. The database the failed version used is kept as
   `restaurant_failed_update` (one at a time; the next rollback replaces it). The service host
   cannot remove the request, so it notes the id in `<data>\backups\update-rollback-outcome.json`
   and never runs the same request twice.
4. The updater checks the previous version's health and that the service host ran this request,
   removes the rollback request, then reports `ROLLED_BACK`.

Anything the failed version wrote is in `restaurant_failed_update`, not in the restaurant's
database: orders taken in the minutes the new version ran before it failed its check. Support can
read them there (`psql` as `rp_admin`) and enter them again. The full backup made before the
update is in the backups list too.

### When going back fails

The outcome says why. The log is in `%ProgramData%\RestaurantPlatform\setup-logs\update-<time>.log`.

- **The previous installer failed.** Run `%ProgramData%\RestaurantPlatform\installers\RestaurantPlatform-Setup-<previous>.exe`
  by hand as an administrator. The updater removed its rollback request, so the database is not
  switched back by itself: if the restaurant needs the database from before the update, restore
  the backup made before it (`backups.md`, "Restoring"), or ask support to swap
  `restaurant_before_update` back in.
- **"runs, but on the database the update changed".** The previous version runs on the newer
  database. If it works, wait for a fixed release. If not, restore the backup made before the
  update (`backups.md`, "Restoring").

## The POS window during an update

The installer closes the POS window on the restaurant PC while it replaces the files. After an
update in the maintenance window, it opens again at the next sign-in. After "Install now" during
service, start it from the Start menu. Phones, tablets and the KDS reconnect by themselves.

## Files

| File                                                    | Written by                              | Read by                                  |
| ------------------------------------------------------- | --------------------------------------- | ---------------------------------------- |
| `<data>\updates\RestaurantPlatform-Setup-<v>.exe`       | the server (download)                   | the updater (copies it)                  |
| `<data>\run\update-request.json`                        | the server (removes it when done)       | the watchdog, the updater                |
| `%ProgramData%\RestaurantPlatform\update-outcome.json`  | the updater (`RUNNING`, then how)       | the server, the watchdog                 |
| `%ProgramData%\RestaurantPlatform\update-rollback.json` | the updater                             | the service host                         |
| `<data>\backups\update-rollback-outcome.json`           | the service host                        | the updater                              |
| `%ProgramData%\RestaurantPlatform\updater\*`            | the installer; `taken.json` the updater | the scheduled task (administrators only) |
| `%ProgramData%\RestaurantPlatform\installers\*.exe`     | the installer (itself), the updater     | the updater (administrators only)        |

The server keeps its own state in `system_meta` (`updates.agent`, `updates.report`). The report
rides on every heartbeat until one is answered.

## Tests

- Server: `test/unit/updates.test.ts` (download, signature, hand-off files, the watchdog's
  trigger), `test/integration/update-agent.int.test.ts` (the agent with real backups),
  `test/integration/installation-database.int.test.ts` (the database copy and the switch back on a
  real cluster), and `control-plane.int.test.ts` (the report reaches the Control Plane).
- The updater: `infra/installer/windows/tests/SoftwareUpdate.Tests.ps1` (`pnpm installer:test`).
- **Scenario S9** in the CI job "Windows installer"
  (`infra/installer/windows/ci/Test-Update.ps1`). It installs a version and asks for an update
  to the next one with a forced failed health check. It checks that the first version runs again
  with the database from before. Then it updates for real through the watchdog and the task.
