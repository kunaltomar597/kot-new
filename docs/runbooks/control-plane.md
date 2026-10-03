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

## Cloud backups (DATA-003)

Each restaurant PC uploads its nightly backup, encrypted on the PC with its own backup key, to
object storage in India. The Control Plane hands out signed URLs for the parts and keeps the
record; the bytes go straight from the PC to storage, and the Control Plane cannot read them.

- **Configuration:** `CP_BACKUP_STORE=s3` with `CP_BACKUP_S3_REGION` (`ap-south-1` or
  `ap-south-2`; any other region is refused in staging and production), `CP_BACKUP_S3_ENDPOINT`,
  `CP_BACKUP_S3_BUCKET` and the access key pair from the secret manager. Setting up the bucket is
  `manual-tasks/26-cloud-backup-storage.md`. In development, `CP_BACKUP_STORE=local` with
  `CP_BACKUP_LOCAL_DIR` keeps them in a folder and serves the signed URLs itself at
  `/v1/object-store/...`. Unset (`off`), PCs are told the cloud backup is not set up and keep
  their backups locally.
- **Retention (BRD §9.3):** per PC, the newest backup of each of the last
  `CP_BACKUP_KEEP_DAILY` (30) days and `CP_BACKUP_KEEP_MONTHLY` (12) calendar months, applied
  after each upload. When a restaurant's contract ends, delete its cloud backups within 30 days,
  after notice and once the restaurant's CA confirms (a manual step for now). A removed backup keeps its
  record as DELETED. Uploads not completed in two days are aborted and their parts removed; the
  bucket's lifecycle rule removes any left behind.
- **Audit:** `cloud_backup.stored` for each upload, `cloud_backup.removed` for the retention.
- **Where it shows:** the PC's page in the web app ("Cloud backup"), and
  `GET /v1/vendor/installations/:id/cloud-backups` for any vendor role. A PC whose Owner opted
  out shows "Turned off by the Owner". A failing upload shows on the PC's own System page and
  alerts its Owner and managers after a day.
- **Key escrow (P7-05e, OI-10):** `CP_ESCROW_KMS_KEY_ID` (an RSA_4096 encrypt-and-decrypt KMS
  key in India) with its access key pair, set up by `manual-tasks/27-key-escrow.md`. Each heartbeat
  answer offers its public key until the PC's backup key is escrowed; the Control Plane stores
  only the wrapped key (`backup_key.escrowed`). In development, `CP_ESCROW_PRIVATE_KEY` (an RSA
  PKCS#8 key, base64) stands in; staging and production refuse it.
- **Restore codes:** Support or the Super Admin, on the PC's page, "Issue a restore code", only
  after verifying the Owner by the restore policy, with the reason and how they were verified
  (`restore_code.issued`). The code is shown once and works once, within 24 hours, in
  `restore-cli cloud <code>` on the new PC (`backup_key.released`, with the address it came
  from). `POST /v1/cloud-restores` allows 5 attempts a minute per address. The restaurant's
  Owner is alerted at the PC's next heartbeat, if it is still running.

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

## Error reporting (NFR-O02)

With `CP_ERROR_DSN` set (a Sentry-compatible DSN, from the secret manager), unexpected errors and
crashes of the Control Plane are reported, scrubbed of secrets and personal data, at most 60 an
hour. Restaurant PCs report with their own DSN (`RP_ERROR_DSN`, set by the installer); their
console, waiter phones and table tablets send errors through the PC, so no app carries a DSN.
Setting it up: `manual-tasks/24-error-reporting.md`.

## Remote settings and feature flags (UPD-010)

The Super Admin sets them on the web app's Remote settings page, for every PC or for one PC
(that PC's page, "Change for this PC"):

- QR ordering limits and timings, how often pagers report, and feature flags such as
  `features.aiMenuImport`.
- A value left empty keeps the default, or, for one PC, follows the value for every PC.

Each PC gets the values with its next heartbeat (within 5 minutes) and applies them as settings
its managers see but cannot change. A PC's page shows "The PC holds these settings" once it
reports them. Every change needs a reason and is audited in the Control Plane and on the PC
(`VENDOR_SETTINGS_APPLIED`).

To switch AI menu import off for one restaurant while the AI provider has trouble, set
`features.aiMenuImport` to Off on that PC. Its managers then see "Reading menus from photos is
switched off by the vendor for now" and can still use the Excel template.

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
