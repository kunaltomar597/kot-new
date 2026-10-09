# Threat model: The Vendor Control Plane

The vendor's cloud service (`apps/control-plane`) and its web app (`apps/control-plane-web`): vendor
staff with their roles, restaurant PCs that enrol and send signed requests, and what the vendor
holds for every restaurant (licences, releases, cloud backups and the escrowed keys, diagnostics,
remote settings, digital bills, AI menu reading). Written in P8-03b (2026-10-10). Related:
[ADR-0012](../../adr/0012-control-plane-installation-identity.md),
[authorisation.md](../authorisation.md) "The Vendor Control Plane",
`docs/runbooks/vendor-access-policy.md`.

## Scope

- Vendor staff: accounts, passwords, authenticators, roles and capabilities, sessions, the
  quarterly access review; the web app; the admin CLI.
- Restaurant PCs: enrolment with a one-time code, Ed25519-signed requests with a time window and a
  nonce, heartbeats and what their answers carry.
- Per restaurant: licences, releases and rollouts, cloud backups and key escrow, diagnostics bundles,
  remote settings, the QR relay credential, digital bills, AI menu reading, support notes.
- The audit log, rate limits, configuration and secrets.

## Assets

- Restaurants, their installations, contacts and subscriptions.
- Vendor accounts: Argon2id password hashes peppered with the Control Plane's key, authenticator
  secrets sealed with AES-GCM, session tokens stored as SHA-256.
- Each installation's public key; the wrapped backup keys and the escrow key in the KMS; the
  encrypted backups in S3.
- Diagnostics bundles; sealed relay credentials; the licence-signing key; the AI, WhatsApp, S3 and
  KMS credentials.
- The audit log of everything vendor staff and PCs do.

## Entry points

- `/v1/vendor/*` with a vendor session.
- The installation endpoints, each request signed by an enrolled PC: heartbeats, updates, cloud
  backups, escrow, diagnostics, menu extractions, digital bills.
- Public endpoints: health, enrolment, vendor sign-in and set-up, cloud restores, a digital bill's
  page, and in development only the object store's signed addresses.
- The web app's files, and the admin CLI, which talks to the database directly.

## Trust boundaries

1. The internet ↔ the load balancer ↔ the Control Plane.
2. The Control Plane ↔ PostgreSQL (TLS outside development).
3. The Control Plane ↔ S3 and the KMS in India, the AI provider, WhatsApp, the alert webhook and
   the error service.
4. A vendor's browser ↔ the Control Plane.
5. A restaurant PC ↔ the Control Plane.
6. One restaurant's data ↔ another's, in one database.

## Data flows

1. A PC sends a heartbeat; the answer carries its licence, pushed settings, the escrow offer,
   restore notices, its relay credential and release offers.
2. A PC uploads backup parts to presigned S3 addresses; a restore tool trades a one-time code for
   the backup key, wrapped for the tool's own key, and the download addresses.
3. A PC uploads a diagnostics bundle a manager allowed; Support opens it.
4. Every vendor change is audited in the same transaction.

## Threats

### Spoofing

#### CP-S1 Guessing or stuffing vendor passwords

Someone tries leaked passwords against vendor accounts, or many guesses at once against one.

- Mitigation: sign-in needs the password and the authenticator; five failures lock the account for
  15 minutes; 20 tries per 15 minutes per address; unknown e-mails take the same time; passwords of
  12 characters or more. The failure count is read before it is written, so guesses sent in
  parallel get more than five tries, and an account that is disabled or not set up answers
  differently.
- Code: `apps/control-plane/src/vendor/vendor-auth.service.ts` (`VendorAuthService.signIn`,
  `spendHashTime`); `apps/control-plane/src/auth/rate-limiter.ts` (`RateLimiter`);
  `packages/contracts/src/control-plane/vendor.ts` (`Password`).
- Tests: `apps/control-plane/test/integration/vendor-staff.int.test.ts` "signs in only with email,
  password and the authenticator", "never accepts the same code twice, and locks after five
  failures".
- Risk: likelihood Low, impact High: Medium.
- Status: Partly mitigated. Plan: P8-03b4 by 2026-10-17: the failure count and the code's step
  updated atomically, and one answer for unknown, disabled and wrong.

#### CP-S2 A stolen vendor session

A vendor's session is taken from their browser (script in the web app, a laptop left open).

- Mitigation: sessions last 8 hours, or 30 minutes unused; the token is kept in `sessionStorage`
  and sent as a header (no cookies, no CSRF); the web app's CSP allows only its own scripts;
  disabling or resetting an account ends its sessions, and the role is read again on every
  request. Sensitive actions do not ask for the authenticator again.
- Code: `apps/control-plane/src/vendor/vendor-auth.service.ts` (`authenticate`);
  `apps/control-plane-web/src/app/session.ts`; `apps/control-plane/src/http/web-static.ts`
  (`WEB_SECURITY_HEADERS`).
- Tests: `apps/control-plane/test/integration/vendor-staff.int.test.ts` "ends a session on
  sign-out, and after 30 minutes without use"; `apps/control-plane/test/integration/web-app.int.test.ts`
  "serves the app with strict security headers, and its routes from the shell";
  `apps/control-plane-web/test/cp-api.test.ts` "turns a refusal into an error with its code, and a
  401 ends the session".
- Risk: likelihood Low, impact High: Medium.
- Status: Partly mitigated. Plan: P8-03d by 2026-10-22: the authenticator asked again before
  restoring a restaurant's data, managing staff, publishing releases and pushing settings (ASVS
  L2's re-authentication).

#### CP-S3 A stolen installation key, or a PC posing as another restaurant

Someone with one PC's key acts as that PC, or uses its signature to reach another restaurant's
data.

- Mitigation: the installation and its restaurant come from the database row behind the
  signature, never from the request; every object is looked up within that installation or
  restaurant; a revoked PC is refused everywhere; moving to a new PC retires the old key.
- Code: `apps/control-plane/src/auth/installation.guard.ts` (`InstallationGuard`);
  `apps/control-plane/src/cloud-backups/cloud-backups.service.ts` (`CloudBackupsService.complete`).
- Tests: `apps/control-plane/test/integration/signed-requests.int.test.ts` "refuses a revoked
  installation and one that never enrolled";
  `apps/control-plane/test/integration/authorisation-sweep.int.test.ts` "refuses a revoked
  restaurant PC on every endpoint of its own";
  `apps/control-plane/test/integration/menu-extractions.int.test.ts` "keeps a draft to its own
  restaurant"; `apps/control-plane/test/integration/vendor-fleet.int.test.ts` "moves an
  installation to a new PC: the old key is refused once it activates".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

#### CP-S4 A guessed or stolen enrolment code

Someone enrols their own machine as a restaurant's PC.

- Mitigation: codes are 80 bits, valid 7 days, stored as SHA-256 and used once; enrolment needs
  proof of the key it registers; 10 tries a minute per address.
- Code: `apps/control-plane/src/installations/enrolment-code.ts` (`generateEnrolmentCode`);
  `apps/control-plane/src/installations/installations.service.ts` (`InstallationsService.enrol`).
- Tests: `apps/control-plane/test/integration/enrolment.int.test.ts` "refuses a proof made with
  another key, an unknown or expired code, or a non-Ed25519 key", "refuses the 11th attempt within
  a minute from one address"; `apps/control-plane/test/unit/enrolment-code.test.ts` "are stored as
  a SHA-256 digest, never as the code".
- Risk: likelihood Low, impact High: Medium.
- Status: Mitigated.

### Tampering

#### CP-T1 Replaying or changing a signed request

Someone records a PC's request and sends it again, or changes its body.

- Mitigation: the signature covers the method, the path with its query, the time, a nonce and the
  body's SHA-256; requests more than 5 minutes out are refused and each nonce is kept until its
  window has passed.
- Code: `packages/contracts/src/control-plane/signing.ts` (`signedRequestMessage`);
  `apps/control-plane/src/auth/nonce-store.ts` (`NonceStore`).
- Tests: `apps/control-plane/test/integration/signed-requests.int.test.ts` "refuses requests
  without a valid signature, deny by default", "refuses a replayed request (same nonce)", "purges
  nonces once their window has passed", "tells an installation with a wrong clock the server
  time".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

#### CP-T2 A compromised PC deleting its own cloud backups

Ransomware on a restaurant PC, or someone with its key, uploads tiny backups dated in the future;
retention then keeps those and deletes every real one.

- Mitigation: retention keeps the newest backup of each of the last 30 days and 12 months, by the
  date the PC sends, which is not checked. The bucket has no versioning or object lock yet.
- Code: `apps/control-plane/src/cloud-backups/cloud-backups.service.ts` (`CloudBackupsService`,
  `prune`); `packages/domain/src/backups.ts` (`backupsToRemove`).
- Tests: `apps/control-plane/test/integration/cloud-backups.int.test.ts` "takes a backup in parts
  and stores it byte for byte".
- Risk: likelihood Medium, impact High: High.
- Status: Not mitigated. Plan: P8-03b4 by 2026-10-17: a backup's date must be close to the Control
  Plane's clock, retention goes by the times the Control Plane recorded, and a PC may complete only
  a few backups a day; the bucket's object lock joins manual task 26.

#### CP-T3 Harmful settings or releases from a vendor staffer

A malicious or careless vendor staff member pushes settings or a release that hurt restaurants.

- Mitigation: only settings on an allow-list can be pushed, checked against each setting's rules
  at the Control Plane and again on the PC; only the Super Admin pushes, with a reason, audited; a
  release must be signed by the vendor's certificate to install.
- Code: `packages/contracts/src/settings.ts` (`REMOTE_SETTING_KEYS`);
  `apps/control-plane/src/remote-settings/remote-settings.service.ts` (`RemoteSettingsService`);
  `apps/server/src/settings/settings.service.ts` (`applyVendorSettings`).
- Tests: `apps/control-plane/test/integration/remote-settings.int.test.ts` "lets only the Super
  Admin set values the settings allow, with a reason";
  `apps/server/test/integration/settings.int.test.ts` "applies what the vendor pushes, ignoring keys
  and values it may not set"; `apps/control-plane/test/integration/heartbeats.int.test.ts`
  "refuses a duplicate or unsafe release and audits each publication".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

#### CP-T4 Instructions hidden in a menu image

A menu photo carries text that tells the AI model to do something else (prompt injection).

- Mitigation: the model has one tool, which it must call, and nothing else; its answer is checked
  against the draft's schema and capped; a person checks every dish before anything is imported.
- Code: `apps/control-plane/src/menu-import/menu-reading.ts` (`draftFromReading`).
- Tests: `apps/control-plane/test/unit/menu-reading.test.ts` "sends every file and forces the
  record_menu tool, with the key in a header only", "keeps an overlong reading within the draft".
- Risk: likelihood Low, impact Low: Low.
- Status: Mitigated.

#### CP-T5 Editing the vendor's audit log

Someone with database access changes or removes audit entries to hide what they did.

- Mitigation: triggers refuse updates, deletes and truncation, and entries are written in the
  change's own transaction. The database owner can drop the triggers; there is no chain and no
  copy elsewhere.
- Code: `apps/control-plane/prisma/migrations/20260926100000_control_plane_v0/migration.sql`
  (`cp_audit_log_guard`); `apps/control-plane/src/audit/audit.service.ts` (`AuditService`).
- Tests: `apps/control-plane/test/integration/admin.int.test.ts` "keeps the audit log
  append-only".
- Risk: likelihood Low, impact Medium: Low.
- Status: Partly mitigated. Plan: P8-03d by 2026-10-22: the audit log copied to the hosting
  provider's log store in India and kept 180 days (SEC-015).

### Repudiation

#### CP-R1 Vendor staff deny an action

A vendor staff member denies opening a restaurant's data or changing it.

- Mitigation: every change records the staff member with a reason, including the access review,
  restore codes (with how the Owner was verified) and opening a diagnostics bundle. Other reads
  are not audited.
- Code: `apps/control-plane/src/audit/audit.service.ts` (`AuditService`).
- Tests: `apps/control-plane/test/integration/vendor-staff.int.test.ts` "records the quarterly
  access review, disabling every account not kept";
  `apps/control-plane/test/integration/diagnostics.int.test.ts` "lists bundles for every role, and
  opens one only for Support, audited"; `apps/control-plane/test/integration/key-escrow.int.test.ts`
  "issues a code only for Support, only with something to restore, and tells the Owner".
- Risk: likelihood Low, impact Medium: Low.
- Status: Partly mitigated. Plan: P8-03d by 2026-10-22: decide which reads of a restaurant's data
  are audited (SEC-018's "all production access").

#### CP-R2 Changes through the admin CLI

The admin CLI talks to the database directly; its actor is whatever name the operator gives.

- Mitigation: the CLI runs only from the deployment pipeline or the operator host, under the
  hosting provider's audit (ADR-0012, the access policy); its changes are audited with the name.
- Code: `apps/control-plane/src/cli.ts` (`actorFrom`).
- Tests: `apps/control-plane/test/integration/admin.int.test.ts` "creates a tenant and
  installation, publishes a release and revokes, all audited".
- Risk: likelihood Low, impact High: Medium.
- Status: Partly mitigated. Plan: P8-03d by 2026-10-22: where the CLI may run, who may run it and
  how the host records it, in the access policy's checklist.

### Information disclosure

#### CP-I1 Every restaurant's backups opened

Someone at the vendor, or who took the Control Plane, restores a restaurant's data.

- Mitigation: backups are encrypted on the PC; the Control Plane holds only the key wrapped for its
  KMS; a restore needs a one-time 80-bit code, valid 24 hours, 5 tries a minute, issued by Support
  after verifying the Owner, and the Owner is told; the key is released wrapped for the restore
  tool's own key; storage is in India. Support alone can issue a code.
- Code: `apps/control-plane/src/cloud-backups/backup-escrow.service.ts` (`BackupEscrowService`,
  `issueCode`); `apps/control-plane/src/cloud-backups/escrow-keys.ts`.
- Tests: `apps/control-plane/test/integration/key-escrow.int.test.ts` "stores only the wrapped
  key", "releases the key, wrapped for the tool alone, once, with the backups to download",
  "refuses an expired code, and too many attempts from one address";
  `apps/control-plane/test/unit/escrow-keys.test.ts` "keeps the key in the KMS, in India, outside
  development"; `apps/control-plane/test/unit/cloud-backup-storage.test.ts` "keeps them in S3 in
  India in production".
- Risk: likelihood Low, impact High: Medium.
- Status: Partly mitigated. Accepted: the escrow policy (OI-10) has Support release a key after
  verifying the Owner, and the KMS records every unwrap (manual task 27); whether a second person
  must approve is a question for the Business Owner (PROGRESS.md).

#### CP-I2 Personal data in diagnostics bundles

Diagnostics bundles hold restaurants' logs and stay at the vendor for ever.

- Mitigation: the PC scrubs the bundle and a manager allows it; lists show only metadata; opening
  one needs Support and is audited; bundles are limited to 4 MB. They are never deleted, though
  the access policy promises 30 days.
- Code: `apps/control-plane/src/diagnostics/diagnostics.service.ts` (`DiagnosticsService`).
- Tests: `apps/control-plane/test/integration/diagnostics.int.test.ts` "lists bundles for every
  role, and opens one only for Support, audited", "refuses a bundle larger than 4 MB, and one that
  is not a bundle".
- Risk: likelihood Low, impact Medium: Low.
- Status: Partly mitigated. Plan: P8-03b4 by 2026-10-17: bundles are deleted after 30 days,
  audited.

#### CP-I3 Secrets and links in configuration and logs

A secret travels in clear, or a digital bill's private link is written to the logs.

- Mitigation: configuration errors name the setting without its value; the database needs TLS and
  the Control Plane its own key outside development; the request log redacts the authorisation
  and signature headers; error reports are scrubbed. The AI, WhatsApp and error services may be
  `http:` in production, and the request log writes a bill's link.
- Code: `apps/control-plane/src/config/cp-config.ts` (`loadConfig`);
  `apps/control-plane/src/app.module.ts` (`REDACTED`).
- Tests: `apps/control-plane/test/unit/config.test.ts` "names wrong settings without echoing their
  values", "needs its own secret key in staging and production", "needs TLS to the database in
  staging and production"; `apps/control-plane/test/integration/error-reporting.int.test.ts`
  "reports an unexpected error, scrubbed, and answers without internals".
- Risk: likelihood Low, impact Medium: Low.
- Status: Partly mitigated. Plan: P8-03b4 by 2026-10-17: https for every outside service in
  production, and the tokens in bill and grant addresses masked in the request log.

#### CP-I4 One restaurant reading another's data

A restaurant's PC, or a mistake in a query, reaches another restaurant's rows in the shared
database.

- Mitigation: every installation endpoint scopes its query to the PC's installation and restaurant,
  and the sweep keeps PCs and vendor staff to their own endpoints. SEC-005 asks for Row-Level
  Security on every Control Plane table; there is none, and no ADR records the choice.
- Code: `apps/control-plane/src/auth/installation.guard.ts` (`InstallationGuard`).
- Tests: `apps/control-plane/test/integration/menu-extractions.int.test.ts` "keeps a draft to its
  own restaurant"; `apps/control-plane/test/integration/authorisation-sweep.int.test.ts` "keeps
  restaurant PCs and vendor staff to their own endpoints".
- Risk: likelihood Low, impact High: Medium.
- Status: Partly mitigated. Plan: P8-03b4 by 2026-10-17: an ADR for isolation in the application
  instead of RLS, and a test that calls every PC endpoint with another PC's ids.

#### CP-I5 Requests to an address a caller chooses

A caller makes the Control Plane fetch an address inside the cloud (SSRF).

- Mitigation: no endpoint takes an address; every outside service's address is configuration.
- Code: `apps/control-plane/src/config/cp-config.ts` (`loadConfig`).
- Tests: none, there is no request to an address a caller gives; P8-03c's scan confirms it.
- Risk: likelihood Low, impact Low: Low.
- Status: Mitigated.

### Denial of service

#### CP-D1 Flooding the Control Plane

Someone floods the public endpoints, or a PC uploads without end, to stop the service or run up its
costs.

- Mitigation: bodies are limited (64 kB, 5 MB for diagnostics, 28 MB for menus); AI reading and
  digital bills have daily limits per restaurant; the Control Plane sets the heartbeat interval.
  Rate limits are in each instance's memory, and nothing limits how often a PC uploads.
- Code: `apps/control-plane/src/app.factory.ts`; `apps/control-plane/src/auth/rate-limiter.ts`
  (`RateLimiter`).
- Tests: `apps/control-plane/test/unit/error-mapping.test.ts` "answers bad JSON, oversized bodies,
  unknown routes"; `apps/control-plane/test/integration/menu-extractions.int.test.ts` "holds each
  restaurant to the daily number, and is off without a key";
  `apps/control-plane/test/integration/digital-bills.int.test.ts` "refuses channels the vendor has
  not set up, and more bills than the day allows".
- Risk: likelihood Low, impact Medium: Low.
- Status: Partly mitigated. Plan: P8-03c by 2026-10-19: rate limits and a firewall at the edge in
  front of the Control Plane, checked by the DAST run.

#### CP-D2 Locking vendor accounts

Someone who knows a vendor's e-mail locks the account again and again.

- Mitigation: a lock lasts 15 minutes; other staff, and a Super Admin, keep working.
- Code: `apps/control-plane/src/vendor/vendor-auth.service.ts` (`VendorAuthService`).
- Tests: `apps/control-plane/test/integration/vendor-staff.int.test.ts` "never accepts the same code
  twice, and locks after five failures".
- Risk: likelihood Low, impact Low: Low.
- Status: Accepted: the lock is what stops password guessing (CP-S1); a few vendor staff can wait
  15 minutes.

#### CP-D3 Going past the daily AI limit

A restaurant sends many menu readings at once and all of them pass the daily limit's count.

- Mitigation: the count is taken outside the transaction that creates the reading.
- Code: `apps/control-plane/src/menu-import/menu-extractions.service.ts`
  (`MenuExtractionsService`).
- Tests: `apps/control-plane/test/integration/menu-extractions.int.test.ts` "holds each restaurant
  to the daily number, and is off without a key".
- Risk: likelihood Low, impact Low: Low.
- Status: Partly mitigated. Plan: P8-03b4 by 2026-10-17: the count under a lock per restaurant.

### Elevation of privilege

#### CP-E1 A vendor role doing more than it may

A Support or Sales account reaches what only a Super Admin may do.

- Mitigation: every endpoint is public with a reason, signed by a PC, or needs a capability the
  role has (`vendorMay`), checked by a global guard with the role read live.
- Code: `apps/control-plane/src/vendor/vendor.guard.ts` (`VendorGuard`);
  `packages/contracts/src/control-plane/vendor.ts` (`vendorMay`).
- Tests: `apps/control-plane/test/integration/authorisation-sweep.int.test.ts` "refuses each vendor
  role what its capabilities do not allow", "only the reviewed endpoints are open to anyone",
  "refuses a signed-out vendor session everywhere";
  `apps/control-plane/test/integration/vendor-staff.int.test.ts` "lets each role do only what it is
  for".
- Risk: likelihood Low, impact High: Medium.
- Status: Mitigated.

#### CP-E2 Misusing the public endpoints

Someone uses a public endpoint (a bill's page, a restore, the development object store) to reach
what it does not show.

- Mitigation: each has its own credential (a signed link, a one-time code, an HMAC grant) and a
  rate limit; the development object store answers 404 outside development.
- Code: `apps/control-plane/src/cloud-backups/local-object-store.ts`.
- Tests: `apps/control-plane/test/unit/cloud-backup-storage.test.ts` "refuses a changed, foreign or
  expired grant"; `apps/control-plane/test/integration/digital-bills.int.test.ts` "opens nothing
  without a signature or with a wrong link".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

#### CP-E3 One Super Admin taking over another

A Super Admin resets another Super Admin's account and gets the set-up link, so they can sign in as
them.

- Mitigation: nobody resets their own account or removes the last Super Admin; the reset is
  audited. The set-up link goes back to the person who reset it.
- Code: `apps/control-plane/src/vendor/vendor-auth.service.ts` (`reset`).
- Tests: `apps/control-plane/test/integration/vendor-staff.int.test.ts` "adds, changes, disables
  and resets accounts, never oneself or the last Super Admin".
- Risk: likelihood Low, impact High: Medium.
- Status: Partly mitigated. Plan: P8-03b4 by 2026-10-17: resetting a Super Admin needs a second
  Super Admin's approval.
