# OWASP ASVS Level 2, Top 10 and API Top 10

BRD §8.1: web apps and APIs (the local server, the web console, the QR site, the relay functions
and the Control Plane) follow OWASP ASVS Level 2, the OWASP Top 10 and the OWASP API Security Top 10. Written in P8-03d2b2d (2026-10-11).

How to read it: ASVS 4.0.3 has about 280 requirements in 14 chapters. Each row below is one
control group of a chapter (a section, or the part of it that applies), with its status and the
evidence: files and folders that implement or test it, or the threats in
[the threat models](../threat-models/README.md) that analyse it. `pnpm security:checklists`
checks every file and threat named, so a renamed file fails CI. Statuses: **Met**; **N/A** with the
reason; **Finding** with a plan. See [README](README.md) for the rules.

## V1 Architecture, design and threat modelling

| ID       | Control                                                                                   | Status | Evidence                                                                                                             | Notes                                                                               |
| -------- | ----------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| ASVS-1.1 | A secure development lifecycle: threat models, security requirements, reviewed changes    | Met    | `docs/security/threat-models/README.md`, `.github/pull_request_template.md`, `docs/build/CONVENTIONS.md`             | Eight STRIDE models, kept current by `pnpm security:threats`.                       |
| ASVS-1.2 | Components, trust boundaries and data flows are documented                                | Met    | `docs/ARCHITECTURE.md`, `docs/security/threat-models/local-server-and-lan.md`, `docs/adr`                            | Every model has its trust boundaries and data flows.                                |
| ASVS-1.3 | Authorisation is one central mechanism, deny by default, on every surface                 | Met    | `docs/security/authorisation.md`, `apps/server/src/auth/permission.guard.ts`                                         | A test fails when an endpoint lacks its permission, devices or reason to be public. |
| ASVS-1.4 | Security controls live on the server, not in the client                                   | Met    | `packages/domain/src`, `packages/contracts/src`                                                                      | The server recomputes prices and checks permissions (ORD-014, AUTH-010).            |
| ASVS-1.5 | Sensitive data is classified and its protection defined                                   | Met    | `docs/runbooks/data-lifecycle.md`, `docs/security/threat-models/local-server-and-lan.md`                             | Personal data, money records and secrets each have a rule.                          |
| ASVS-1.6 | Cryptographic keys are managed: generated, stored, rotated and destroyed by a defined way | Met    | `apps/server/src/auth/secret-store.ts`, `apps/server/src/tls/tls-store.ts`, `apps/server/src/backups/backup-keys.ts` | DPAPI on the PC, the CA and leaf renewal, backup keys with recovery.                |

## V2 Authentication

| ID       | Control                                                                                     | Status | Evidence                                                                                                                                    | Notes                                                                                         |
| -------- | ------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| ASVS-2.1 | Passwords and PINs have a minimum strength and easy ones are refused                        | Met    | `apps/server/src/auth/auth-settings.ts`, `packages/domain/src`                                                                              | `auth.refuseEasyPins`; PINs are short by design (BRD AUTH-002), so lockouts carry the weight. |
| ASVS-2.2 | General authenticator security: lockout, throttling and no default credentials              | Met    | `apps/server/src/auth/sign-in-lockouts.ts`, `apps/server/src/auth/rate-limiter.ts`, `PC-S5`                                                 | Budgets per account, per device and per address; locked sign-ins raise an alert.              |
| ASVS-2.3 | Authenticator lifecycle: PINs set, reset and recovered by a person with authority           | Met    | `apps/server/src/staff`, `docs/runbooks/vendor-access-policy.md`                                                                            | Staff changes audited; managers kept to the Owner with a fresh second factor.                 |
| ASVS-2.4 | Credentials are stored with a salted, slow hash and a secret pepper                         | Met    | `apps/server/src/auth/credential-hasher.ts`, `apps/server/src/auth/secret-store.ts`                                                         | Argon2id (19 MiB, 2 passes) with a pepper held outside the database.                          |
| ASVS-2.5 | Out-of-band and multi-factor: the vendor's staff and the Owner use a second factor          | Met    | `apps/server/src/auth/step-up.ts`, `apps/control-plane/src/auth`, `CP-S2`                                                                   | Authenticator codes; ten sensitive Control Plane actions ask again (P8-03d2b1).               |
| ASVS-2.6 | Service authentication: devices and installations prove who they are with keys              | Met    | `apps/server/src/auth/device-token.service.ts`, `apps/server/src/auth/device-keys.ts`, `apps/control-plane/src/auth/ed25519.ts`, `docs/adr` | Device keys held in the Android Keystore; signed requests to the Control Plane (ADR-0012).    |
| ASVS-2.7 | Cryptographic verifiers resist theft: pager and device secrets are random and stored hashed | Met    | `apps/server/src/pagers/pagers.service.ts`, `apps/server/src/auth/tokens.ts`                                                                | Random secrets, shown once, kept as hashes.                                                   |

## V3 Session management

| ID       | Control                                               | Status | Evidence                                                                                    | Notes                                                                                           |
| -------- | ----------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| ASVS-3.1 | Session tokens are random, short-lived and revocable  | Met    | `apps/server/src/auth/session.service.ts`, `apps/server/src/auth/tokens.ts`                 | Sessions end on deactivation, and the socket is closed on revocation.                           |
| ASVS-3.2 | Sessions end on inactivity and on sign-out            | Met    | `apps/server/src/auth/activity.ts`, `packages/mobile-core/src/device-session.ts`            | Idle limits per device type (`x-rp-idle-seconds`), also on the waiter phone.                    |
| ASVS-3.3 | Cookies carry the Secure, HttpOnly and SameSite flags | N/A    |                                                                                             | The apps use bearer tokens held in memory or the Keystore; the platform sets no session cookie. |
| ASVS-3.4 | Tokens are not exposed in URLs or logs                | Met    | `apps/server/src/logging/logging.module.ts`, `apps/control-plane/src/http/log-redaction.ts` | Tokens travel in headers; the log redaction is tested.                                          |

## V4 Access control

| ID       | Control                                                                                                          | Status | Evidence                                                                                                        | Notes                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| ASVS-4.1 | Access is enforced on a trusted service layer, deny by default                                                   | Met    | `docs/security/authorisation.md`, `apps/server/src/auth/permission.guard.ts`, `packages/domain/src`             | The permission matrix is in `@rp/domain`.                             |
| ASVS-4.2 | Object-level checks: a tablet acts only on its own table, a waiter on permitted tables, a pager on its own topic | Met    | `docs/security/authorisation.md`, `apps/server/src/realtime/rooms.ts`, `apps/server/src/pagers/pager-broker.ts` | MQTT ACLs per pager; socket rooms by role and device.                 |
| ASVS-4.3 | Administrative interfaces are separate and protected by more than one factor                                     | Met    | `apps/control-plane/src/admin`, `apps/control-plane/src/auth`, `CP-E1`                                          | Vendor staff only, second factor, resets by two Super Admins.         |
| ASVS-4.4 | Manager overrides and approvals are bound to their record                                                        | Met    | `apps/server/src/auth/auth.service.ts`, `packages/domain/src`                                                   | An approval is for one kind of record (P8-03b2a).                     |
| ASVS-4.5 | Cross-tenant access is impossible                                                                                | Met    | `infra/supabase/test/isolation.test.ts`, `CP-E2`, `RELAY-E1`                                                    | Row-Level Security on the relay; tenant scoping on the Control Plane. |

## V5 Validation, sanitization and encoding

| ID       | Control                                                               | Status | Evidence                                                                                                                 | Notes                                                                        |
| -------- | --------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| ASVS-5.1 | Every input is validated against a schema; unknown fields are refused | Met    | `apps/server/src/validation/zod-validation.pipe.ts`, `packages/contracts/src`, `apps/control-plane/src/http/zod.pipe.ts` | Zod contracts shared by clients and server.                                  |
| ASVS-5.2 | Output encoding and sanitisation: React escapes, no raw HTML sinks    | Met    | `apps/console/src`, `apps/qr-menu/src`, `docs/security/dast.md`                                                          | CSPs with nonces and Trusted Types on the QR site (P8-03c1).                 |
| ASVS-5.3 | Injection: queries are parameterised, no shell built from input       | Met    | `apps/server/src/database`, `apps/server/src/backups/pg-tools.ts`                                                        | Prisma with parameters; tools called with argument lists, not shell strings. |
| ASVS-5.4 | Memory, string and deserialisation safety                             | Met    | `apps/server/src/http/body-limits.ts`, `apps/server/src/backups/tar.ts`                                                  | Body size limits; archive paths with `..` or absolute paths refused.         |
| ASVS-5.5 | Server-side request forgery is closed                                 | Met    | `apps/server/src/cloud`, `apps/server/src/relay`                                                                         | The server calls only its configured Control Plane and relay hosts.          |

## V6 Stored cryptography

| ID       | Control                                                                    | Status | Evidence                                                                                                                 | Notes                                                  |
| -------- | -------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| ASVS-6.1 | Sensitive data at rest is encrypted: secrets in DPAPI, backups encrypted   | Met    | `apps/server/src/auth/dpapi.ts`, `apps/server/src/auth/secret-box.ts`, `apps/server/src/backups/backup-archive.ts`       | Backups are encrypted before they leave the PC.        |
| ASVS-6.2 | Approved algorithms only: Argon2id, AES-GCM, Ed25519, ECDSA P-256, SHA-256 | Met    | `apps/server/src/auth/credential-hasher.ts`, `apps/server/src/auth/secret-box.ts`, `packages/mobile-native/src/ecdsa.ts` | No custom cryptography.                                |
| ASVS-6.3 | Random values come from a cryptographically secure source                  | Met    | `apps/server/src/auth/tokens.ts`, `packages/mobile-native/src/random.ts`                                                 | `crypto.randomBytes` and the platform's secure random. |
| ASVS-6.4 | Secrets are not in source code or bundles                                  | Met    | `infra/ci/gitleaks.toml`, `.github/workflows/security.yml`                                                               | gitleaks on every PR and over the history (SEC-002).   |

## V7 Error handling and logging

| ID       | Control                                                                             | Status  | Evidence                                                                                    | Notes                                                                                                            |
| -------- | ----------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| ASVS-7.1 | Logs hold no secrets or personal data (SEC-010)                                     | Met     | `apps/server/src/logging/logging.module.ts`, `apps/control-plane/src/http/log-redaction.ts` | Redaction of tokens, PINs and contact details.                                                                   |
| ASVS-7.2 | Security events are logged with who, what and when; the audit log is tamper-evident | Met     | `apps/server/src/audit/audit-hash.ts`, `apps/server/src/audit/audit.service.ts`             | A hash chain, and no DELETE for the application's role (AUD-004).                                                |
| ASVS-7.3 | Errors give no stack traces or internals to callers                                 | Met     | `apps/server/src/errors/api-exception.filter.ts`, `apps/server/src/errors/error-mapping.ts` | Errors map to a fixed code and message with a correlation id.                                                    |
| ASVS-7.4 | The vendor's audit log is protected from edits by the host's operators              | Finding | `CP-T5`, `manual-tasks/34-control-plane-host-logs.md`                                       | Every entry is also a log line; the host's store needs the vendor's account. Plan: manual task 34 by 2026-11-30. |

## V8 Data protection

| ID       | Control                                                                     | Status  | Evidence                                                                                     | Notes                                                                                                  |
| -------- | --------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| ASVS-8.1 | Personal data is minimised, retained for a set time and erasable on request | Met     | `docs/runbooks/data-lifecycle.md`, `apps/server/src/digital-bills`, `packages/contracts/src` | DPDP: diner contact erasure reaches orders, bills and invoices (P8-03b2c).                             |
| ASVS-8.2 | Sensitive data is not cached by the client or kept in backups of the device | Met     | `apps/waiter-app/test`, `packages/mobile-core/src/storage.ts`                                | `allowBackup` off, tested against the manifests (P8-03d2a).                                            |
| ASVS-8.3 | Exports are audited and personal data in them is limited                    | Met     | `apps/server/src/reports`, `packages/domain/src`                                             | Stamped, audited CSV export (P1-13).                                                                   |
| ASVS-8.4 | The relay's own secrets and diners' privacy                                 | Finding | `RELAY-I3`, `RELAY-I4`, `manual-tasks/20-supabase-relay.md`                                  | The secret store and the privacy notice need the hosting accounts. Plan: manual task 20 by 2026-11-30. |

## V9 Communication

| ID       | Control                                          | Status | Evidence                                                                                                              | Notes                                                                 |
| -------- | ------------------------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| ASVS-9.1 | TLS 1.2+ for every connection; HSTS in the cloud | Met    | `apps/server/src/tls`, `apps/server/src/http/security-headers.ts`, `docs/runbooks/lan-tls.md`                         | HTTPS/WSS/MQTTS on the LAN with the installation's own CA (ADR-0011). |
| ASVS-9.2 | Certificates are validated; the apps pin the CA  | Met    | `packages/mobile-native/src/lan-trust.ts`, `packages/mobile-core/src/server-trust.ts`, `apps/desktop/src/security.ts` | CA pinned at pairing; the PC's shell pins it too.                     |
| ASVS-9.3 | The CA is name-constrained to the LAN            | Met    | `apps/server/src/tls/certificates.ts`, `PC-S4`                                                                        | P8-03d2b2c2.                                                          |

## V10 Malicious code

| ID        | Control                                                                           | Status  | Evidence                                                                                    | Notes                                                                         |
| --------- | --------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| ASVS-10.1 | No backdoors or undocumented time bombs; dependencies vetted                      | Met     | `.github/workflows/security.yml`, `infra/ci/check-licenses.mjs`, `.github/dependabot.yml`   | CodeQL, audit, dependency review, licence policy and SBOM.                    |
| ASVS-10.2 | Builds are reproducible-enough and signed; releases carry attestation and an SBOM | Met     | `infra/ci/release-manifest.mjs`, `apps/desktop/src/packaging/release-guard.ts`, `UPDATE-R3` | Signed in CI only, on `main`.                                                 |
| ASVS-10.3 | The running code is checked against the release's list of files                   | Met     | `apps/server/src/integrity/server-files.ts`, `LICENCE-T5`                                   | `CODE_MODIFIED` is reported (P8-03d2b2b2).                                    |
| ASVS-10.4 | Every change to `main` is reviewed by a second person                             | Finding | `UPDATE-T6`, `manual-tasks/README.md`                                                       | Branch protection needs a second reviewer. Plan: manual task 1 by 2026-10-17. |

## V11 Business logic

| ID        | Control                                                                   | Status | Evidence                                                                                | Notes                                                            |
| --------- | ------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| ASVS-11.1 | Business flows are sequenced and idempotent; retries create nothing twice | Met    | `apps/server/src/orders`, `packages/domain/src`                                         | Idempotency keys on orders (ORD-013); bill numbers never reused. |
| ASVS-11.2 | Limits and anti-automation: rate limits, anti-spam on public flows        | Met    | `apps/server/src/service-requests`, `infra/supabase/src/read-throttle.ts`, `infra/edge` | Service-request limits and the relay's per-table reads.          |
| ASVS-11.3 | Money rules cannot be bypassed: integer paise, server-side prices and tax | Met    | `packages/domain/src`, `apps/server/src/billing`, `apps/server/src/payments`            | Client-sent prices are refused by the contracts.                 |

## V12 Files and resources

| ID        | Control                                                     | Status | Evidence                                                                                | Notes                                                                                      |
| --------- | ----------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| ASVS-12.1 | Uploads are limited by size and type and re-encoded         | Met    | `apps/server/src/photos/photo-processing.ts`, `apps/server/src/menu/import`             | Images re-encoded; imports bounded (P8-03b2c).                                             |
| ASVS-12.2 | Stored files cannot be executed or fetched by path guessing | Met    | `apps/server/src/photos/photo-store.ts`, `infra/supabase/migrations`                    | Photos stored under generated ids, not names; the relay's bucket accepts image types only. |
| ASVS-12.3 | Downloaded files are checked: updates by signature and hash | Met    | `apps/server/src/updates/update-download.ts`, `apps/server/src/updates/authenticode.ts` | SHA-256 and Authenticode with a pinned signer and issuer.                                  |

## V13 API and web service

| ID        | Control                                                              | Status | Evidence                                                                                             | Notes                                                                                |
| --------- | -------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| ASVS-13.1 | A documented schema for every API; requests are validated against it | Met    | `docs/api`, `packages/contracts/src`                                                                 | OpenAPI and AsyncAPI generated from the route registry; `pnpm contracts:docs:check`. |
| ASVS-13.2 | REST and WebSocket methods are restricted and authenticated          | Met    | `apps/server/src/realtime/realtime.gateway.ts`, `docs/security/authorisation.md`                     | The socket checks the token, the room and the version.                               |
| ASVS-13.3 | Versioning and compatibility are controlled                          | Met    | `apps/server/src/http/client-version.ts`, `docs/api/compat`, `docs/runbooks/client-compatibility.md` | N-1 clients; the frozen contracts are checked by `pnpm contracts:compat`.            |

## V14 Configuration

| ID        | Control                                                            | Status  | Evidence                                                                                         | Notes                                                                                                          |
| --------- | ------------------------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| ASVS-14.1 | Builds are repeatable and dependencies are pinned                  | Met     | `.github/dependabot.yml`, `infra/ci/pinned-actions.test.mjs`                                     | Lockfile, Actions pinned to commits.                                                                           |
| ASVS-14.2 | Dependencies are scanned and kept current                          | Met     | `.github/workflows/security.yml`, `.github/dependabot.yml`                                       | Audit at high, weekly.                                                                                         |
| ASVS-14.3 | Security headers and a strict CSP                                  | Met     | `apps/server/src/http/security-headers.ts`, `apps/qr-menu/src/proxy.ts`, `docs/security/dast.md` | Verified by ZAP on four surfaces.                                                                              |
| ASVS-14.4 | HTTP security: limits on bodies, floods and connections            | Met     | `apps/server/src/http/body-limits.ts`, `apps/server/src/http/flood-limits.ts`, `PC-D3`           | Floods from the LAN (P8-03c2a).                                                                                |
| ASVS-14.5 | Cloud edges rate-limit and absorb floods                           | Finding | `infra/edge`, `CP-D1`, `RELAY-D4`, `manual-tasks/32-edge-rate-limits.md`                         | The edge rules need the hosting accounts. Plan: manual task 32 by 2026-11-30.                                  |
| ASVS-14.6 | An independent penetration test finds nothing High that stays open | Finding | `docs/security/pentest-pack.md`                                                                  | The pack for the firm is written (P8-03e); the test itself needs the firm. Plan: manual task 36 by 2026-11-30. |

## OWASP Top 10 (2021)

| ID          | Control                                        | Status | Evidence                                                                                | Notes                                                          |
| ----------- | ---------------------------------------------- | ------ | --------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| ASVS-T10.1  | A01 Broken access control                      | Met    | `docs/security/authorisation.md`, `apps/server/src/auth/permission.guard.ts`            | See V4.                                                        |
| ASVS-T10.2  | A02 Cryptographic failures                     | Met    | `apps/server/src/tls`, `apps/server/src/auth/credential-hasher.ts`                      | See V6 and V9.                                                 |
| ASVS-T10.3  | A03 Injection                                  | Met    | `apps/server/src/validation/zod-validation.pipe.ts`, `apps/server/src/database`         | See V5; CodeQL runs on every PR.                               |
| ASVS-T10.4  | A04 Insecure design                            | Met    | `docs/security/threat-models/README.md`                                                 | STRIDE models for all eight components.                        |
| ASVS-T10.5  | A05 Security misconfiguration                  | Met    | `apps/server/src/http/security-headers.ts`, `docs/runbooks/windows-host.md`             | Headers, CIS checklist; see [CIS](cis-windows.md).             |
| ASVS-T10.6  | A06 Vulnerable and outdated components         | Met    | `.github/workflows/security.yml`, `.github/dependabot.yml`                              | Audit, dependency review, SBOM.                                |
| ASVS-T10.7  | A07 Identification and authentication failures | Met    | `apps/server/src/auth/sign-in-lockouts.ts`, `apps/server/src/auth/credential-hasher.ts` | See V2.                                                        |
| ASVS-T10.8  | A08 Software and data integrity failures       | Met    | `apps/server/src/updates/authenticode.ts`, `infra/ci/release-manifest.mjs`, `UPDATE-S2` | Signed updates, pinned signer, attestation.                    |
| ASVS-T10.9  | A09 Logging and monitoring failures            | Met    | `apps/server/src/audit/audit.service.ts`, `apps/server/src/notifications`               | Audit entries and alerts for lockouts, tampering and printers. |
| ASVS-T10.10 | A10 Server-side request forgery                | Met    | `apps/server/src/cloud`, `apps/server/src/relay`                                        | See V5.5.                                                      |

## OWASP API Security Top 10 (2023)

| ID          | Control                                              | Status | Evidence                                                                                                                       | Notes                                                                |
| ----------- | ---------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| ASVS-API.1  | API1 Broken object level authorisation               | Met    | `docs/security/authorisation.md`, `apps/server/src/realtime/rooms.ts`                                                          | Object checks per device and table.                                  |
| ASVS-API.2  | API2 Broken authentication                           | Met    | `apps/server/src/auth/device-token.authenticator.ts`, `apps/server/src/auth/sign-in-lockouts.ts`                               | See V2.                                                              |
| ASVS-API.3  | API3 Broken object property level authorisation      | Met    | `packages/contracts/src`, `apps/server/src/validation/zod-validation.pipe.ts`                                                  | Strict schemas; clients cannot set prices, totals or status.         |
| ASVS-API.4  | API4 Unrestricted resource consumption               | Met    | `apps/server/src/http/flood-limits.ts`, `apps/server/src/http/body-limits.ts`, `apps/control-plane/src/http/request-limits.ts` | Edge limits: see 14.5.                                               |
| ASVS-API.5  | API5 Broken function level authorisation             | Met    | `docs/security/authorisation.md`, `apps/server/src/auth/permission.guard.ts`                                                   | Sweep test in P8-03a.                                                |
| ASVS-API.6  | API6 Unrestricted access to sensitive business flows | Met    | `apps/server/src/service-requests`, `infra/supabase/src/submit-order.ts`                                                       | Order and request limits on public flows.                            |
| ASVS-API.7  | API7 Server-side request forgery                     | Met    | `apps/server/src/cloud`, `apps/server/src/relay`                                                                               | See V5.5.                                                            |
| ASVS-API.8  | API8 Security misconfiguration                       | Met    | `apps/server/src/http/security-headers.ts`, `docs/security/dast.md`                                                            | See V14.                                                             |
| ASVS-API.9  | API9 Improper inventory management                   | Met    | `docs/api`, `packages/contracts/src/client-api.ts`                                                                             | The route registry is the inventory; docs are generated and checked. |
| ASVS-API.10 | API10 Unsafe consumption of APIs                     | Met    | `apps/server/src/cloud`, `apps/server/src/relay`, `packages/contracts/src`                                                     | Responses from the Control Plane and relay are parsed with schemas.  |
