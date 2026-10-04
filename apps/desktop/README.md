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

Settings: the server's port and the data folder (whose `tls/ca.crt` is the CA) come from the
installation file the installer writes (`%ProgramData%\RestaurantPlatform\installation.json`, or
`RP_INSTALLATION_FILE`). The environment overrides them: `RP_SHELL_URL` (or `RP_SHELL_PORT`),
`RP_DATA_DIR` or `RP_SHELL_CA_FILE`. `RP_SHELL_FULLSCREEN=1` is for a touch POS, and
`RP_SHELL_OPEN_AT_LOGIN=0` keeps it from starting with Windows.

## The Windows installer (P0-16d)

`src/packaging/` builds the restaurant PC's installer; it is not part of the app.

- `stage.ts` (`pnpm --filter @rp/desktop package:stage`, after `pnpm build`) fills `staging/`:
  - `app/`: the shell bundled with esbuild into one `main.js`, so app.asar has no node_modules;
  - `payload/`: the server (`pnpm deploy` with a hoisted layout, trimmed to what it loads, with its
    third-party notices), the console, Node.js, PostgreSQL 16, WinSW and the set-up scripts;
  - `installer-defines.nsh`: the build's settings for the NSIS script.

  Node.js, PostgreSQL and WinSW are pinned by SHA-256 in `components.ts`. The step checks the
  payload against the server's own layout and loads the server's programs and native modules.

- `package-cli.ts` (`pnpm --filter @rp/desktop package:win`) runs electron-builder with
  `builder-config.ts`: NSIS, per machine, Electron's fuses (SEC-011), signed when `WIN_CSC_LINK`
  is set. The result is `release/RestaurantPlatform-Setup-<version>.exe`.
- `installer/installer.nsh` hooks into electron-builder's NSIS script: the data-drive page
  (ONB-002), stopping the services before files are replaced, the set-up scripts on install,
  repair, update and uninstall.

Stage on Windows: the server's native modules are installed for the system the step runs on. The
CI job "Windows installer" builds, installs and checks it on `windows-latest`.
`docs/runbooks/windows-installer.md` describes the installer; manual task 14 is the check on a
clean PC.

`pnpm --filter @rp/desktop test` runs the shell's logic without Electron: `startShell` takes
Electron's objects as arguments. `pnpm --filter @rp/desktop start` opens it on a development
machine. That needs Electron's binary, which pnpm does not download (see `onlyBuiltDependencies`);
run `node node_modules/electron/install.js` once first. The packaging's pure parts are tested in
`test/packaging.test.ts`.
