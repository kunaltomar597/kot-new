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

## The web app for vendor staff

The Control Plane serves the web app (`apps/control-plane-web`) at `/`, on the same host as the
API.

1. Build it in CI with the service: `pnpm --filter @rp/control-plane-web build`.
2. Ship `apps/control-plane-web/dist` with the service and set `CP_WEB_DIR` to that folder. The
   service refuses to start if the folder has no `index.html`.

The pages carry a strict Content-Security-Policy (same-origin only, no framing) and are never
indexed by search engines.

### The first Super Admin

Run this once per environment, from a machine with the environment's `DATABASE_URL`:

1. Create the account:
   `pnpm --filter @rp/control-plane cli vendor-user:create --email <email> --name "<name>" --role SUPER_ADMIN`
2. The command prints a setup token once. Give the person the link
   `https://<control-plane host>/setup#<token>` directly, by phone or in person. The link works for
   72 hours.
3. On that page they choose a password and add an authenticator app.

After that, the Super Admin adds everyone else from the Staff page, which shows each new account's
setup link once. The access policy (`vendor-access-policy.md`) says who gets which role.

## Fleet monitoring and alerts (VCP-005)

Every PC reports every 5 minutes: versions, disk, devices and how many are connected, server
errors since the last report, backups (from P7-05), its opening hours and its audit chain head.
The Control Plane opens one alert per PC and kind:

| Alert                | When                                                                                                                                  | Closes                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Offline              | Silent for more than `CP_OFFLINE_ALERT_MINUTES` (30) of the restaurant's opening hours. A PC without opening hours counts every hour. | By itself, at the next heartbeat     |
| Disk full            | Data drive more than `CP_DISK_ALERT_PERCENT` (90 %) full                                                                              | By itself, when space is freed       |
| Backup failed        | The latest backup failed                                                                                                              | By itself, after a successful backup |
| Audit chain mismatch | The PC's local audit log changed after it was reported (AUD-003)                                                                      | Only by a person, with a reason      |

- **Webhook:** set `CP_ALERT_WEBHOOK_URL` (a Slack or Microsoft Teams incoming webhook, from the
  secret manager). Each alert is then posted as it opens and as it closes. Posts that fail are
  retried every minute.
- **Where alerts show:** the web app's Fleet page lists open alerts whether or not a webhook is
  set.

### An audit chain mismatch

The local audit log only grows. The Control Plane keeps every head a PC reported. It also asks
the PC, at random, for the hash it holds for an earlier head, so a rewritten old entry is caught
even when the newest one looks right. A mismatch means the restaurant's database changed outside
the application, or was restored from a backup.

1. Do not close the alert straight away. Call the Owner.
2. Ask whether the PC was restored from a backup or replaced, and when.
3. Ask the Owner to open "Check the trail" on the console's audit page, press "Check now" and read
   out the result.
4. Note what you found as a support note on the restaurant.
5. A legitimate restore: close the alert with the reason, for example "Restored from the 1 Oct
   backup after a disk failure". The chain then counts from the PC's current head.
6. No explanation: escalate to the Super Admin and leave the alert open. The audit log may have
   been tampered with (SEC-018).

## Connecting a restaurant PC

1. `cli tenant:create --name "<restaurant>"` (once per restaurant business).
2. `cli installation:create --tenant <id> --name "<which PC>"`. The command prints the enrolment
   code once; it is valid 7 days. Give it to the installer through the onboarding channel.
3. On the restaurant PC, with `RP_CONTROL_PLANE_URL` set, the installer enrols the PC during
   activation: `pnpm --filter @rp/server control-plane:enrol <code>` (P0-17b; the activation
   screen of ONB-003 comes in P7-01). The PC reports every 5 minutes from then on.
4. If the code expired before use: `cli installation:code --installation <id>`.
5. `cli installations:list` shows the installation `ACTIVE` once the PC has enrolled, and its
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
