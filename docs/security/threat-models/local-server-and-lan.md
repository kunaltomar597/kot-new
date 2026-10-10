# Threat model: The LAN and the local server

The restaurant PC's server (`apps/server`), its PostgreSQL database and the Windows host it runs
on, as reached from the staff network. Pagers, the QR relay, updates, the licence, the POS window
and the phones have their own models; this one covers what they all reach. Written in P8-03b
(2026-10-10). Related: [authorisation.md](../authorisation.md), [ADR-0011](../../adr/0011-lan-tls-private-ca.md).

## Scope

- HTTPS and WSS on the staff LAN with the installation's own CA: every REST endpoint, the
  Socket.io gateway, the console's static files and `/ca.crt`.
- Devices: pairing, device keys and tokens; people: PINs, the Owner's password and authenticator,
  sessions, manager approvals; the permission guard and the route registry.
- Money and records: orders, bills, invoices, payments, cash, day-ends, the audit log, the
  database roles and triggers.
- Data on the PC: the secrets under DPAPI, backups and the continuous WAL archive, logs,
  diagnostics, exports, uploads, diners' personal data, retention and purge.
- The Windows host: folder permissions, service accounts, the firewall rules the installer sets.

## Assets

- Orders, bills, gap-free invoice numbers, payments, cash movements, day-ends and the Z-report.
- The audit log and its hash chain.
- Device keys (non-extractable in browsers, Android Keystore on phones), device tokens (60
  minutes), access tokens (15 minutes), rotating refresh tokens, override tokens (2 minutes).
- PINs and the Owner's password, authenticator secret and recovery codes.
- The secrets in the DPAPI store: the pepper, the token keys, the TLS key-encryption key, the
  installation key, the relay credential, the licence record key, the backup key; and the
  database logins' passwords.
- Backups, the WAL archive, year archives and full data exports.
- Diners' phone numbers, names, feedback and consent.
- The restaurant being able to work through a dinner rush (NFR-A01).

## Entry points

- `/api/v1/*` over HTTPS: about 250 endpoints, 11 of them public (listed in
  [authorisation.md](../authorisation.md)).
- The Socket.io namespace `/rt` over WSS; `/ca.crt` and the console's files.
- The PC's own loopback address: first run, the installer's bootstrap pairing code, the
  command-line tools (`setup-cli`, `restore-cli`, `relay-cli`, `enrol-cli`).
- PIN pads on the POS, kitchen screens and phones; the PIN prompts on a table tablet (leaving the
  kiosk, approving a diner's order at the table).
- Uploads: menu photos, menu spreadsheets, AI menu imports.
- PostgreSQL on `localhost`; the data, secrets, logs and backup folders; the second backup
  location (USB or NAS).
- The staff network itself.

## Trust boundaries

1. Guest Wi-Fi and the internet ↔ the staff network (the router, and the Windows firewall).
2. The staff network ↔ the server: TLS, then the device credential.
3. A paired device ↔ the person using it: a PIN session bound to that device.
4. A person ↔ a capability: the permission guard and the §4.2 matrix, a manager's approval, the
   Owner's second factor.
5. The PC's loopback ↔ the network: first run and the bootstrap code.
6. The console's JavaScript ↔ the credentials it holds (the console's CSP).
7. The server's account (`NT SERVICE\RPServer`, database login in `rp_app`) ↔ PostgreSQL's roles
   and triggers.
8. Windows administrators and SYSTEM ↔ everything on the PC: they can read every DPAPI secret.
9. The PC ↔ the second backup location and the cloud (encrypted).

## Data flows

1. Pairing: the manager's QR code (one-time code, CA fingerprint, the server's addresses) →
   `POST /devices/pair` with the device's public key and a proof.
2. Every hour: a challenge → signed with the device key → a device token.
3. Every request: `x-device-token`, and a person's access token bound to its session and device.
4. A request → contract validation → the server prices and decides → one transaction with the
   state change, its audit entry (under the chain's lock) and its outbox event → the socket rooms
   that may hear it.
5. A manager's PIN → an override token in `x-override-token` for one capability.
6. Nightly: `pg_dump` → AES-256-GCM → the backups folder and the second location → the cloud;
   the WAL archive in between.
7. Purge: a year's records → an encrypted archive → `rp_purge` deletes them.
8. Logs → `<data>\logs`; diagnostics: a scrubbed bundle → the vendor, when a manager allows it.

## Threats

### Spoofing

#### PC-S1 Forged device identity

A host on the LAN pretends to be a paired device to call device endpoints or to sign people in.

- Mitigation: a device token is given only for a fresh challenge (60 seconds, used once) signed
  with the device's own key; the device row must still be active on every request.
- Code: `apps/server/src/devices/devices.service.ts` (`DevicesService.issueToken`);
  `apps/server/src/auth/device-keys.ts` (`verifyDeviceSignature`);
  `apps/server/src/auth/device-token.authenticator.ts` (`authenticateToken`).
- Tests: `apps/server/test/integration/devices.int.test.ts` "needs a fresh challenge signed with
  the device key, used once", "refuses a challenge issued for another device, and an expired one";
  `apps/server/test/integration/authorisation-sweep.int.test.ts` "refuses every other endpoint
  without a paired device".
- Risk: likelihood Low, impact High: Medium.
- Status: Mitigated.

#### PC-S2 Pairing with someone else's code

Someone photographs a pairing QR code from a manager's screen and pairs their own device with it
within its 10 minutes.

- Mitigation: codes are made only by managers, last 10 minutes, are stored hashed and work once;
  pairing is rate-limited and audited; the device then has no person signed in and the manager
  sees it in the Devices list.
- Code: `apps/server/src/devices/devices.service.ts` (`DevicesService.pair`, `pairingCode`).
- Tests: `apps/server/test/integration/devices.int.test.ts` "uses each code once and only until
  it expires", "only lets managers create codes", "refuses the 11th pairing attempt within a
  minute from one client".
- Risk: likelihood Low, impact Medium: Low.
- Status: Accepted: whoever presents the code first pairs; a device needs a person's PIN for
  everything beyond the menu and the staff tiles, and the manager unpairs a device they did not
  expect.

#### PC-S3 Replaying a stolen token

A device token, access token or refresh token taken from a compromised client is used from
another host on the LAN.

- Mitigation: a person's tokens are bound to the device and session they were issued for; a
  reused refresh token ends the whole session; device tokens last an hour and are renewed only
  with the non-extractable device key.
- Code: `apps/server/src/auth/session.service.ts` (`SessionService.authenticate`, `refresh`).
- Tests: `apps/server/test/integration/auth-sessions.int.test.ts` "are required, and only
  accepted from the device they were issued to", "revoke the whole session when a replaced
  refresh token is used again"; `apps/server/test/integration/authorisation-sweep.int.test.ts`
  "refuses a sign-in presented from another device".
- Risk: likelihood Low, impact Medium: Low.
- Status: Accepted: the device token is a bearer secret for up to an hour, not bound to the TLS
  channel; taking it needs script running in the console (PC-I4) or a rooted phone, and unpairing
  stops it at once.

#### PC-S4 A rogue server or a man in the middle on the LAN

ARP spoofing or a rogue DHCP server puts another host between the devices and the PC, to read or
change the traffic or to collect PINs.

- Mitigation: TLS 1.2 or later with the installation's own CA; the phones and tablets pin the CA
  whose fingerprint is in the pairing QR code; the POS window pins it for the PC's own address;
  managers' browsers trust `/ca.crt` after comparing its fingerprint.
- Code: `apps/server/src/tls/tls-store.ts` (`serverTlsOptions`, `TLS_MIN_VERSION`);
  `apps/server/src/devices/devices.service.ts` (`issueCode`).
- Tests: `apps/server/test/integration/tls.int.test.ts` "is rejected by a client that trusts
  another CA, or only the public ones", "accepts TLS 1.2 and refuses older protocols", "lets a
  device that pinned the CA open the real-time socket, and no other";
  `packages/mobile-core/test/device-session.test.ts` "refuses a server whose CA is not the one in
  the QR code".
- Risk: likelihood Low, impact High: Medium.
- Status: Partly mitigated. Plan: P8-03d by 2026-10-22: a browser's first trust of `/ca.crt`
  rests on a person comparing the fingerprint (`docs/runbooks/lan-tls.md`), and the CA has no name
  constraints, so its key, if stolen from the PC, could sign for any site on the browsers that
  trust it; P8-03d adds name constraints (amending ADR-0011) and the fingerprint check to the
  installation checklist.

#### PC-S5 Guessing a PIN

Someone at a paired device tries PINs, or tries a few PINs for every person in turn.

- Mitigation: PINs work only on a paired staff device; they are hashed with Argon2id and a pepper;
  five failures in ten minutes lock that person for 15 minutes (audited); every wrong PIN or
  password also counts against the device it was typed on, which takes none for 15 minutes after
  ten in ten minutes whoever they were for, so spreading guesses over people gains nothing
  (`auth.deviceLockoutMaxFailures`); each device may try ten times a minute; the PINs guessed
  first (one digit or block repeated, runs, pairs, years, keypad lines) are refused when a PIN is
  set (`auth.refuseEasyPins`, on by default); every lockout alerts the managers and the Owner
  (`SIGN_IN_LOCKED`); unknown people and wrong PINs take the same time.
- Code: `apps/server/src/auth/credential-hasher.ts` (`CredentialHasher`, `verifyNothing`);
  `apps/server/src/auth/auth.service.ts` (`wrongSecret`, `countDeviceFailure`, `deviceBlocked`,
  `throttle`); `apps/server/src/auth/rate-limiter.ts`; `packages/domain/src/lockout.ts`
  (`countFailure`); `packages/domain/src/staff.ts` (`isValidPin`, `isEasilyGuessedPin`);
  `apps/server/src/staff/staff.service.ts` (`requireHardToGuess`);
  `apps/server/src/notifications/lockout-alerts.ts` (`LockoutAlerts`).
- Tests: `apps/server/test/integration/auth-login.int.test.ts` "locks after 5 failures in 10
  minutes, for 15 minutes, and audits it", "stops a device taking any PIN after 10 wrong ones for
  anyone, spread over people", "refuses the 11th attempt within a minute from one device, but not
  from another", "refuses the staff tiles and PIN login to an unknown device, even with a valid
  PIN", "alerts the managers and the Owner when a login locks, and clears it when it is
  unlocked"; `apps/server/test/integration/staff.int.test.ts` "refuses an easily guessed PIN,
  unless the restaurant allows them"; `packages/domain/test/staff.test.ts` "easily guessed PINs";
  `apps/server/test/unit/auth-primitives.test.ts` "depends on the pepper, so a stolen hash alone is
  useless".
- Risk: likelihood Low, impact High: Medium.
- Status: Mitigated (P8-03b2a: the lockout counted only per person, so 20 people gave about 100
  guesses every 15 minutes, and `0000` or `1234` were accepted). What is left: ten guesses per
  device every 25 minutes, each lock alerting the managers; 6-digit PINs (`auth.pinLength`) cut it
  a hundredfold.

#### PC-S6 A stolen phone or a person who has left

A phone is stolen while paired, or someone who left still knows their PIN.

- Mitigation: unpairing stops the device's token and every session on it at once and closes its
  live connections; deactivating a person signs them out everywhere within 5 seconds and takes
  back their devices and sections; the server checks that the person is active on every request.
- Code: `apps/server/src/devices/devices.service.ts` (`DevicesService.revoke`);
  `apps/server/src/staff/staff.service.ts` (`StaffService.deactivate`);
  `apps/server/src/auth/session.service.ts` (`SessionService`).
- Tests: `apps/server/test/integration/devices.int.test.ts` "stops the device token and every
  session on the device at once, and emits DeviceRevoked";
  `apps/server/test/integration/staff.int.test.ts` "signs the person out everywhere within 5 s,
  takes back their devices and sections"; `apps/server/test/integration/realtime.int.test.ts`
  "closes an unpaired device".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

#### PC-S7 Reaching first run or the bootstrap code from the network

Someone on the LAN calls first run to create the restaurant, or asks for the installer's
bootstrap pairing code, on a PC that has just been installed.

- Mitigation: both answer only on the PC's own loopback address (the socket's address, with no
  proxy trusted) and only while there is no restaurant, or no paired device.
- Code: `apps/server/src/onboarding/first-run.controller.ts` (`FirstRunController`);
  `apps/server/src/devices/devices.service.ts` (`createBootstrapCode`).
- Tests: `apps/server/test/integration/first-run.int.test.ts` "is refused from anywhere but the
  restaurant PC"; `apps/server/test/integration/devices.int.test.ts` "gives the server PC a
  bootstrap code only while no device is paired".
- Risk: likelihood Low, impact High: Medium.
- Status: Mitigated.

#### PC-S8 Signing in to PostgreSQL

A host on the network, or a program on the PC, connects to the database with one of the
installation's logins.

- Mitigation: PostgreSQL listens on `localhost` only and takes passwords (SCRAM) from the PC only;
  the logins' passwords are in the DPAPI store; no login is a superuser and `PUBLIC` has nothing.
- Code: `apps/server/src/installation/postgres-setup.ts` (`managedPostgresSettings`,
  `managedHbaConf`); `apps/server/src/installation/database-setup.ts` (`setupDatabase`).
- Tests: `apps/server/test/unit/installation.test.ts` "listens on this PC only, in UTC, archiving
  its log for the continuous backup", "allows passwords from this PC only, and replication only
  for the backup login"; `apps/server/test/integration/installation-database.int.test.ts` "keeps
  everyone else out of the restaurant database".
- Risk: likelihood Low, impact High: Medium.
- Status: Mitigated.

### Tampering

#### PC-T1 Prices, totals or roles sent by a client

A modified app sends its own prices, discounts, a staff id or a role, hoping the server uses them.

- Mitigation: request contracts are strict and have no price fields; the server prices every line
  from the published menu and works out tax and totals; the person and their role come from the
  session, read again on every request.
- Code: `apps/server/src/orders/orders.service.ts` (`OrdersService.submit`).
- Tests: `apps/server/test/integration/errors.int.test.ts` "validates bodies against contracts
  and rejects client prices"; `apps/server/test/integration/orders.int.test.ts` "refuses prices
  sent by a client and sources that are not staff";
  `apps/server/test/integration/auth-sessions.int.test.ts` "a role change applies at the next
  request".
- Risk: likelihood Low, impact High: Medium.
- Status: Mitigated.

#### PC-T2 A manager's approval used on another record

A cashier asks a manager to approve voiding a ₹200 dish, then uses the approval to void a ₹2,000
one or another bill; the audit names the manager as the approver.

- Mitigation: an approval is for one capability and one record, used once, within 2 minutes, by
  the session that asked for it. An approval for a voided item, a reopened or voided invoice or a
  discount above the limit must name its record when it is given (422 `OVERRIDE_RECORD_REQUIRED`
  otherwise, before the PIN is checked); the guard takes the record from the route
  (`OVERRIDE_RECORD_TYPES`, the route's `record` parameter) and the discount from its bill, and an
  approval used on another record is refused and stays unused. A route of such a capability that
  does not say where its record is refuses every request.
- Code: `packages/domain/src/permissions.ts` (`OVERRIDE_RECORD_TYPES`);
  `apps/server/src/auth/auth.service.ts` (`grantOverride`, `consumeOverride`);
  `apps/server/src/auth/permission.guard.ts` (`overrideRecord`);
  `apps/server/src/billing/bills.service.ts` (`approve`).
- Tests: `apps/server/test/integration/auth-guard.int.test.ts` "turns a manager PIN into a
  single-use approval for one capability", "works only on the record it names, refused and not
  spent on another", "is refused without the record, or for another kind of record, before the
  PIN", "is bound to the requester session and expires after 2 minutes";
  `packages/domain/test/permissions.test.ts` "names the kind of record every approvable action is
  about".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated (P8-03b2a: voids of items and invoices and reopening an invoice did not check
  which record the approval was for).

#### PC-T3 Changing or deleting money records in the database

Someone with the server's database login deletes a payment, or changes a payment's mode or
amount, a cash movement or a closed day.

- Mitigation: the server's role cannot DELETE financial or audit records, nor UPDATE payments,
  cash movements, day-ends or the audit log; triggers refuse changes to a settled invoice and to
  the audit log even for the table owner; only the purge role deletes, after archiving.
- Code: `apps/server/prisma/migrations/20260925200100_roles_and_protection/migration.sql`
  (`rp_audit_log_guard`); `apps/server/prisma/migrations/20261010100000_money_records_append_only/migration.sql`.
- Tests: `apps/server/test/integration/schema.int.test.ts` "never lets rp_app DELETE financial or
  audit records", "never lets rp_app change a payment, a cash movement or a closed day", "blocks
  UPDATE and DELETE even for the owner, through a trigger", "freezes the number and amounts of a
  settled invoice but allows voiding it"; `apps/server/test/integration/archive-purge.int.test.ts`
  "never lets the application role delete what the purge may".
- Risk: likelihood Low, impact High: Medium.
- Status: Mitigated (fixed in P8-03b: the server's login could still UPDATE payments, cash
  movements and day-ends, which no code does).

#### PC-T4 Rewriting the audit history

Someone who reaches the database owner disables the triggers and rewrites or removes audit
entries, recomputing the chain.

- Mitigation: each entry's hash covers the one before, so an edit or a removal shows at the next
  link; the chain's head and checkpoints go to the Control Plane in every heartbeat, which raises
  an alert when the chain was cut back or rewritten.
- Code: `apps/server/src/audit/audit.service.ts` (`AuditService.verify`, `chainHead`);
  `apps/server/src/audit/audit-hash.ts` (`computeAuditHash`);
  `packages/domain/src/fleet-health.ts` (`checkChainHead`, `checkCheckpoint`).
- Tests: `apps/server/test/integration/audit.int.test.ts` "detects an edited row", "detects an
  edit whose hash was recomputed, at the next link", "detects a row removed from the middle";
  `packages/domain/test/fleet-health.test.ts` "detects a chain cut back, rewritten or emptied".
- Risk: likelihood Low, impact High: Medium.
- Status: Partly mitigated. Accepted: the chain is not keyed, so the database owner can recompute
  all of it; reaching the owner needs a Windows administrator (PC-E2), and a PC that sends
  heartbeats is checked against what the Control Plane already holds.

#### PC-T5 Replayed or doubled submissions

A retry, a double tap or a replayed request creates a second order, ticket, payment or stock
deduction.

- Mitigation: every submission carries an idempotency key, taken under a lock with a hash of the
  request; the same key returns the first result, a different request with it is refused.
- Code: `apps/server/src/orders/orders.service.ts` (`OrdersService.submit`).
- Tests: `apps/server/test/integration/orders.int.test.ts` "returns the original result for a
  repeated key: one order, one ticket set, one stock deduction";
  `apps/server/test/integration/relay-orders.int.test.ts` "takes an order once however often it
  is picked up".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

#### PC-T6 Gaps or reuse in invoice numbers

Concurrent bills, a crash or a rollback leave a gap in the series or give one number twice
(BILL-003).

- Mitigation: numbers come from one sequence row per series and year, taken in the bill's
  transaction, so a rollback gives the number back; a unique index forbids a repeat.
- Code: `apps/server/src/database/numbering.ts` (`allocateInvoiceSequence`).
- Tests: `apps/server/test/integration/schema.int.test.ts` "allocates consecutive invoice numbers
  under concurrency, per series and year", "gives the number back when the transaction rolls
  back".
- Risk: likelihood Low, impact High: Medium.
- Status: Mitigated.

#### PC-T7 Restoring an old backup to hide fraud

Someone restores last week's backup to remove the bills, voids or payments since.

- Mitigation: a restore needs the Owner with a fresh second factor, is audited and restarts the
  server; the Control Plane sees the chain go back and reports it.
- Code: `apps/server/src/backups/backup.service.ts` (`auditRestore`).
- Tests: `apps/server/test/integration/restore.int.test.ts` "needs the Owner with a fresh second
  factor, restarts, and restores before starting"; `packages/domain/test/fleet-health.test.ts`
  "detects a chain cut back, rewritten or emptied".
- Risk: likelihood Low, impact High: Medium.
- Status: Partly mitigated. Plan: P8-03d by 2026-10-22: a Windows administrator can run
  `pg_restore` by hand without the audit entry, which only the heartbeat shows; P8-03d's checklist
  for the PC keeps daily work off administrator accounts (PC-E2).

#### PC-T8 Formulas in exported files

Text a diner or a member of staff typed (a note, a name, a feedback comment) starts with `=` and
runs as a formula when a spreadsheet opens an export.

- Mitigation: every CSV the server writes goes through `csvCell`, which neutralises formulas with
  a leading apostrophe: the reports, the audit export, the full data export's tables and the
  invoice register; the data export's JSON lines keep the text as typed (P8-03b2c).
- Code: `packages/domain/src/csv.ts` (`csvCell`); `apps/server/src/lifecycle/data-export.service.ts`
  (`csvField`); `apps/server/src/lifecycle/invoice-books.ts` (`writeInvoiceRegister`).
- Tests: `packages/domain/test/csv.test.ts` "neutralises text a spreadsheet would run as a
  formula"; `apps/server/test/integration/audit-viewer.int.test.ts` "exports the log with its
  filters, and not to people without it"; `apps/server/test/integration/data-export.int.test.ts`
  "neutralises formulas in its CSV files and the invoice register, the JSON keeping them as typed".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated (P8-03b2c: the data export and the invoice register only quoted cells).

### Repudiation

#### PC-R1 Staff deny a void, discount, edit or payment

A cashier or manager says they never voided, discounted, edited or took a payment.

- Mitigation: every money and security action writes an audit entry with the actor, the approver,
  the device, before and after, the reason and the correlation id, in the same transaction as the
  change.
- Code: `apps/server/src/audit/audit.service.ts` (`AuditService.record`).
- Tests: `apps/server/test/integration/audit.int.test.ts` "records the server time, actor,
  approver, device, reason and correlation ID", "rolls back with the business transaction and
  reuses the position".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

#### PC-R2 Security events that leave no trace

Failed sign-ins, lockouts, sign-outs and pairing codes happen without a record (AUTH-013).

- Mitigation: each is audited, including a wrong PIN on a table tablet.
- Code: `apps/server/src/auth/auth.service.ts` (`wrongSecret`, `logout`).
- Tests: `apps/server/test/integration/auth-login.int.test.ts` "refuses a wrong PIN, an unknown
  person and an archived person alike"; `apps/server/test/integration/tablet.int.test.ts`
  "refuses a wrong PIN (audited), a waiter, and any device but a tablet";
  `apps/server/test/integration/auth-sessions.int.test.ts` "logout ends the session and is
  audited".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

#### PC-R3 Fraud that nobody notices

A person voids after printing, edits printed bills or keeps cash, within what they are allowed.

- Mitigation: the suspicious-activity report and its daily run name the people behind each
  pattern (P4-07b).
- Code: `apps/server/src/reports/suspicious-activity.service.ts` (`SuspiciousActivityService`).
- Tests: `apps/server/test/integration/suspicious-activity.int.test.ts` "every pattern appears
  with the correct people attributed", "flags a printed bill edited under its number, with the
  change in the total".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

#### PC-R4 Kitchen steps by nobody in particular

In station mode a kitchen screen works without individual sign-ins, so a step is the station's,
not a person's.

- Mitigation: AUTH-005's station mode, by design; restaurants that want each step attributed turn
  on individual kitchen logins.
- Code: `apps/server/src/auth/permission.guard.ts` (`PermissionGuard`).
- Tests: `apps/server/test/integration/auth-login.int.test.ts` "keeps kitchen staff in station
  mode unless individual kitchen logins are on".
- Risk: likelihood Medium, impact Low: Low.
- Status: Accepted: AUTH-005 asks for station mode; the setting `auth.kitchenIndividualLogins`
  gives each step a person.

#### PC-R5 Purging a year to erase evidence

The Owner, or someone with their account, purges a financial year to remove the records of
what happened in it.

- Mitigation: purge is the Owner's with a password and second factor, by whole financial year, only
  after the year is archived; the chain's hash at the cut is kept, so the chain still verifies.
- Code: `apps/server/src/lifecycle/archive.service.ts` (`ArchiveService`).
- Tests: `apps/server/test/integration/archive-purge.int.test.ts` "archives, exports, reads back
  and purges the year, and keeps the next one"; `apps/server/test/integration/audit.int.test.ts`
  "accepts a chain whose oldest entries were archived and purged".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

### Information disclosure

#### PC-I1 Secrets in the logs

PINs, passwords, tokens or keys written to `<data>\logs`, which support may later read.

- Mitigation: the request log redacts credentials at every depth and the credential headers,
  including a manager's approval token; diagnostics scrub the log tail again before it leaves.
- Code: `apps/server/src/logging/correlation.ts` (`redactionPaths`).
- Tests: `apps/server/test/integration/auth-guard.int.test.ts` "never contain PINs, passwords or
  tokens"; `apps/server/test/unit/correlation-and-validation.test.ts` "redacts credentials at
  several depths".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated (fixed in P8-03b: the `x-override-token` header was written to the request
  log).

#### PC-I2 Internals in answers

Error answers or public endpoints tell an attacker about the software.

- Mitigation: unexpected errors answer with a code and a plain message, never the internal one;
  a path nothing serves answers the API's 404, not Express's page. `/version` names only the
  Node.js major line (the exact version is on the System page, for signed-in managers). Every
  answer says it is not to be run as a page, framed, sniffed, cached or read by another site; the
  DAST scan (P8-03c1) attacks every endpoint on each run of its CI job.
- Code: `apps/server/src/errors/error-mapping.ts` (`mapError`);
  `apps/server/src/health/health.controller.ts` (`HealthController`);
  `apps/server/src/http/security-headers.ts` (`API_SECURITY_HEADERS`);
  `apps/server/src/http/request-pipeline.ts` (`notFoundOutsideApi`).
- Tests: `apps/server/test/integration/errors.int.test.ts` "never leaks internal error messages";
  `apps/server/test/unit/error-mapping.test.ts` "hides internal details of unexpected errors";
  `apps/server/test/integration/health.int.test.ts` "reports the version and build, with only the
  major line of Node.js"; `apps/server/test/integration/console-static.int.test.ts` "puts the
  security headers on every answer that is not a page of the console";
  `infra/dast/test/scan.test.ts` "leaves no finding open on the local server and the console".
- Risk: likelihood Low, impact Low: Low.
- Status: Mitigated (P8-03c1: `/version` named the exact Node.js version; the API sent no
  security headers of its own, and unknown paths outside it answered Express's HTML page).

#### PC-I3 Events reaching screens that may not see them

A table tablet, a kitchen screen or a waiter's phone hears events about other tables, bills or
people.

- Mitigation: the server puts each connection in its rooms from the device and the person, and
  each event goes only to the rooms allowed to see it; a table tablet hears only its table.
- Code: `apps/server/src/realtime/rooms.ts` (`roomsForConnection`, `roomsForEvent`).
- Tests: `apps/server/test/integration/realtime.int.test.ts` "routes by role, table, station and
  person, in sequence order, within a second"; `apps/server/test/unit/realtime-rooms.test.ts`
  "follows the permission matrix: a role denied the capability hears nothing", "puts a table
  tablet in its own table room only, even with a person signed in".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

#### PC-I4 Script in the console reading its credentials

Injected script in the console reads the device token or the session, or signs challenges with
the device key.

- Mitigation: the console's CSP allows only its own scripts and no framing, and requires Trusted
  Types with no policy at all: no string reaches an HTML or script sink, so markup that got into
  the page cannot run script, and React escapes all text. Zod runs without `new Function`, so
  the page needs no eval. The device key cannot be exported. Script that did run could still read
  the tokens.
- Code: `apps/server/src/http/console-static.ts` (`CONSOLE_SECURITY_HEADERS`);
  `apps/console/src/app/zod-jitless.ts`; `apps/console/src/app/storage.ts` (`BrowserStorage`);
  `packages/api-client/src/device-key.ts`.
- Tests: `apps/server/test/integration/console-static.int.test.ts` "serves the app shell with
  strict security headers, for every client-side route", "lets no string reach a script or HTML
  sink in the console (Trusted Types)"; `apps/console/e2e/console.e2e.ts` "every screen ran within
  the CSP and Trusted Types (PC-I4)"; `apps/console/test/console-controller.test.ts` "stores and
  reloads the non-extractable key pair, the device and the session";
  `infra/dast/test/scan.test.ts` "leaves no finding open on the local server and the console".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated (P8-03c1: Trusted Types; the e2e run shows no screen breaks a rule).

#### PC-I5 A stolen PC or disk

The PC or its disk is taken; the database, logs and WAL archive are plain files, and DPAPI's
machine keys are on the same disk.

- Mitigation: backups are encrypted; secrets are sealed with DPAPI. Without BitLocker, the disk
  gives up everything. The site-readiness checklist recommends BitLocker; nothing checks it.
- Code: `apps/server/src/auth/dpapi.ts`; `apps/console/src/manage/setup/ReadinessChecklist.tsx`.
- Tests: `apps/server/test/unit/dpapi-secret-store.test.ts` "fails without caching when the
  secrets cannot be unprotected (another PC)".
- Risk: likelihood Medium, impact High: High.
- Status: Not mitigated. Plan: P8-03d by 2026-10-22: BitLocker becomes a requirement of the
  CIS checklist for the PC and the installation runbook, and the System page warns while the data
  drive is not encrypted.

#### PC-I6 A local Windows user reads the data

Another account on the PC, or another service, reads the secrets, the database files, the logs or
the backups.

- Mitigation: the installer sets the folders' permissions by SID: secrets for administrators,
  SYSTEM and the server only, nothing inherited. PostgreSQL runs as the shared Network Service
  account, which any other service running as it can use.
- Code: `infra/installer/windows/RestaurantPlatform.Setup.psm1` (`Get-RPFolderAclPlan`,
  `Set-RPFolderPermission`); `apps/server/src/installation/postgres-setup.ts`
  (`pgCtlRegisterArgs`).
- Tests: `infra/installer/windows/tests/Permissions.Tests.ps1` "keeps the secrets to
  administrators, SYSTEM and the server, inheriting nothing", "never lets ordinary users or
  everyone change anything".
- Risk: likelihood Low, impact High: Medium.
- Status: Partly mitigated. Plan: P8-03d by 2026-10-22: the database service runs under its own
  virtual account, checked in the Windows CI job.

#### PC-I7 Backups read off the PC

The second location (USB, NAS) or the cloud copy is taken.

- Mitigation: every backup is AES-256-GCM in chunks with a key per file, its header, order and end
  bound in; the backup key stays in the DPAPI store, its escrowed copy is wrapped for the vendor's
  KMS.
- Code: `apps/server/src/backups/backup-file.ts` (`encryptBackup`, `decryptBackup`).
- Tests: `apps/server/test/unit/backup-file.test.ts` "detects a changed byte, a cut, a swapped
  chunk and extra data", "refuses another key and a file that is not a backup";
  `apps/server/test/integration/backups.int.test.ts` "backs up the database, photos, TLS files
  and secrets, encrypted, to both places".
- Risk: likelihood Low, impact High: Medium.
- Status: Mitigated.

#### PC-I8 Personal data in the diagnostics sent to support

A diagnostics bundle sent to the vendor carries secrets or diners' and staff's personal data.

- Mitigation: the bundle holds versions, configuration from an allow-list, device states and a log
  tail scrubbed of phone numbers and e-mail addresses; a manager sees it before it is sent, and
  sending it is audited.
- Code: `apps/server/src/system/diagnostics.service.ts` (`DiagnosticsService`);
  `packages/domain/src/scrub.ts` (`scrubText`, `scrubValue`).
- Tests: `apps/server/test/integration/diagnostics.int.test.ts` "holds versions, configuration,
  devices, status and logs, and no secret"; `packages/domain/test/scrub.test.ts` "removes email
  addresses and phone numbers, keeping ids and times".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

#### PC-I9 Diners' personal data kept after they ask

A diner asks to be forgotten (DATA-011) and their number stays on orders and bills.

- Mitigation: numbers are kept only with consent, with its purpose and words; erasure clears the
  diner's contact and feedback's link to it, and the number on every order and bill, matched on
  its last ten digits however it was typed; invoices keep what tax law needs but lose the consent,
  so no digital bill goes to the number again; a digital bill still waiting is not sent, one
  already sent stays as it was; retention anonymises old personal data (P8-03b2c).
- Code: `apps/server/src/feedback/feedback.service.ts` (`FeedbackService.erase`);
  `apps/server/src/lifecycle/retention.service.ts`.
- Tests: `apps/server/test/integration/feedback.int.test.ts` "keeps a number only with consent,
  with its purpose and words", "lets the Owner erase it everywhere but invoices, audited without
  the number"; `apps/server/test/integration/digital-bills.int.test.ts` "erases the number on
  orders and bills however it was typed; invoices keep it but send no more bills to it", "does
  not send a waiting bill once the diner’s number is erased; a sent one stays as it was";
  `apps/server/test/integration/retention.int.test.ts` "removes old operational data and
  anonymises old personal data, audited".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated (P8-03b2c: orders and bills kept the number, and an invoice could still send
  a digital bill to it).

#### PC-I10 Metadata in menu photos

A photo carries the camera's location or owner in its EXIF data.

- Mitigation: every photo is decoded and re-encoded to WebP renditions without metadata.
- Code: `apps/server/src/photos/photo-processing.ts` (`processPhoto`).
- Tests: `apps/server/test/unit/photo-processing.test.ts` "re-encodes a JPEG to WebP renditions
  without EXIF, turned upright"; `apps/server/test/integration/photos.int.test.ts` "stores WebP
  renditions without EXIF and serves them with long caching".
- Risk: likelihood Low, impact Low: Low.
- Status: Mitigated.

#### PC-I11 Traffic in clear on a server configured by hand

A server started outside the installer without TLS serves HTTP, WS and plain MQTT on the LAN.

- Mitigation: in production the server refuses to start without TLS; the installer always turns
  it on.
- Code: `apps/server/src/config/app-config.ts` (`loadConfig`);
  `apps/server/src/installation/installation.ts` (`serverEnvironment`).
- Tests: `apps/server/test/unit/app-config.test.ts` "needs TLS in production".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated (fixed in P8-03b: production refused other unsafe settings but not TLS off).

### Denial of service

#### PC-D1 Large bodies before authentication

Any host on the LAN, with no credential, sends many large request bodies; the server reads and
parses them before it checks who is calling, and runs out of memory during service.

- Mitigation: the device token is checked before any body is read; a caller without a paired
  device may send 16 KB (pairing, a device token and the first run need a few hundred bytes), and
  a larger body it announces is refused before a byte is read; only paired devices get 1 MB, and
  7 MB for photos and menu files or 55 MB for AI imports on those paths alone. A device whose token
  no longer verifies hears `DEVICE_NOT_RECOGNISED`, so its client renews the token (P8-03b2c).
- Code: `apps/server/src/http/body-limits.ts` (`bodyParsers`, `ANONYMOUS_BODY_LIMIT`,
  `UPLOAD_BODY_LIMIT`, `AI_IMPORT_BODY_LIMIT`); `apps/server/src/auth/device.ts`
  (`rememberDevice`).
- Tests: `apps/server/test/integration/body-limits.int.test.ts` "reads no more than a small body
  from a caller without a paired device, uploads included", "answers before the body arrives",
  "tells a device whose token no longer verifies to renew it, without reading a large body";
  `apps/server/test/integration/errors.int.test.ts` "limits request body size".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated (P8-03b2c: the parsers ran before the device check).

#### PC-D2 Lockouts used to stop the restaurant

Someone with any paired device, a diner at a tablet included, types wrong PINs for the managers
and waiters and locks them out during service, again and again.

- Mitigation: wrong PINs typed on a table tablet count against the tablet, never the person
  (MOBILE-D1, decided in P8-03b2a); on a staff device each one also counts against the device,
  which stops taking PINs after ten, so one device can lock out at most two people every 25
  minutes; every lockout alerts the managers and the Owner with the person and the device, and a
  manager lifts a person's lock (Staff page) or a device's (Devices page) at once, which clears the
  alert; lockouts last 15 minutes.
- Code: `apps/server/src/auth/auth.service.ts` (`wrongSecret`, `unlock`);
  `apps/server/src/devices/devices.service.ts` (`unlockPins`);
  `apps/server/src/notifications/lockout-alerts.ts` (`LockoutAlerts`);
  `apps/console/src/manage/devices/DevicesScreen.tsx` (`onUnlockPins`).
- Tests: `apps/server/test/integration/tablet.int.test.ts` "counts wrong PINs against the
  tablet, never locking the managers"; `apps/server/test/integration/auth-login.int.test.ts` "lets
  a manager unlock a locked login, and nobody else", "lets a manager, not a waiter, let a device
  take PINs again at once", "alerts the managers and the Owner when a login locks, and clears it
  when it is unlocked"; `apps/server/test/integration/auth-guard.int.test.ts` "locks the approver
  PIN after repeated wrong attempts"; `apps/console/test/devices.test.tsx` "shows a device that
  takes no PINs until when, and lets it take them again".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated (P8-03b2a: a diner could lock the managers out from a tablet, and nobody was
  told of a lockout).

#### PC-D3 Flooding the server or the socket

A host on the LAN opens many connections or sends requests as fast as it can, so screens stop
updating during service.

- Mitigation: every TCP connection to the HTTPS port is counted before its TLS handshake: 256 open
  at once per address and 4,096 in all, and an address opens 120 at once, then 20 a second; past
  either, the connection is closed at once. Requests from an address: 400 at once, then 100 a
  second; past that, 429 with `Retry-After` and the connection closed, so the host must open a new
  one, which is counted too. The TLS handshake and a request's headers must arrive within 10 s, a
  connection idle between requests closes after 5 s, and the server closes every connection when
  it stops, so connections held open never keep an update or a restore waiting. The PC's own
  address (the POS window) is not limited. The socket is WebSocket only, with 16 KB messages, a
  10-second handshake and a rate limit on `resync`; a device has 16 live connections and 60
  handshakes a minute at most, counted after its token's signature and before the database is
  asked, and a connection that stops reading is cut off once 1,000 messages wait for it with none
  written since the last sweep (or 10,000 in any case). Pairing, sign-in and device
  authentication are rate-limited. In the flood test one host sent about 14,000 requests in 3 s
  and about 700 were answered (about 21,000 without the limits); meanwhile another device's event
  reached its screen in 12 ms and its request was answered in 2 ms (P8-03c2a, on a development
  Mac). A host that takes many addresses, or fills the Wi-Fi itself, is for the network: the
  staff network's isolation and the access points (§11).
- Code: `apps/server/src/http/flood-limits.ts` (`limitFloods`, `DEFAULT_SERVER_LIMITS`);
  `apps/server/src/common/flood-limits.ts` (`ConnectionGate`, `KeyedBuckets`);
  `apps/server/src/app.factory.ts` (`NEST_APP_OPTIONS`);
  `apps/server/src/realtime/realtime.gateway.ts` (`RealtimeGateway`, `DEFAULT_REALTIME_OPTIONS`);
  `apps/server/src/auth/rate-limiter.ts` (`RateLimiter`).
- Tests: `apps/server/test/integration/flood.int.test.ts` "closes a connection that never
  finishes its TLS handshake", "closes a connection whose request headers trickle in
  (Slowloris)", "closes a connection left idle after its answer", "holds an address to its open
  connections, while another address is served", "stops at once while a host holds connections
  that never send a request", "closes connections an address opens too fast, before their
  handshake", "answers 429 to an address sending requests too fast, and closes its connection",
  "keeps another device’s screen live and its requests answered within a second", "refuses a
  device’s connections over its limit, and no other device’s", "refuses a device that opens
  connections too fast, and no other device", "cuts off a connection that stops reading, while
  others get every event"; `apps/server/test/unit/flood-limits.test.ts` "never limits the PC’s
  own address when it is trusted"; `apps/server/test/integration/realtime.int.test.ts` "refuses
  plain HTTP polling; only WebSocket is offered", "replays on request, and limits how often a
  connection may ask".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated (P8-03c2a: nothing limited the connections, how fast they came or how long
  they stayed open, nor a device's sockets).

#### PC-D4 Decompression bombs in uploads

A manager's account uploads a photo or a menu spreadsheet that expands to gigabytes when read.

- Mitigation: photos are refused over 5 MB or too many pixels; spreadsheets are refused when their
  ZIP directory says they unpack too large, and the server inflates each part the reader needs
  itself, stopping a byte past the size the directory gave, so a directory that lies is caught
  too; the reader gets those parts again, stored, and inflates nothing (P8-03b2c).
- Code: `apps/server/src/photos/photo-processing.ts` (`PHOTO_MAX_PIXELS`);
  `apps/server/src/menu/import/zip-limits.ts` (`checkZipLimits`, `unpackWorkbook`).
- Tests: `apps/server/test/unit/photo-processing.test.ts` "refuses a file over 5 MB and a picture
  with too many pixels"; `apps/server/test/unit/menu-workbook.test.ts` "refuses archives that
  would unpack too large, and files that are not ZIPs", "inflates the workbook with a limit on
  what comes out, whatever the directory says", "gives the reader only the XML parts, stored, so
  it inflates nothing itself".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated (P8-03b2c: the reader inflated entries by their local headers without a
  limit).

#### PC-D5 A full disk or a stopped log archive

The data drive fills (photos, logs, the WAL archive) and PostgreSQL stops taking writes.

- Mitigation: the System page and alerts warn as the data drive fills and while the WAL cannot be
  archived.
- Code: `apps/server/src/system/storage-usage.ts`.
- Tests: `apps/server/test/unit/storage-usage.test.ts` "warns at the warning level and is critical
  at the critical one"; `apps/server/test/integration/continuous-backup.int.test.ts` "alerts while
  the log cannot be archived, and stops when it can".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

#### PC-D6 Attacks from guest Wi-Fi on a flat network

The restaurant runs guests and staff on one network, so a diner's phone reaches the server.

- Mitigation: the installer's firewall rules open the server's ports to the staff subnet when one
  is given, else to the local subnet; guests still need a paired device and a PIN for anything.
- Code: `infra/installer/windows/RestaurantPlatform.Setup.psm1` (`Get-RPFirewallRuleSpec`,
  `ConvertTo-RPRemoteAddress`).
- Tests: `infra/installer/windows/tests/Firewall.Tests.ps1` "opens them to the staff subnet only,
  when the installer is given one", "refuses what is not a staff subnet, or one as wide as the
  internet".
- Risk: likelihood Medium, impact Medium: Medium.
- Status: Partly mitigated. Plan: P8-03d by 2026-10-22: separate staff and guest networks become a
  checked item of the site checklist and the installation runbook (SEC-008), with the staff subnet
  given to the installer.

#### PC-D7 Ransomware or a dead disk

Ransomware encrypts the PC, or its disk dies, in the middle of a business day.

- Mitigation: nightly encrypted backups to two places and the cloud, the continuous WAL archive,
  and a measured restore to a new PC.
- Code: `apps/server/src/backups/backup.service.ts` (`BackupService`).
- Tests: `apps/server/test/integration/restore.int.test.ts` "backs up, loses the PC, and restores
  with the recovery key (RTO and RPO measured)".
- Risk: likelihood Low, impact High: Medium.
- Status: Partly mitigated. Plan: P8-03e by 2026-10-24: the incident response plan's ransomware
  playbook; the restore rehearsal on a real PC is manual task 25.

### Elevation of privilege

#### PC-E1 An endpoint without an access check

A new endpoint is added without a permission check, or with a wider one than the matrix gives,
and anyone on the LAN can call it.

- Mitigation: every route declares its access and the guard refuses one that does not; the
  registry, the controllers and the matrix are compared on every build, and the sweep calls every
  endpoint the way an attacker would.
- Code: `apps/server/src/auth/permission.guard.ts` (`PermissionGuard.canActivate`).
- Tests: `apps/server/test/integration/auth-guard.int.test.ts` "matches the controllers: same
  routes, each with the declared access", "every capability row of the permission matrix";
  `apps/server/test/integration/authorisation-sweep.int.test.ts` "covers the whole registry, and
  only the reviewed endpoints are open to anyone", "refuses each role what".
- Risk: likelihood Low, impact High: Medium.
- Status: Mitigated.

#### PC-E2 A Windows administrator on the PC

Anyone with an administrator account on the PC, often the account the POS runs under in a small
restaurant, can unprotect every DPAPI secret, reach the database superuser, disable the triggers,
rewrite the chain and forge tokens.

- Mitigation: none in software can stop an administrator; the controls are who holds the account.
- Code: `apps/server/src/auth/dpapi.ts`.
- Tests: none, an administrator holds every key on the PC by design; the controls are procedures.
- Risk: likelihood Medium, impact High: High.
- Status: Not mitigated. Plan: P8-03d by 2026-10-22: the CIS checklist for the PC and the
  installation runbook: daily work under a standard Windows account with the POS window, the
  administrator's password kept by the Owner, BitLocker on (PC-I5).

#### PC-E3 Staff powers from a table tablet or a kitchen screen

A diner at a table tablet, or anyone at a kitchen screen in station mode, reaches what only
signed-in staff may do.

- Mitigation: sessions exist only on staff devices; a tablet acts for its own table only; a kitchen
  screen in station mode reaches only its stations' endpoints.
- Code: `apps/server/src/auth/session.service.ts` (`SessionService`);
  `apps/server/src/auth/permission.guard.ts` (`PermissionGuard`).
- Tests: `apps/server/test/integration/authorisation-sweep.int.test.ts` "gives a session on a
  table tablet nothing, however it was made", "refuses a PIN or Owner sign-in on a table tablet or
  a pager, and counts no attempt", "lets a kitchen screen with nobody signed in reach only its
  station"; `apps/server/test/integration/tablet.int.test.ts` "still refuses the tablet another
  table".
- Risk: likelihood Low, impact High: Medium.
- Status: Mitigated.

#### PC-E4 The Owner's powers without the Owner

A manager, or someone with the Owner's PIN, changes tax groups, invoice series or purges data.

- Mitigation: Owner-only actions need a fresh password and authenticator code (5 minutes), each
  code used once; recovery codes work once.
- Code: `apps/server/src/auth/step-up.ts` (`hasFreshStepUp`); `apps/server/src/auth/auth.service.ts`
  (`verifyOwnerSecrets`).
- Tests: `apps/server/test/integration/auth-owner.int.test.ts` "requires a fresh password + TOTP
  step-up, valid for 5 minutes", "accepts each recovery code once";
  `apps/server/test/unit/auth-primitives.test.ts` "accepts the current and adjacent steps, and
  never the same step twice".
- Risk: likelihood Low, impact High: Medium.
- Status: Mitigated.

#### PC-E5 Approving one's own override

A manager approves their own void, or a cashier approves with another cashier's PIN.

- Mitigation: the approver must be a manager and not the person asking.
- Code: `apps/server/src/auth/auth.service.ts` (`grantOverride`).
- Tests: `apps/server/test/integration/auth-guard.int.test.ts` "refuses approvers who are not
  managers, the requester themselves and wrong PINs".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

#### PC-E6 SQL injection

Text in a request, a file or a relay order reaches a query and changes what it does.

- Mitigation: queries go through Prisma or tagged templates with bound values; the one query built
  from text (the archive) builds it from a constant list of tables, and identifiers in set-up SQL
  are checked.
- Code: `apps/server/src/lifecycle/archive.service.ts` (`queryRawUnsafe`);
  `apps/server/src/lifecycle/year-records.ts` (`YEAR_TABLES`);
  `apps/server/src/installation/database-setup.ts` (`identifier`).
- Tests: `apps/server/test/integration/installation-database.int.test.ts` "gives the server's
  login only what it needs"; `apps/server/test/integration/errors.int.test.ts` "validates bodies
  against contracts and rejects client prices".
- Risk: likelihood Low, impact High: Medium.
- Status: Mitigated.
