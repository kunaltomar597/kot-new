# Threat model: The desktop shell

The Electron POS window on the restaurant PC (`apps/desktop`), which opens the console from the PC's
own server, and what it protects for the console it loads. Written in P8-03b (2026-10-10). P8-03d
reviews it against Electron's security checklist (SEC-011); the threats below planned for P8-03d
are what that review must close. Related: [the LAN and the local server](local-server-and-lan.md),
`docs/runbooks/windows-installer.md`.

## Scope

- The main process: the window, its web preferences, navigation and window-opening rules,
  permissions, the certificate rule for the PC's own address, start with Windows, one instance.
- The packaged app: Electron's fuses, `app.asar` and its integrity, the executable's signature.
- The console it loads, as far as the shell keeps it in a browser's sandbox: its device key, token
  and session, its CSP.

## Assets

- The console's device key (ECDSA P-256, not extractable, kept in IndexedDB), its device token and
  the signed-in person's session.
- The installation's CA, which the shell pins for the PC's own address.
- `app.asar` and the executable.
- The PC's camera (pager QR codes), and its other devices.

## Entry points

- The executable's command line and environment (`RP_SHELL_URL`, `RP_SHELL_CA_FILE`), and the
  installation file it reads.
- The console's pages, the keyboard and the application menu.
- Permission requests from the page; the TLS handshake with the server on the PC's own address.
- Windows' sign-in item that starts it.

## Trust boundaries

1. The sandboxed page ↔ the main process: no preload, no IPC.
2. The shell ↔ the server on the PC's own address, over TLS with the CA pinned.
3. This Windows user ↔ other users and administrators of the PC.

## Data flows

1. The shell waits for the server's health through its own session, then loads the console.
2. The console calls `/api` and opens its socket on the same origin.
3. The camera's video reaches the page when it scans a pager's QR code.

## Threats

### Spoofing

#### DESKTOP-S1 A fake server on the PC's own address

A program on the PC listens where the server should, and the POS window shows its page.

- Mitigation: the shell's certificate rule accepts on the PC's own address only a certificate
  issued by the installation's CA; the CA's folder is read-only to users. The pin decides even
  when Windows itself trusts the certificate (an antivirus program's root, for example).
- Code: `apps/desktop/src/security.ts` (`certificateVerdict`, `isIssuedBy`);
  `apps/desktop/src/shell.ts` (`setCertificateVerifyProc`).
- Tests: `apps/desktop/test/security.test.ts` "trusts the server on this PC by the installation’s
  CA, and nothing else", "lets the pin decide on this PC even when Windows trusts the
  certificate"; `apps/desktop/test/shell.test.ts` "applies the permission and certificate
  rules to its session"; `infra/installer/windows/tests/Permissions.Tests.ps1` "lets everyone
  signed in read the CA the POS window pins, and the installation file".
- Risk: likelihood Low, impact High: Medium.
- Status: Mitigated (P8-03d1: the pin decides, whatever Windows trusts).

#### DESKTOP-S2 A copied POS terminal

Someone copies the POS window's stored key and token to act as the PC's own terminal elsewhere.

- Mitigation: the key cannot be exported by script, and each device token needs a fresh challenge
  signed with it. Chromium keeps IndexedDB on the PC's disk, so the disk itself is the protection.
- Code: `packages/api-client/src/device-key.ts`; `apps/console/src/app/storage.ts`
  (`BrowserStorage`).
- Tests: `apps/console/test/console-controller.test.ts` "stores and reloads the non-extractable key
  pair, the device and the session"; `apps/server/test/integration/devices.int.test.ts` "needs a
  fresh challenge signed with the device key, used once".
- Risk: likelihood Low, impact Medium: Low.
- Status: Accepted: someone who can read the PC's disk has more than the terminal (PC-I5, PC-E2);
  unpairing the POS stops a copy at once.

### Tampering

#### DESKTOP-T1 A changed app or executable

Someone replaces `app.asar` or the executable, or runs Electron as plain Node.js.

- Mitigation: Electron's fuses turn off running as Node.js, `NODE_OPTIONS` and the inspector, and
  turn on `app.asar`'s integrity check and loading the app only from it; Program Files is writable
  by administrators only. The executable is unsigned until the code-signing certificate exists.
- Code: `apps/desktop/src/packaging/builder-config.ts` (`ELECTRON_FUSES`).
- Tests: `apps/desktop/test/packaging.test.ts` "no Node.js mode, options or debugger, and only its
  checked app.asar".
- Risk: likelihood Low, impact High: Medium.
- Status: Partly mitigated. Plan: manual task 31 by 2026-11-30: the signed executable and
  installer.

#### DESKTOP-T2 Remote content or new windows

A link, a redirect or a page's script takes the POS window to another site, or opens a new window.

- Mitigation: the window goes only to the console's exact origin; other navigations and every new
  window are refused; the console's CSP allows only its own origin.
- Code: `apps/desktop/src/security.ts` (`isAllowedNavigation`); `apps/desktop/src/shell.ts`.
- Tests: `apps/desktop/test/security.test.ts` "goes nowhere but the restaurant’s server";
  `apps/desktop/test/shell.test.ts` "reloads a crashed page, and keeps the console on its own
  server".
- Risk: likelihood Low, impact High: Medium.
- Status: Mitigated.

### Repudiation

#### DESKTOP-R1 A POS action nobody owns

Someone at the POS denies an action taken there.

- Mitigation: the server audits every action with the person and the device (PC-R1).
- Code: `apps/server/src/audit/audit.service.ts` (`AuditService`).
- Tests: `apps/server/test/integration/audit.int.test.ts` "records the server time, actor,
  approver, device, reason and correlation ID".
- Risk: likelihood Low, impact Low: Low.
- Status: Mitigated.

#### DESKTOP-R2 The shell's own events lost

A refused navigation, certificate or permission leaves no trace, because the shell writes its
events only to its standard output, which a window app does not keep.

- Mitigation: the shell writes each refusal, crash and reopened window to
  `<data folder>/logs/desktop-shell.log` (an address by its origin only, never a path or query),
  kept to 1 MB with the last 1 MB beside it; the diagnostics bundle reads that folder.
- Code: `apps/desktop/src/file-log.ts` (`fileLog`); `apps/desktop/src/main.ts`;
  `apps/desktop/src/config.ts` (`shellConfig`).
- Tests: `apps/desktop/test/file-log.test.ts` "appends one dated line per event, creating the
  folder"; `apps/desktop/test/shell.test.ts` "logs what it refuses, without paths".
- Risk: likelihood Low, impact Low: Low.
- Status: Mitigated (P8-03d1).

### Information disclosure

#### DESKTOP-I1 Script in the console reading its session

Injected script in the POS window reads the device token or the session.

- Mitigation: see PC-I4: the console's CSP allows only its own scripts and requires Trusted Types
  with no policy, so markup that got into the page runs no script; React escapes all text; the
  key cannot be exported, though script that did run could read the tokens.
- Code: `apps/server/src/http/console-static.ts` (`CONSOLE_SECURITY_HEADERS`);
  `apps/console/src/app/zod-jitless.ts`.
- Tests: `apps/server/test/integration/console-static.int.test.ts` "serves the app shell with strict
  security headers", "lets no string reach a script or HTML sink in the console (Trusted Types)";
  `apps/console/e2e/console.e2e.ts` "every screen ran within the CSP and Trusted Types (PC-I4)";
  `infra/dast/test/scan.test.ts` "leaves no finding open on the local server and the console".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated (P8-03c1: Trusted Types in the console's CSP).

#### DESKTOP-I2 The camera or the microphone

The page, or something it loads, turns on the PC's camera or microphone.

- Mitigation: the shell grants only notifications, video and writing to the clipboard, and only to
  the console's origin; never the microphone.
- Code: `apps/desktop/src/security.ts` (`isAllowedPermission`).
- Tests: `apps/desktop/test/security.test.ts` "gives the console the camera for QR codes, never the
  microphone", "allows notifications and the camera to the console, nothing else and nobody
  else".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

#### DESKTOP-I3 Developer tools in the POS window

Staff open the developer tools (Ctrl+Shift+I) or the default menu, and read the session or the
device token, or run their own script as the POS.

- Mitigation: the web preferences turn the developer tools off and the shell removes the
  application menu, so Ctrl+Shift+I and F12 do nothing.
- Code: `apps/desktop/src/security.ts` (`WEB_PREFERENCES`); `apps/desktop/src/main.ts`.
- Tests: `apps/desktop/test/security.test.ts` "runs the console with context isolation and the
  sandbox, and no Node.js", "has no developer tools, and finds the debugging switches";
  `apps/desktop/test/shell.test.ts` "has no application menu".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated (P8-03d1).

### Denial of service

#### DESKTOP-D1 A crash, a closed window or the server not up yet

The POS window crashes, is closed, or starts before the server, during service.

- Mitigation: the shell shows a start-up page until the server answers, reopens a closed window,
  reloads a crashed page, waits again when the console does not load, and runs once per PC.
- Code: `apps/desktop/src/shell.ts`; `apps/desktop/src/server-wait.ts`.
- Tests: `apps/desktop/test/shell.test.ts` "opens the window again when it is closed, but not when
  the shell quits", "waits for the server again when the console does not load", "runs once per
  PC: a second start quits".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

### Elevation of privilege

#### DESKTOP-E1 The page gaining Node.js

Script in the console reaches Node.js or the main process, and so the PC.

- Mitigation: context isolation and the sandbox on; Node.js off in the page, its workers and frames;
  no `webview`; web security on; no preload, IPC or custom protocol.
- Code: `apps/desktop/src/security.ts` (`WEB_PREFERENCES`).
- Tests: `apps/desktop/test/security.test.ts` "runs the console with context isolation and the
  sandbox, and no Node.js".
- Risk: likelihood Low, impact High: Medium.
- Status: Mitigated.

#### DESKTOP-E2 Chromium's debugging switches

Someone starts the shell with `--remote-debugging-port`, which no fuse covers, and drives the
signed-in console from another program.

- Mitigation: the shell quits at once when its command line has a remote debugging, inspector,
  debug port or `--js-flags` switch, and logs it; the fuses cover Node.js's own options.
- Code: `apps/desktop/src/security.ts` (`debuggingSwitchIn`); `apps/desktop/src/shell.ts`
  (`startShell`); `apps/desktop/src/packaging/builder-config.ts` (`ELECTRON_FUSES`).
- Tests: `apps/desktop/test/packaging.test.ts` "no Node.js mode, options or debugger, and only its
  checked app.asar"; `apps/desktop/test/shell.test.ts` "quits when started with a remote
  debugging switch"; `apps/desktop/test/security.test.ts` "has no developer tools, and finds the
  debugging switches".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated (P8-03d1). A person who can start the shell with a switch is an administrator
  of the PC (PC-E2).

#### DESKTOP-E3 USB, serial, HID and Bluetooth devices

The page asks for a USB, serial, HID or Bluetooth device through the browser's device APIs.

- Mitigation: the permission rule refuses what it does not name, the device permission handler
  refuses every device, and the USB, serial, HID and Bluetooth pickers are cancelled.
- Code: `apps/desktop/src/security.ts` (`isAllowedPermission`); `apps/desktop/src/shell.ts`
  (`startShell`).
- Tests: `apps/desktop/test/security.test.ts` "allows notifications and the camera to the console,
  nothing else and nobody else";
  `apps/desktop/test/shell.test.ts` "refuses every device and cancels the pickers".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated (P8-03d1).

#### DESKTOP-E4 Leaving the POS window for Windows

Staff leave the full-screen POS window (Alt+Tab, the Windows key) and use the PC's desktop, under
whatever account the POS runs as.

- Mitigation: the window is full screen; the PC runbook has the POS run under a standard Windows
  account (PC-E2) and offers Windows' Assigned Access, which locks that account to the POS window,
  where the PC is on the floor (`docs/runbooks/windows-host.md`).
- Code: `apps/desktop/src/shell.ts`.
- Tests: `apps/desktop/test/shell.test.ts` "shows the start-up page until the server answers, then
  the console, full screen".
- Risk: likelihood Medium, impact Medium: Medium.
- Status: Partly mitigated. Plan: manual task 35 by 2026-10-31: Assigned Access tried on a real PC
  where the restaurant wants it.
