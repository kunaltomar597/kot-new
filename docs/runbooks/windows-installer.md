# Installing, repairing and uninstalling on the restaurant PC

What the installer's PowerShell does on the restaurant PC (ONB-001, ONB-002, NFR-I01, NFR-I02,
SEC-008, P0-16c). The scripts are in `infra/installer/windows/`. The installer (P0-16d) copies the
software, then runs them as an administrator. Support can run them by hand too.
`windows-services.md` describes the services they set up and the set-up tool (`setup-cli`) they
drive.

## The scripts

| Script                             | What it does                                                                          | Exit codes                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------- |
| `Install-RestaurantPlatform.ps1`   | Installs, or repairs when the installation file exists already.                       | 0 done, 1 failed                             |
| `Uninstall-RestaurantPlatform.ps1` | Removes the services and firewall rules. Keeps the data unless `-DeleteData` (below). | 0 done, 1 failed, 3 deleting was not allowed |
| `Get-DataDriveChoice.ps1`          | Prints the drives and the default data drive as JSON, for the installer's drive page. | 0                                            |
| `RestaurantPlatform.Setup.psm1`    | The functions they call.                                                              |                                              |

They run on Windows PowerShell 5.1, which every Windows 10 and 11 PC has:

```text
powershell.exe -NoProfile -ExecutionPolicy Bypass -File Install-RestaurantPlatform.ps1 ^
  -InstallDir "C:\Program Files\Restaurant Platform" -ProductVersion 1.0.0 ^
  [-DataDir D:\RestaurantPlatform] [-StaffSubnet 192.168.10.0/24] [-Port 8080] [-MqttPort 8883] ^
  [-PgPort 5432] [-TlsHostnames pos.local] [-ControlPlaneUrl https://...] [-RelayUrl https://...] ^
  [-QrSiteUrl https://...] [-ErrorDsn https://...] [-MinFreeGB 20] [-LogFile ...]
```

Each run writes a log. An install or repair writes it to
`%ProgramData%\RestaurantPlatform\setup-logs\install-<time>.log`. An uninstall writes it to
`%TEMP%\RestaurantPlatform-uninstall-<time>.log`, because it may delete the ProgramData folder.

## The data drive (ONB-002)

`Get-DataDriveChoice.ps1` lists every drive and says whether it can hold the data and why not:

| Reason             | Meaning                                                              |
| ------------------ | -------------------------------------------------------------------- |
| `NETWORK`          | A network drive or an iSCSI disk.                                    |
| `REMOVABLE`        | A removable drive, or a USB, SD card, FireWire or virtual-file disk. |
| `NOT_A_DISK`       | A CD or DVD drive, a RAM disk or no media.                           |
| `FILE_SYSTEM`      | Not NTFS or ReFS: the folders' permissions need one of them.         |
| `TOO_LITTLE_SPACE` | Less free space than needed: 20 GB by default.                       |

The free space required is `onboarding.minFreeDiskGb`. The installer runs before the settings
exist, so it passes the catalogue's default, `-MinFreeGB 20`. GB are counted the way Windows
Explorer counts them (1024³ bytes).

The default drive is chosen in this order:

1. a drive that already holds the data (`<drive>:\RestaurantPlatform\postgres\PG_VERSION`), when
   installing again after an uninstall that kept it;
2. else the first drive that fits other than the system drive;
3. else the system drive, with the warning `SYSTEM_DRIVE`. The installer shows the warning and the
   log says a second disk is safer.

`NO_DRIVE` means nothing fits. The data folder is `<drive>:\RestaurantPlatform`. A folder given
with `-DataDir` must be on a drive that fits. It must not be the drive itself, and must not be in
Windows' own folders (Windows, Program Files, ProgramData, the user's profile).

## What install and repair do

When the installation file (`%ProgramData%\RestaurantPlatform\installation.json`) exists already,
the run is a repair. Repair keeps the data folder the file names and does not check the drive
again. It refuses another `-DataDir`, and stops when the data folder is not there (a removed drive,
a changed letter) rather than start an empty restaurant; both change nothing. Every step can run again without losing data. The steps:

1. The secrets folder and the installation file's folder get their permissions first, so a secret
   is never written where others could read it.
2. `setup-cli write-installation`. Repair keeps every value the run is not given.
3. `setup-cli maintenance on --minutes 60`: the watchdog leaves the services alone. Repair stops
   `RPWatchdog`, then `RPServer`.
4. `setup-cli secrets`. If the secrets were protected by another Windows installation, the run
   stops here and changes nothing (see "A PC set up again" below).
5. `setup-cli postgres-init` (`initdb` on a new PC). `initdb` drops the administrator's rights
   while it works. For that time only, the installer's own account may write the data folder.
6. Every folder gets its permissions (table below). This also takes back the installer's account.
7. `setup-cli postgres-register`, Windows' recovery for `RPDatabase`, and the database started.
   Then `setup-cli database` (the logins) and `setup-cli migrate`.
8. `setup-cli service-files`, then the `RPServer` and `RPWatchdog` services:
   - WinSW installs a service only once. Repair sets the service up again with `sc.exe`, and
     installs it again only if the software moved to another folder.
   - `RPServer` runs as its own account, `NT SERVICE\RPServer` (`sc.exe sidtype ... unrestricted`,
     `sc.exe config ... obj=`). It starts after `RPDatabase`.
   - `RPWatchdog` stays LocalSystem, so it can start and stop the other services.
   - Both start at boot. Windows restarts them 1, 2 and 5 seconds after a failure, also when they
     stop with an error (`failureflag`).
9. The firewall rules (below).
10. `RPServer` is started, and the run waits up to 3 minutes for `setup-cli status` to say
    `RUNNING`. If the server does not get there, the run fails with the host's last error. Then
    `RPWatchdog` is started.
11. `setup-cli maintenance off`. This runs even when a step failed. A failed repair leaves the
    server and watchdog stopped, and the log says why.

## Folder permissions

Accounts are named by SID, so Windows' language does not matter. `NT SERVICE\RPServer` is
computed from the service name. It is the SID `sc.exe showsid RPServer` prints, and permissions can
name it before the service exists.

| Folder                             | Inherits | Who                                                                                                    |
| ---------------------------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `<data>`                           | no       | SYSTEM, Administrators: full. `RPServer`: modify. Network Service: pass through and list this folder.  |
| `<data>\postgres`                  | no       | SYSTEM, Administrators, Network Service (PostgreSQL): full. `RPServer`: read.                          |
| `<data>\backups`                   | yes      | Network Service may also pass through and list it.                                                     |
| `<data>\backups\wal-staging`       | yes      | Network Service: modify. PostgreSQL hands its log files to the server here (P7-05c).                   |
| `<data>\secrets`                   | no       | SYSTEM, Administrators: full. `RPServer`: modify. Nobody else.                                         |
| `<data>\tls`                       | yes      | Users: read. The POS window, running as whoever signed in to Windows, reads `ca.crt`. Keys are sealed. |
| `%ProgramData%\RestaurantPlatform` | no       | SYSTEM, Administrators: full. Users and `RPServer`: read. The installation file holds no secret.       |

Every other folder in `<data>` inherits from `<data>`: photos, logs, run, backups, and the
working folders of restores and exports.

Each run sets each folder's own entries to exactly these. It removes any entry added by hand, such
as Everyone added to `secrets`.

## Firewall (SEC-008)

There are two inbound rules in the group "Restaurant Platform":

- `RP-Server-HTTPS`: TCP on the server's port, 8080 by default;
- `RP-Server-MQTT`: TCP on the pagers' port, 8883 by default.

Both rules apply only to `<install>\node\node.exe` and accept connections only from the staff
network. Give it with `-StaffSubnet 192.168.10.0/24` (several allowed, none wider than /8).
Without it, the rules accept the networks the PC is on (`LocalSubnet`). The rules apply on every
network profile, because Windows may call the restaurant's network "public". Repair replaces the
group. Nothing else is opened; the server needs no outbound rule.

The outbound allow-list of SEC-008 (vendor and relay domains only) is the router's job: the
Windows firewall cannot filter by domain name. The site-readiness checklist (P8-06) covers it.

## Uninstalling and the data (NFR-I02)

Uninstalling removes `RPWatchdog` first (or it would start the others again), then `RPServer`,
then `RPDatabase`, then the firewall group. The installer then removes the program files (P0-16d).

The data stays in `<data>`, and so does the installation file. Installing again finds the data
(the default drive is the one that holds it) and carries on: same database, same secrets, same
devices.

Deleting the data takes two people's steps:

1. The Owner allows it on the POS: **Manage → System → Removing the software → Allow deleting the
   data**, with a reason, their password and an authenticator code. This is recorded in the audit
   trail as `DATA_DELETION_ALLOWED`. The permission lasts 30 minutes.
2. Within those 30 minutes, the person uninstalling chooses to delete the data
   (`Uninstall-RestaurantPlatform.ps1 -DeleteData`).

The script asks `setup-cli data-deletion` first. Without the Owner's permission it changes nothing
and ends with exit code 3. With it, after removing the services, it deletes `<data>` and
`%ProgramData%\RestaurantPlatform`. Backups at the second location or in the cloud are not touched.
The script never deletes a whole drive or anything in Windows' own folders.

This protects the data from a mistake, or from someone without the Owner's secrets. A Windows
administrator could still delete the folder by hand. BitLocker on the data drive is on the
site-readiness checklist (SEC-007).

## A PC set up again with the data drive kept

If Windows was installed again, or the data drive was moved to another PC, the secrets in
`<data>\secrets` cannot be read: DPAPI ties them to the Windows installation that wrote them. The
install stops at step 4 with "protected by another Windows installation" and changes nothing.

What to do is a restore on a new PC (`backups.md`, "Restoring", "On a new PC"):

1. Install on a fresh data folder. Choose another drive, or move the old folder aside first.
2. Restore the latest backup with the Owner's recovery key.

Without the recovery key, the old folder's database cannot be opened by the new installation.

## Checking it on a PC

The person's checklist for a clean Windows 11 PC is manual task 14 (P0-16d). For the scripts
alone, an administrator can run:

1. `Get-DataDriveChoice.ps1`: the drives and the default, as JSON.
2. `Install-RestaurantPlatform.ps1 ...` with the packaged software. Then follow "Checking a PC" in
   `windows-services.md`.
3. `Get-NetFirewallRule -Group "Restaurant Platform" | Get-NetFirewallAddressFilter`: shows the
   staff network.
4. `icacls <data>\secrets`: shows only SYSTEM, Administrators and `NT SERVICE\RPServer`.
5. Run the install again: it repairs, and the server is back within a minute.
6. Uninstall without `-DeleteData`: the services are gone and the data is still there.

## Tests

`pnpm installer:test` runs the Pester tests and PSScriptAnalyzer. It needs PowerShell 7 (`pwsh`)
with Pester 5.7.1 and PSScriptAnalyzer 1.25.0 installed. Off Windows, the tests tagged `Windows`
are skipped. The CI job "Windows set-up scripts" runs everything on `windows-latest`, under both
Windows PowerShell 5.1 and PowerShell 7. The Windows-only tests there run icacls, the firewall and
`sc.exe` for real, on a temporary folder and a firewall group of their own.

The PSScriptAnalyzer settings check the shipped scripts against Windows PowerShell 5.1's syntax,
commands and types. The files must be ASCII: Windows PowerShell 5.1 reads a file without a byte
order mark in the PC's ANSI code page.
