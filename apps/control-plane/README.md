# apps/control-plane: Vendor Control Plane (C11)

The vendor's cloud service. It will hold tenants, activation codes, licences and subscriptions,
fleet health, release channels and rollouts, support diagnostics and AI menu import. It is a
NestJS API on managed PostgreSQL in an India region, with separate development, staging and
production (VCP-009).

Built so far: P0-17a (ADR-0012). Later: P7-01 to P7-04, P7-08 and P6-04; the web app for vendor
staff comes in P7-02.

## What exists (P0-17a)

- Installation identity (ADR-0012). Each restaurant PC has an Ed25519 key; its private key never
  leaves the PC and the Control Plane stores only public keys.
- Enrolment: `POST /v1/enrolments` (public).
  - The PC sends a one-time code, its public key and a signature proving it holds the key.
  - Codes are 16 characters (80 bits), valid 7 days, stored as SHA-256 and used once.
  - Attempts are rate-limited to 10 per minute per client address.
- Signed requests (`src/auth/installation.guard.ts`). Every endpoint that is not `@Public()`
  needs these headers:
  - `x-rp-installation`, `x-rp-timestamp`, `x-rp-nonce`;
  - `x-rp-signature`: Ed25519 over `signedRequestMessage` (`@rp/contracts/control-plane`),
    which covers the method, the path with its query, the time, the nonce and the body's SHA-256.

  The guard accepts timestamps within ±5 minutes and each nonce once per installation (expired
  nonces are purged every 10 minutes). It answers:
  - `SIGNATURE_INVALID` for unknown installations, bad signatures or malformed headers;
  - `CLOCK_SKEW` with `details.serverTime` when the time is outside the window;
  - `NONCE_REUSED` for a replayed nonce;
  - `INSTALLATION_REVOKED` for a revoked installation.

- Heartbeats: `POST /v1/heartbeats`.
  - Each is stored under its client-chosen ID, so retries are stored once.
  - The installation's `last_seen_at` and `last_heartbeat` are updated.
  - The answer carries `serverTime`, `nextHeartbeatSeconds` (`CP_HEARTBEAT_SECONDS`, default 300)
    and the update to install.
- Releases: one row per component, channel and version. The CHECK constraints require an
  `https:` URL, a hex SHA-256 and a positive size.
  - An installation is offered the newest release on its channel (`STABLE` or `PILOT`) that is
    newer than the `RESTAURANT_PC` version it reports.
  - `GET /v1/updates?version=` answers the same on demand.
- Audit log: `audit_log` records every action with its actor. A trigger refuses updates,
  deletes and truncation.
- Health: `GET /v1/health` (public), for the load balancer.
- Contracts: `@rp/contracts/control-plane`. The generated document is
  `docs/api/control-plane.openapi.json`.

## Configuration

Environment variables only; see `.env.example`.

- `CP_ENV` is `development`, `staging` or `production`. Staging and production require
  `sslmode=require` (or stricter) in `DATABASE_URL` and send HSTS.
- `CP_TRUST_PROXY` is the number of reverse proxies in front of the service. It is needed so the
  enrolment rate limit sees the client's address, not the load balancer's.
- Serve the API at the root of its host. The signature covers the path, so a proxy must not
  rewrite it.

## Admin CLI

Until the web app exists, vendor staff use the CLI. It works on the database in `DATABASE_URL`,
so run it only from the release pipeline or an operator host, never from a laptop against
production. Every command is audited with `CP_ACTOR` (default `cli:<user>`).

```
pnpm --filter @rp/control-plane cli tenant:create --name "Spice Route"
pnpm --filter @rp/control-plane cli installation:create --tenant <id> --name "Main PC" [--channel PILOT]
pnpm --filter @rp/control-plane cli installation:code --installation <id>
pnpm --filter @rp/control-plane cli installation:revoke --installation <id> --reason "..."
pnpm --filter @rp/control-plane cli installations:list
pnpm --filter @rp/control-plane cli release:publish --channel STABLE --version 1.2.0 \
    --url https://.../setup.exe --sha256 <hex> --size <bytes> [--notes "..."]
```

## Commands

```
pnpm --filter @rp/control-plane build            generate the Prisma client and compile
pnpm --filter @rp/control-plane test             unit + integration tests (throwaway PostgreSQL)
pnpm --filter @rp/control-plane start            run dist/main.js
pnpm --filter @rp/control-plane db:migrate:deploy
```

Schema changes follow the local server's routine (`apps/server/README.md`): edit
`prisma/schema.prisma`, then create a forward-only migration.

## Tests

- `test/helpers/test-installation.ts` is a restaurant PC with an Ed25519 key. It signs requests
  exactly as ADR-0012 describes.
- Integration tests use `@rp/test-postgres`: one throwaway cluster per run and one cloned
  database per test file.
- `@rp/control-plane/testing` exports what the local server's acceptance test (P0-17b) needs to
  run a real Control Plane beside it.
