# Phase 7: Commercial readiness

BRD §17 Phase 7. Exit criteria: licence and data scenarios S8, S9 and S10 pass.
Everything here is security-sensitive (licensing, crypto, backups): two human reviewers (NFR-M05).

---

## P7-01 Licensing module

Requirements: LIC-001 to LIC-009, LIC-010 (entitlement fields only), SEC-006, R-05, R-16.
Depends on: P0-17.
Deliverables: `packages/licensing` (pure verification of Ed25519-signed licence files: restaurant ID,
installation ID, PC fingerprint, plan, modules, device limits, issue/valid-until, grace days, state);
PC fingerprint tolerant to minor changes (3 of 5 identifiers); server licence agent (verify at
start-up and periodically, rolling 30-day validity renewed at least daily online, Restricted on
missing/unsigned/tampered, entitlements served to clients); state handling with `@rp/domain`
`licenseMachine`, `licenseCapabilities`, `restrictionEffectiveAt` (never mid-service); reactivation
within 1 minute online and signed offline reactivation codes; clock-rollback detection; device-limit
enforcement at pairing; tamper events reported. The signing key lives only in the cloud KMS.
Acceptance: tests for every state transition and capability, tampered file, expired offline,
clock rollback, next-business-day restriction, offline reactivation code.

Split (2026-10-03):

- **P7-01a `@rp/licensing`.** Licence file contracts; Ed25519 verification against the built-in
  vendor keys; the PC fingerprint (hashed identifiers, 3 of 5); `evaluateLicence` (the state the
  restaurant experiences, restriction from the next business day); offline reactivation codes;
  the clock guard.
- **P7-01b Control Plane: issuing licences.** The signer (a key from configuration for
  development, the cloud KMS in production), licences per installation with the fingerprint
  bound at first issue, renewal in the heartbeat answer (daily, and at once on a state change),
  heartbeats every minute while a licence is not active (reactivation within a minute, LIC-006),
  reactivation secrets and codes, vendor commands to set a state with a reason.
- **P7-01c Local server: the licence agent.** Reading the PC fingerprint; keeping the licence and
  the restriction decision; checking at start-up and every minute; the clock guard with the last
  time seen signed; restricting new tables, orders and tickets; device limits at pairing; the
  licence for every screen and the Owner's reactivation code; tamper events in heartbeats.
- **P7-01d Screens.** The payment reminder, the grace banner and the restricted notice on staff
  screens; the Owner's licence page (LIC-008).

## P7-02 Control Plane: tenants, subscriptions, licences, vendor access

Requirements: VCP-001, VCP-002, VCP-003, VCP-004 (S), VCP-007, VCP-008, VCP-009, AUTH-014, SEC-018.
Depends on: P0-17, P7-01.
Deliverables in `apps/control-plane`: vendor roles (Super Admin, Onboarding, Support, Finance,
Read-only) with mandatory MFA and full audit; tenant management (contacts, GSTIN, plan, device
limits, activation codes, PC re-binding, relay provisioning with scoped credentials); plans, billing
cycles, manual payment recording, overdue tracking, licence state changes with reasons, issue/revoke,
offline reactivation codes; support notes; documented access policy (no business data except
diagnostics or backups).
Acceptance: API and UI tests per role; MFA enforced; every action audited.

Split (2026-10-03):

- **P7-02a Vendor staff.** Accounts with a one-time setup token, password and authenticator
  (MFA mandatory), five roles with a capability matrix shared with the web app, sessions,
  lockout, account changes and resets, the quarterly access review; the first Super Admin from
  the CLI. TOTP moves to `@rp/totp`, shared with the restaurant PC.
- **P7-02b Vendor API for the fleet.** Tenants (contacts, GSTIN), installations and activation
  codes, revoking, licences (state with a reason, plan and limits, re-binding, reactivation
  codes), releases, the audit trail, by role.
- **P7-02c Subscriptions.** Plans, billing cycles, the vendor's invoices to restaurants, manual
  payments, overdue tracking that moves licences along LIC-005 (payment due, grace, restricted)
  and back on payment; the gateway and GST invoices (VCP-004, S) noted for later.
- **P7-02d Support and QR provisioning.** Support notes per restaurant, provisioning the
  restaurant in the QR relay with its scoped credential delivered to the PC, and the documented
  access policy (no business data except diagnostics or backups).
- **P7-02e The web app: sign-in and restaurants.** `apps/control-plane-web`, served by the
  Control Plane on its own origin (`CP_WEB_DIR`). It covers signing in with MFA, account setup
  from the one-time link, and sections by role. Restaurants: the list, details, PCs and
  activation codes, support notes, QR ordering. One PC: moving, disconnecting, and its licence
  (changes, re-binding, reactivation codes). UI tests per role.
- **P7-02f The web app: billing, releases, audit and staff.** Plans, a restaurant's
  subscription, invoices, payments, voiding and the billing run; releases and publishing; the
  audit trail; staff accounts, resets and the quarterly access review. UI tests per role, and an
  end-to-end test against a real Control Plane (sign-in with a real authenticator code).

## P7-03 Fleet monitoring and alerts

Requirements: VCP-005, NFR-O03, AUD-003 (chain head in heartbeats), DATA-005.
Depends on: P7-02.
Deliverables: heartbeat every 5 min with online state, versions of every component, disk usage,
backup status, device counts and health, error counts, licence state and audit chain head; fleet
dashboard; alerts for offline > 30 min during business hours, backup failure, disk > 90 %; chain-head
history to detect local tampering.
Acceptance: tests for alert rules; a tampered local chain is detected by comparing heads.

Split (2026-10-03):

- **P7-03a Heartbeat health and alerts.** The heartbeat gains the restaurant's business hours,
  connected devices, the error count, the backup status (null until P7-05) and an answer to the
  Control Plane's audit check.
  - Alert rules (pure, in `@rp/domain`): offline more than 30 minutes of business hours, disk
    over 90 %, backup failed.
  - Chain-head history and checks: a head that goes back or changes at the same sequence, and
    random checkpoints the PC must answer with the hash it holds for an earlier sequence.
  - Alerts are opened and resolved by the Control Plane (once per kind), sent to an optional
    webhook, and listed for vendor staff. A chain alert is closed by a person, with a reason.
- **P7-03b Fleet dashboard.** The web app's Fleet page (every PC's health and open alerts), the
  alerts list with resolving, and a PC's health and chain-head history.

## P7-04 Release management and remote updates

Requirements: UPD-001 to UPD-007, VCP-006, PGR-011 (distribution), R-07.
Depends on: P0-16, P7-02, P2-04.
Deliverables: signed builds from CI promoted to channels (Stable, Pilot/Beta) with per-restaurant
pinning and hotfix builds; staged rollout by percentage/cohort with pause/halt and automatic halt on
error or heartbeat spikes; local update agent: background download, install only in the maintenance
window or on "Install now", never with open tables unless security-critical and approved; pre-update
full backup and integrity check; forward-only migrations; post-update health check with automatic
rollback of app and database; component version matrix and N-1 client compatibility checks; EAS
Update channels for mobile and APK push via MDM/in-app updater; pager firmware distribution.
Acceptance: scenario S9 (forced failed health check → rollback) automated on Windows CI; staged
rollout halt test.
Builds on: the offered release saved by the heartbeat (`control_plane.offered_update`, P0-17b) and
a manager's "Install now" saved by the System page (`updates.install_approval` in `system_meta`,
P4-04); the update agent reads both.

Split (2026-10-04):

- **P7-04a Rollouts at the Control Plane (UPD-002, UPD-003, UPD-004 flag).** The rules in
  `@rp/domain`, which are a PC's stable bucket, eligibility, pinning, hotfixes and the halt verdict.
  On the Control Plane:
  - a release's rollout by percentage and cohort, which can be paused, resumed or halted;
  - a PC held at a version;
  - a hotfix for one PC;
  - security-critical releases;
  - install outcomes reported in heartbeats (`updateReport`), and a silent PC after an install
    counted as a failure;
  - the rollout halted automatically and the vendor told when failures or errors spike.
- **P7-04b Release management in the vendor web app (VCP-006).** Each release's rollout and its
  installs and failures; start, widen, pause, resume or halt; publish with a starting percentage,
  the security-critical flag, or as a hotfix for one PC; hold a PC at a version from its page.
- **P7-04c The update agent on the restaurant PC (UPD-004, UPD-005, UPD-007).**
  - Download in the background over HTTPS and verify it: SHA-256, and Authenticode on Windows.
  - Install only in the maintenance window or on "Install now", never with open tables unless the
    release is security-critical and a manager approved.
  - Before installing: a full backup and an integrity check.
  - Hand off to the installer (P0-16) and run a health check after.
  - Automatic rollback of the application and the database.
  - Report each outcome.
  - The S9 scenario on `windows-latest`.
  - As built (`docs/runbooks/software-updates.md`):
    - the server's agent leaves a request;
    - the watchdog (LocalSystem) starts a SYSTEM scheduled task;
    - the PowerShell updater checks the installer again from an administrators-only folder;
    - it copies the database with the server stopped, which is the rollback point;
    - it runs the installer and checks health;
    - to go back, it runs the previous version's kept installer, whose service host swaps the
      database copy back in.
- **P7-04d Client compatibility and the version matrix (UPD-006).** Split again (2026-10-05):
  - The client API's version (`1.<minor>`) in `@rp/contracts`; every app sends it, with its own
    version, in `x-rp-client` and the socket handshake.
  - The server serves the current minor and the one before (N-1). An older app is refused with
    426 `CLIENT_TOO_OLD` and told to update; the console reloads itself. A newer app is served.
  - Each device's app version and API are kept and shown on the Devices and System pages, and so
    are the devices an offered update would leave behind.
  - The component version matrix of every release is built by the packaging step, published to
    the Control Plane with the release and shown in the vendor web app.
  - A contract check (`pnpm contracts:compat`) fails when the contracts stop serving an API
    version that is still supported (frozen at each release with `pnpm contracts:freeze`).
- **P7-04e Phone and tablet updates (UPD-001, UPD-007).** EAS Update channels for the phones and
  tablets, applied only when the server speaks the update's client API, and the in-app APK
  updater through the local server. Pager firmware distribution is P2-04b. Split (2026-10-05,
  ADR-0017):
  - **P7-04e1 EAS Update gated by the server's client API.** Built:
    - `checkAutomatically: NEVER`, and each update's `extra.clientApi`;
    - `otaUpdateVerdict` and `mayApplyAppUpdate` in `@rp/domain`;
    - `OtaUpdater` in `@rp/mobile-core`. It checks on connecting, on refusal and every 30
      minutes; downloads only what the server serves; and restarts when the device is free;
    - `ExpoOtaUpdates` in `@rp/mobile-native`;
    - signed builds only;
    - the runbook `app-updates.md` and manual task 29.
  - **P7-04e2 The in-app APK updater through the restaurant PC (WTR-001).** Built (2026-10-05,
    ADR-0017 addendum; the device checks are in manual task 29):
    - The release's APKs (EAS Build, signed with the app-signing key) go into the installer's
      payload with `apps.json` (kind, version, SHA-256, size) at `package:stage --apk`.
    - The server serves the calling device's APK and its details. These routes are
      device-authenticated and open to refused apps (the N-1 check lets them through). The
      server checks each APK's SHA-256 before offering it.
    - A `PackageInstaller` module in `@rp/mobile-native`:
      - the download over the pinned CA with the device's token, and the SHA-256 check;
      - Android's confirmation on a phone (`REQUEST_INSTALL_PACKAGES`);
      - silent as device owner on a tablet, reopened after `MY_PACKAGE_REPLACED`;
      - Android itself refuses an APK signed with another key.
    - `ApkUpdater` in `@rp/mobile-core`:
      - offered on the sign-in screen and on "Update this app";
      - installed between guests on a tablet.
    - The System page shows the app builds the PC serves.
    - Also: the device token's challenge and renewal stay open to refused apps, the APK's
      package and `versionName` are checked on the device, a tablet that is not device owner
      offers the APK in its staff panel, and the Android CI job checks the permission and that
      the install receivers are not exported.

## P7-05 Backup and restore

Requirements: DATA-001 to DATA-005, SEC-007, OI-10.
Depends on: P0-16, P7-02.
Deliverables: WAL archiving (continuous or hourly), nightly full backup to a second location, integrity
checks, retention 14 daily + 8 weekly; nightly encrypted (AES-256-GCM) cloud backup to India storage,
key generated at install (DPAPI) and escrowed wrapped by a vendor KMS key, released only on the
Owner's authenticated restore request; opt-out recorded in audit; one-click restore onto the same or
a new PC after licence re-binding; backup failure alerts; restore runbook and rehearsal checklist.
A restore must delete `system_meta` key `events.stream_id` before the server starts, so every
device does a full refresh instead of resuming from sequences of the lost timeline (P0-12).
Acceptance: automated backup → wipe → restore test with RPO/RTO measured; tampered backup detected.

Split (2026-10-03):

- **P7-05a Encrypted local backups.**
  - The backup key: a local secret made at installation.
  - The backup file: AES-256-GCM in authenticated chunks, so a changed, reordered or cut file is
    found.
  - The nightly full backup: the database (`pg_dump`), photos, the LAN TLS files and the secrets
    the data needs. It goes to the data drive and to the second location, and each copy is
    integrity-checked.
  - Retention of 14 daily and 8 weekly backups, and "Back up now".
  - The backup state on the System page and in the heartbeat; failures alert the Owner and
    managers (DATA-005).
  - Acceptance: a tampered or truncated backup is detected.
- **P7-05b Restore.**
  - Restore a backup file onto the same PC (the Owner, with a fresh second factor) or a new one
    (the restore tool, after the licence is moved, LIC-004).
  - `events.stream_id` is removed.
  - An automated backup → wipe → restore test, with the RTO measured.
  - The restore runbook and rehearsal checklist.
- **P7-05c Continuous WAL archiving (RPO ≤ 1 hour).**
  - WAL is archived, encrypted, to the second location, with a nightly base backup.
  - Point-in-time recovery in the restore tool, with the RPO measured.
  - Built (2026-10-03): `wal-stage` as the archive_command (staging only), the server's
    `ContinuousBackupService` (encrypt, copy, `pg_switch_wal` by `backups.walMode`, nightly
    `pg_basebackup`, retention by `backups.pointInTimeDays`, DATA-005 alert), restore to a moment
    (`restore-cli pitr`, and "Restore from a backup…" for the Owner) through a temporary PostgreSQL,
    then P7-05b's restore. The installer's part (postgresql.conf, the `rp_backup` role,
    `RP_BACKUP_DATABASE_URL`) is in `docs/runbooks/backups.md` for P0-16.
- **P7-05d Cloud backup.**
  - A nightly encrypted upload to storage in India through the Control Plane: the PC uploads the
    backup file (already AES-256-GCM encrypted on the PC) straight to object storage with signed
    URLs the Control Plane issues, in parts.
  - The Control Plane keeps the record and its own retention; an S3 adapter (India region) for
    staging and production, a local folder for development and tests.
  - Opt-out (`backups.cloudEnabled`) is audited; failures alert the Owner and managers; the cloud
    backup state shows on the System page, in the heartbeat and in the fleet view.
- **P7-05e Key escrow and restore from the cloud.** (Split 2026-10-03.)
  - The backup key escrowed, wrapped by a vendor KMS key, and released for a restore only on a
    vendor restore code given after the Owner is verified (audited).
  - The restore tool restores the newest cloud backup onto a new PC with that code (DATA-004,
    RPO ≤ 24 hours when only the cloud survives).
  - Built (2026-10-03): escrow offered in heartbeat answers and sent by the PC (RSA-OAEP with the
    KMS key; AWS KMS adapter over SigV4, a configured key in development); restore codes for
    BACKUP_RESTORE (Support, Super Admin) with the Owner's verification recorded and the Owner
    alerted (`VENDOR_RESTORE_CODE`); `POST /v1/cloud-restores` and `restore-cli cloud`.

## P7-06 Data lifecycle

Requirements: DATA-006 to DATA-012, AUD-004 (purge role), §9.3 retention, §12 GST retention.
Depends on: P7-05.
Deliverables: storage monitoring by category with 80/90 % warnings; automatic purge of operational
data after 90 days; archive-then-purge (Owner + 2FA, whole financial years, encrypted checksummed
archive + human-readable export, read-back verification, then delete using the `rp_purge` role and
write a purge record; statutory-period warning); archive viewer (S); full data export in open formats
at any time including restricted mode; personal-data erasure/anonymisation; data-volume test for the
100 GB / 5 years sizing target.
Acceptance: scenario S10 parts: archive-then-purge with verification; erasure keeps invoices.

Split (2026-10-03):

- **P7-06a Automatic retention (DATA-007, DATA-011, §9.3).** Daily: operational data after
  `retention.operationalDays` (alerts, service requests, print notices, idempotency records, log
  files, restore leftovers; the outbox and photos already prune themselves); a diner's phone after
  `retention.dinerContactMonths` without a visit and feedback comments after
  `retention.feedbackMonths` anonymised (ratings kept). Audited counts. The System page shows the
  last run.
- **P7-06b Archive-then-purge (DATA-008, AUD-004).** The Owner with a fresh second factor picks
  whole financial years; an encrypted, checksummed archive and a human-readable export (invoice
  register CSV and invoice PDFs) go to a chosen folder and the cloud backup set; the archive is
  read back; then the year's business records are deleted through a separate `rp_purge` login and
  a purge record is written. A clear warning while the year is within the statutory 72 months.
- **P7-06c Archive viewer and full data export (DATA-009, DATA-010).** Open an archive read-only to
  view and print invoices and reports; a full export in open formats (CSV/JSON and invoice PDFs) at
  any time, including in restricted licence mode.
- **P7-06d Data-volume test (DATA-012).** Five years at design capacity within 100 GB, measured.

## P7-07 Onboarding wizard completion and go-live check

Requirements: ONB-001 to ONB-004, ONB-008, ONB-009, ONB-010 (S), ONB-011, BO-5.
Depends on: P1-01 to P1-05, P0-11, P5-04, P7-01 (activation).
Deliverables: resumable first-run wizard in the console covering all 11 steps (profile, tax, invoice,
accounts with Owner 2FA, floor, stations/printers with test print, menu import, staff and PINs,
device pairing, QR table tents, guided go-live test order through every path); activation code entry
binding the licence; settings export/import (S); printable site-readiness checklist.
Acceptance: Playwright run through the whole wizard on a fresh install; timing notes for ONB-009.

Split (2026-10-03):

- **P7-07a Activation and the set-up checklist.**
  - The Owner enters the vendor's activation code in the console, and the PC enrols and gets its
    licence (ONB-003).
  - A resumable "Set up" page covers the 11 steps (ONB-004). Each step's status comes from what
    is set up, plus a person's confirmation of the invoice look and skips for phones and QR. It
    links to the page that does the step and shows on the Manage home until done.
- **P7-07b First run on a fresh install.** On the restaurant PC itself (loopback only, and only
  while no restaurant exists), the console creates the restaurant and the Owner (name and PIN)
  with the built-in roles and a default invoice series. It then pairs itself with the bootstrap
  code (ONB-001), so the Owner signs in and continues with the set-up page. A Playwright run
  goes from an empty database to the set-up page, with timing notes (ONB-009).
- **P7-07c Go-live check, settings export and readiness checklist.**
  - A guided test order through every path the restaurant uses, ticked as each is seen.
  - Settings export and import (ONB-010, S).
  - The printable site-readiness checklist (ONB-011).

## P7-08 Diagnostics, support screen and remote configuration

Requirements: UPD-008, UPD-009, UPD-010, NFR-I03, NFR-O02, VCP-007.
Depends on: P7-02.
Deliverables: "Send diagnostics to support" bundle (logs, versions, configuration without secrets,
device list) and Control Plane request flow that asks the manager to allow it; support screen;
vendor-controlled remote settings and feature flags visible to the manager and audited; error
reporting wired to the vendor service (Sentry or equivalent) with PII and secret scrubbing; no remote
shell.
Acceptance: diagnostics bundle contains no secrets (test scans for known secret patterns).

Split (2026-10-03):

- **P7-08a Diagnostics bundle.** The bundle: versions, configuration without secrets, the device
  list, system status and the tail of the logs, all scrubbed of secrets and personal data. A
  manager previews and sends it from the System page; the Control Plane stores it; Support opens
  it in the web app, audited.
- **P7-08b Support asks for diagnostics.** Support requests a bundle with a reason; the request
  reaches the PC in a heartbeat answer; a manager allows it (the bundle is sent) or declines it;
  both are audited on both sides.
- **P7-08c Remote configuration.** Vendor settings and feature flags (`features.*`), set for
  the fleet and per PC by the Super Admin in the web app. They are pushed in heartbeat answers
  until the PC reports holding them, applied as vendor-controlled settings (read-only for
  managers) and audited (UPD-010). The System page is the support screen (NFR-I03).
- **P7-08d Error reporting.** Errors from the local server, the Control Plane and the console
  go to a Sentry-compatible service, scrubbed of secrets and personal data (NFR-O02). The
  console's errors pass through the local server, so no key reaches a browser.

## P7-09 Digital bills (WhatsApp/SMS)

Requirements: BILL-012 (S), BILL-011 (consent), OI-06, BRD §12 (TRAI DLT, WhatsApp templates).
Depends on: P1-10, P7-02. Business Owner: provider accounts and registrations (items 13).
Deliverables: provider adapter interface with a WhatsApp implementation first; send only with
consent; offline queue; hosted bill copy expiring after 30 days.
Acceptance: adapter tests with a fake provider; consent enforcement test.

Split (2026-10-04):

- **P7-09a Digital bills at the Control Plane.** The vendor's provider account sends, so its keys
  never reach a restaurant PC (SEC-002): a signed `POST /v1/digital-bills` from the PC with the
  bill as printed; a provider adapter interface with WhatsApp (Meta Cloud API, an approved
  template) first and SMS behind the same interface later; the hosted copy at an unguessable
  link that expires after the restaurant's `bills.hostedCopyDays`, then is deleted; the full
  number is never stored in the cloud; idempotent per send; a daily limit per PC.
- **P7-09b Digital bills on the restaurant PC.** `bills.digitalBillChannel` (off by default); a
  settled bill with a consented number is queued automatically, and the cashier can send again;
  the queue survives the internet being down and retries with back-off; the number is cleared
  once sent or given up; audited; the POS shows what happened.

## P7-10 Phase 7 exit test: S8, S9, S10

Depends on: P7-01 to P7-09.
Deliverables: automated scenarios for licence staging and reactivation online/offline with export in
restricted mode (S8), update failure rollback (S9), backup/restore to a new PC and archive-then-purge
with archive viewer (S10).
Acceptance: all pass; summary in PROGRESS.md.

Built (2026-10-09): `apps/server/test/integration/licence-exit.int.test.ts` (S8),
`update-exit.int.test.ts` (S9, the server's side; the installer's side is the CI job "Windows
installer") and `data-exit.int.test.ts` (S10), in the server's integration suite.
