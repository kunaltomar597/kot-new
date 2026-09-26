# Vendor Control Plane: operating it

For vendor operations and the release pipeline. Background: ADR-0012 and
`apps/control-plane/README.md`.

## Environments (VCP-009)

Development, staging and production are separate deployments of `apps/control-plane`. Each has
its own PostgreSQL 16 database in an India region (for example AWS `ap-south-1` Mumbai or GCP
`asia-south1`) and its own configuration, kept in the hosting provider's secret manager, never in
the repository.

Choosing and opening the hosting account is item 5 of `docs/owner/OWNER_CHECKLIST.md`. Until
then, the service runs locally and in CI tests.

For staging and production:

- Set `CP_ENV=staging` or `CP_ENV=production` and a `DATABASE_URL` with `sslmode=verify-full`
  (at least `require`; the service refuses to start without it).
- End TLS 1.2 or newer at the load balancer, which forwards to the service's `PORT`. The service
  sends HSTS.
- Set `CP_TRUST_PROXY` to the number of proxies in front of the service.
- Serve the API at the root of its host name. Signed requests cover the path, so rewriting it
  breaks them.
- Health check: `GET /v1/health` answers 200 when the database is up and 503 when it is not.

## Deploying a version of the service

1. Build in CI (never on a laptop, SEC-013): `pnpm --filter @rp/control-plane build`.
2. Apply migrations before starting the new version:
   `pnpm --filter @rp/control-plane db:migrate:deploy` with the environment's `DATABASE_URL`.
   Migrations are forward-only.
3. Start `node apps/control-plane/dist/main.js` (for example in a container) and wait for the
   health check.

## Connecting a restaurant PC

1. `cli tenant:create --name "<restaurant>"` (once per restaurant business).
2. `cli installation:create --tenant <id> --name "<which PC>"`. The command prints the enrolment
   code once; it is valid 7 days. Give it to the installer through the onboarding channel. The
   installer enters it during activation (P0-17b, then ONB-003 in P7-01).
3. If the code expired before use: `cli installation:code --installation <id>`.
4. `cli installations:list` shows the installation `ACTIVE` once the PC has enrolled, and its
   last heartbeat time.

Run `cli` as `pnpm --filter @rp/control-plane cli ...` from an operator host or the pipeline,
with that environment's `DATABASE_URL` and `CP_ACTOR` set to who is acting (`cli:<name>` or
`ci:<pipeline>`). Every command is in the audit log.

## Publishing a release

The release pipeline (P7-04) publishes signed installers. By hand:

```
cli release:publish --channel PILOT --version 1.3.0-rc.1 \
    --url https://<downloads host>/rp/1.3.0-rc.1/setup.exe \
    --sha256 <SHA-256 of the signed file> --size <bytes> --notes "..."
```

- Pilot restaurants follow `PILOT`, everyone else `STABLE` (UPD-002). A version can be
  published once per channel.
- Installations are offered the newest version on their channel that is newer than theirs, at
  their next heartbeat.
- Pinning single restaurants, staged rollout and halting come with P7-04.

## Disconnecting an installation

`cli installation:revoke --installation <id> --reason "<why>"` refuses the PC's requests from
then on, with `INSTALLATION_REVOKED`. The restaurant keeps working offline (NFR-A01). Moving an
installation to a new PC is a support action in P7-02.
