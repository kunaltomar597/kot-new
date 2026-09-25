# apps/desktop: Electron shell (C4) and installer config (C12)

Electron window that opens the console from the local server on the restaurant PC. Hardened per
SEC-011 (contextIsolation, no nodeIntegration, sandbox, CSP, fuses, IPC allow-list). Packaged with
electron-builder (NSIS) together with the server, PostgreSQL and the watchdog (see
`infra/installer`). Updates via electron-updater from the Control Plane channel.

Built by: P0-16, P7-04. Not started yet. Builds run on the `windows-latest` CI runner.
