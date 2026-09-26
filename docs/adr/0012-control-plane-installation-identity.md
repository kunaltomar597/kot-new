# ADR-0012: Minimal Vendor Control Plane: installation identity, signed requests, heartbeats and releases

Status: Accepted
Date: 2026-09-26
Work package: P0-17a
Requirements: VCP-005, UPD-002, VCP-009, SEC-002, SEC-003, SEC-001, NFR-A01, UPD-007, UPD-010,
LIC-007, ONB-003

## Context

Phase 0 needs the smallest cloud service that lets a restaurant PC report that it is alive and
find out about new releases (P0-17). Later work packages grow it into the full Vendor Control
Plane: tenants, activation and licences (P7-01, P7-02), fleet monitoring and alerts (P7-03),
rollouts (P7-04) and diagnostics (P7-08).

Forces:

- SEC-002: installations get per-tenant, scoped credentials from the Control Plane; no secrets in
  source or bundles.
- The restaurant PC is outside the vendor's control. The Control Plane database is a valuable
  target: whatever it stores must not let someone impersonate an installation.
- ADR-0004 and NFR-A01: the cloud never connects in, and the restaurant never waits on it.
- VCP-009: India region, separate development, staging and production. The hosting account is
  not there yet (Owner checklist items 4 and 5), so the service must run anywhere Node and
  PostgreSQL run.

## Decision

- Service. `apps/control-plane` is a NestJS 12 API with Prisma 7 on PostgreSQL 16, following the
  local server's patterns. `CP_ENV` is `development`, `staging` or `production`. Each environment
  has its own database and configuration, taken from environment variables only. Staging and
  production require TLS to the database (`sslmode=require` or stricter) and send HSTS; TLS itself
  ends at the hosting provider's load balancer. Until the vendor web app (VCP-001, P7-02), vendor
  staff use an admin CLI that talks to the database. It runs from CI or an operator host, and every
  command writes an audit entry naming its actor.
- Installation identity. Each installation has an Ed25519 key pair. The private key never leaves
  the restaurant PC: it is derived from the 32-byte `installation-signing-key` in the local
  server's secret store (DPAPI on Windows, SEC-006). The Control Plane stores only public keys.
- Enrolment. The vendor creates an installation for a tenant, and the CLI prints a one-time
  enrolment code. The code is 16 characters from the alphabet without look-alikes (80 bits), valid
  7 days, and stored as its SHA-256.
  - The local server calls `POST /v1/enrolments` with the code, its public key and a signature of
    `rp-cp-enrol:v1:<code>`, which proves it holds the key.
  - The code is used up and the installation becomes `ACTIVE`.
  - Attempts are rate-limited per client address.
  - P7-01 turns this into activation (ONB-003) with the licence and the PC fingerprint.
- Signed requests, not bearer tokens. Every installation request carries four headers:
  `x-rp-installation`, `x-rp-timestamp` (ms since the epoch), `x-rp-nonce` (16 random bytes,
  base64url) and `x-rp-signature`. The signature is Ed25519 over
  `rp-cp-request:v1\n<METHOD>\n<path and query>\n<timestamp>\n<nonce>\n<SHA-256 of the body, hex>`.
  - The Control Plane accepts timestamps within 5 minutes of its own clock and accepts each
    nonce once per installation, which blocks replays.
  - Unknown installations and bad signatures get 401 `SIGNATURE_INVALID`. After a valid
    signature, a revoked installation gets 403 `INSTALLATION_REVOKED`.
  - A clock outside the window gets 401 `CLOCK_SKEW` with the server's time, so the client can
    correct its offset and retry.
  - An installation can only act on itself (deny by default, SEC-003).
- Heartbeats. The local server calls `POST /v1/heartbeats` (signed) every 5 minutes by default.
  - The request carries:
    - a heartbeat ID (a UUID that makes retries idempotent), when it was sent and component
      versions;
    - the data drive's size and free space, the audit chain head and device counts.
  - Later work packages add backup status, error counts and licence state. Unknown fields are
    kept rather than rejected, so an installation newer than the Control Plane is never refused.
  - The response returns:
    - the server time (LIC-007 clock checks);
    - the next interval in seconds: a fleet setting, `CP_HEARTBEAT_SECONDS`, default 300, which
      is also UPD-010 remote configuration;
    - the release the installation should update to, if any.
  - Each heartbeat is stored and summarised on its installation: last seen, last payload. Fleet
    views, retention and alerts come in P7-03.
- Releases. A release names a component (`RESTAURANT_PC`: the Windows installer carrying the
  server, console and desktop shell), a channel (`STABLE` or `PILOT`, UPD-002), a semantic
  version, an `https:` URL, a SHA-256 and a size.
  - An installation sees its own channel, and is offered the newest release that is newer than
    the version it reports. `GET /v1/updates` answers the same on demand.
  - Per-restaurant pinning, staged rollout and halting (UPD-003, VCP-006) come in P7-04.
  - The artefacts are Authenticode-signed and checked before installation (UPD-007, P0-16). The
    SHA-256 lets the PC check its download against what the vendor published.
- Contracts live in `@rp/contracts/control-plane`, a separate entry point with its own generated
  document, `docs/api/control-plane.openapi.json`. The local API's document stays about the local
  server.

## Alternatives considered

- A bearer API key per installation. It is simpler, but it is a secret sent on every request that
  can leak through logs or proxies. It also protects nothing in the body, and the cloud has to
  store something that verifies it.
- Mutual TLS with client certificates. It is strong, but needs a certificate authority and
  lifecycle for installations, and many managed load balancers pass client certificates on only
  with extra setup.
- OAuth 2.0 client credentials with `private_key_jwt`. It is standard, but adds a token endpoint
  and token caching for no gain at this size. It can be added in front of the same keys later.
- Hosted feature-flag and update services. They add external dependencies and data transfers
  abroad; the Control Plane has to exist anyway for licences (LIC).

## Consequences

- The nonce table gains about 288 rows per installation per day (one per heartbeat). Expired
  nonces are purged every 10 minutes.
- A restaurant PC whose clock is more than 5 minutes off still reports: it corrects the offset
  from the `CLOCK_SKEW` answer. The size of the offset is itself a signal for LIC-007.
- A leaked Control Plane database exposes tenant names and fleet data, but no credential that
  can act as an installation.
- Moving an installation to a new PC (VCP-002 re-bind) issues a new enrolment code for the same
  installation. The old key stops working when the new one is registered; this is built in P7-02.
- The admin CLI is temporary. It must not run from developers' laptops against production: only
  from the release pipeline or an operator host (SEC-013).
