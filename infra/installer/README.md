# infra/installer: Windows installer, services and watchdog (C12)

What the signed Windows installer runs on the restaurant PC: the PowerShell that sets up the
bundled PostgreSQL 16 service on the chosen data drive (ONB-002), the server and watchdog services
(WinSW), folder permissions, firewall rules, repair and uninstall.

Built by P0-16, in parts:

- **P0-16b (done): what runs on the PC, and the set-up commands.** These live in the server, since
  they ship with it and are tested without Windows:
  - `apps/server/src/service/`: the service host (the program the `RPServer` service runs), the
    watchdog (`RPWatchdog`) and Windows service control through `sc.exe`;
  - `apps/server/src/installation/`: the installation file, `setup-cli` (secrets, `initdb` and
    PostgreSQL's settings, the database logins, migrations without the Prisma CLI, the WinSW
    definitions, the maintenance flag);
  - `apps/server/src/auth/`: the DPAPI secret store (`RP_SECRET_STORE=dpapi`).

  `docs/runbooks/windows-services.md` describes all of it.

- **P0-16c (done): `windows/`, the PowerShell set-up scripts** that run those commands in order and
  do what only Windows can: the data-drive choice (ONB-002), folder permissions, the services'
  accounts and recovery, firewall rules for the staff network (SEC-008), repair, and uninstall that
  keeps the data unless the Owner allowed deleting it (NFR-I02). Pester tests run on any PC
  (`pnpm installer:test`) and on `windows-latest` under Windows PowerShell 5.1 and PowerShell 7.
  `docs/runbooks/windows-installer.md` describes them.
- **P0-16d (done): packaging.** The installer is built in `apps/desktop` (`src/packaging/`,
  `installer/installer.nsh`): electron-builder's NSIS installer with the data-drive page, Node.js,
  the server, the console, PostgreSQL 16, WinSW and these scripts, and Electron's fuses. Before
  replacing files it runs `Stop-RestaurantPlatform.ps1`; if an update cannot go ahead,
  `Start-RestaurantPlatform.ps1`. The CI job "Windows installer" builds it on `windows-latest` and
  installs, repairs and uninstalls it there (`windows/ci/Test-Installer.ps1`). The person's check on
  a clean PC is manual task 14 (`manual-tasks/14-windows-installer.md`).
