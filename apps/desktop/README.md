# apps/desktop: Electron shell (C4)

The window on the restaurant PC that opens the console from its own server (P0-16a):

- **Hardened (SEC-011).** Context isolation and the sandbox, no Node.js, no preload and no IPC.
  It navigates only to the server on this PC and opens no other windows. Permissions are limited
  to notifications and the camera (for scanning a pager's QR code), for the console only.
- **The server's certificate.** The server on this PC uses the installation's own CA (ADR-0011),
  which Windows does not know. On a loopback address the shell trusts a certificate signed by
  that CA (the server's `ca.crt`) and refuses any other, so another program on the PC cannot pass
  as the server. Every other address, or no CA file, gets Chromium's normal checks.
- **Always there (NFR-A04).** It starts with Windows and shows a start-up page until the server
  answers. It opens the window again when it is closed, and reloads the page when it crashes.
  Only one shell runs per PC.
- **Updates.** The shell is installed and updated with the rest of the restaurant PC by the signed
  installer (P0-16d). The update agent on the server (P7-04c) runs that installer.

Settings, from the installer: `RP_SHELL_URL` (or `RP_SHELL_PORT`, default 8080),
`RP_DATA_DIR` (the CA is `<RP_DATA_DIR>/tls/ca.crt`) or `RP_SHELL_CA_FILE`,
`RP_SHELL_FULLSCREEN=1` for a touch POS, and `RP_SHELL_OPEN_AT_LOGIN=0` to not start with
Windows.

`pnpm --filter @rp/desktop test` runs the shell's logic without Electron: `startShell` takes
Electron's objects as arguments. `pnpm --filter @rp/desktop start` opens it on a development
machine. That needs Electron's binary, which pnpm does not download (see `onlyBuiltDependencies`);
run `node node_modules/electron/install.js` once first. Packaging (electron-builder, NSIS, fuses)
is P0-16d and runs on the `windows-latest` CI runner.
