# infra/installer: Windows installer, services and watchdog (C12)

Scripts and definitions for the signed Windows installer: bundled Node runtime and server build,
Windows service wrapper (WinSW), bundled PostgreSQL 16 service on the chosen data drive, watchdog,
firewall rules, DPAPI secret store, data-drive selection (ONB-002).

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
- **P0-16d: packaging** (electron-builder NSIS, bundling Node, the server, PostgreSQL and WinSW), the
  `windows-latest` workflow and the person's checklist on a clean PC (manual task 14).
