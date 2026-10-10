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

| Alert                  | When                                                                                                                                                                                                                               | Closes                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Offline                | Silent for more than `CP_OFFLINE_ALERT_MINUTES` (30) of the restaurant's opening hours. A PC without opening hours counts every hour.                                                                                              | By itself, at the next heartbeat           |
| Disk full              | Data drive more than `CP_DISK_ALERT_PERCENT` (90 %) full                                                                                                                                                                           | By itself, when space is freed             |
| Backup failed          | The latest backup failed                                                                                                                                                                                                           | By itself, after a successful backup       |
| Audit chain mismatch   | The PC's local audit log changed after it was reported (AUD-003)                                                                                                                                                                   | Only by a person, with a reason            |
| Licence tampering      | The PC reported its licence file changed or put back, its licence record edited, the licence on another PC, a reactivation code the vendor never issued, or its clock set back or far off three times in a week (LIC-007, SEC-015) | Only by a person, with a reason            |
| Takes unsigned updates | The PC runs a test build that installs unsigned updates (UPD-007): anyone who can offer it one runs code on it as SYSTEM                                                                                                           | By itself, once a signed build replaces it |

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

### Licence tampering

A PC reports what looks like tampering with its licence (LIC-007) in its heartbeats, once a day
per kind at most; every report is in the audit log (`licence.tamper`). The alert opens at once
for a licence file changed or an older one put back, the PC's licence record edited, the licence
on another PC, or a reactivation code that matches none the vendor issued
(`licence.reactivation_unknown`; the code's day and number are on the alert). The clock (set
back, held back more than an hour, or more than ten minutes from the Control Plane's) alerts only
once reported three times within seven days: a flat clock battery is more common than a customer
holding the clock back.

1. Call the Owner. Ask whether the PC was restored from a backup, replaced, repaired, or its date
   and time changed, and when.
2. A clock alert: ask the Owner to set Windows to set the time automatically; a clock that loses
   time after every restart needs a new CMOS battery.
3. Another PC: a moved or cloned installation. A replaced PC is re-bound (`licence:rebind`) after
   checking who is calling; otherwise escalate.
4. A code never issued: someone made one with the PC's secret. Escalate to the Super Admin; the
   Finance Admin checks the restaurant's payments.
5. Note what you found as a support note, then close the alert with the reason, for example "Flat
   clock battery, replaced on 12 Oct". Reports count afresh from then, so the same problem opens
   a new alert.

### A PC that takes unsigned updates

Every heartbeat says how the PC checks the updates it installs: only with the vendor's signature,
also unsigned (a test build), or not at all (a build without a certificate, which installs no
update). A test build at a restaurant is a hole: whoever can offer it an installer, or replace the
download, runs code as SYSTEM. CI builds test installers on every branch and pull request; they
are for the lab only (`docs/runbooks/software-updates.md`, "Signing").

1. Call the Owner the same day. Ask who installed the software, from where, and when.
2. Arrange to reinstall the current signed release over it (the data stays). The alert closes by
   itself at the PC's next heartbeat after that.
3. Until then, keep the PC out of rollouts (pin it to its version) and note the visit as a support
   note.

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

## Digital bills (BILL-012)

A restaurant PC asks the Control Plane to send a settled bill to the diner on WhatsApp, only after
the diner gave consent on the bill. The vendor's WhatsApp number sends it with the approved
`digital_bill` template. Its token is in the secret manager and never on a PC (SEC-002). Setting
it up: `manual-tasks/28-digital-bills.md`.

What happens to each bill:

- **The link.** The message links to the bill as printed at
  `<CP_PUBLIC_URL>/v1/bills/<token>`. The page has no scripts, is not indexed and is not cached.
- **The token.** It is derived from `CP_DIGITAL_BILL_KEY`. Only its hash is stored, so a copy of
  the database opens no bill.
- **Expiry.** The link expires after the restaurant's `bills.hostedCopyDays` (default 30). The
  hourly sweep then deletes the bill's lines, and the page answers "no longer available".
- **The number.** Only its last four digits are stored (`+91 ******3210`).
- **No duplicates.** Each send is the PC's id, so the same id again never sends a second message.
  A failed send is tried again when the PC asks again: it backs off, for up to a day.
- **Daily limit.** At most `CP_DIGITAL_BILL_DAILY_LIMIT` bills a restaurant a day (default 3,000),
  because the vendor pays per message.

On the restaurant PC (P7-09b):

- **Turning it on.** A manager sets Settings, then Bills, "Digital bills" to WhatsApp. It is off by
  default.
- **Sending.** A bill is queued by itself when it is settled, if the diner's mobile number is in
  the customer details with the consent box ticked (BILL-011). The cashier can send it again from
  the bill.
- **Waiting and giving up.** The PC sends within seconds. While the vendor or WhatsApp cannot be
  reached, it tries again after 1, 5, 15 and 60 minutes, then every 3 hours. A day after the bill
  was queued it gives up. The bill shows "Not sent" and the reason.
- **The number.** It is cleared on the PC once the bill is sent or given up; only the masked
  number stays. Erasing a diner's number (DATA-011) also stops a bill still waiting to go to it.
- **Audit.** `DIGITAL_BILL_QUEUED`, without the number.

When a restaurant says bills are not arriving:

1. Look up `digital_bills` for its installation. The status, `error` and `retryable` say what
   WhatsApp answered.
2. Read the error:
   - a number WhatsApp cannot deliver to (131026 and others) is the diner's, and only the printed
     bill helps;
   - "refused the message (HTTP 401, 190)" is the vendor's token, which has expired or been
     revoked;
   - an HTTP 132xxx error is the template: it was paused, or its variables changed.

## Publishing a release

The release pipeline (P7-04) publishes signed installers. By hand:

```
cli release:publish --channel PILOT --version 1.3.0-rc.1 \
    --url https://<downloads host>/rp/1.3.0-rc.1/setup.exe \
    --sha256 <SHA-256 of the signed file> --size <bytes> --notes "..." \
    --matrix apps/desktop/staging/version-matrix.json
```

- `--matrix` is the release's component version matrix (UPD-006, P7-04d), which the packaging step
  writes. PCs offered the release see how many of their apps it would leave behind, and vendor
  staff see which apps it serves. Its `release` must be the version published.
  `client-compatibility.md` covers freezing the client API before a release.

- Pilot restaurants follow `PILOT`, everyone else `STABLE` (UPD-002). A version can be
  published once per channel. The CLI publishes to every PC of the channel at once; the web app
  (P7-04b) can start with a share.
- A PC is offered, at its next heartbeat, the newest release newer than its own that the rollout
  reaches. It is never offered an older version: migrations only go forward (UPD-005).

### Staged rollout (UPD-003)

Each release has a rollout: a percentage of the channel's PCs, plus a cohort of PCs that get it
whatever the percentage (the pilot restaurants). The rollout is ACTIVE, PAUSED or HALTED.

- **Which PCs.** Every PC has a fixed place from 0 to 99 for each release. Widening from 10 % to
  30 % keeps the first 10 % and adds the next 20 %.
- **Pausing or halting.** Either one stops new offers. PCs that are still downloading drop the
  release at their next heartbeat. Halting needs a reason, which the release then shows.
- **How installs go.** The PCs report each install: started, installed (after the health check),
  rolled back, or failed. A PC that started and has sent no heartbeat for
  `CP_ROLLOUT_SILENT_MINUTES` (45) counts as failed. More than `CP_ROLLOUT_ERROR_SPIKE` (100)
  server errors in the day after an install count as an error spike.
- **Failed installs.** Each one opens an "Update failed" fleet alert for its PC. The alert closes
  when the PC runs that version or a newer one. Support can also close it with a reason, for
  example when the PC was replaced.
- **Automatic halt.** The rollout halts by itself once at least `CP_ROLLOUT_MIN_FAILURES` (2) of
  its installs failed or spiked, and they are at least `CP_ROLLOUT_MAX_FAILURE_PERCENT` (20 %) of
  those that installed it. This is audited as `release.rollout_halted` by `system:rollout`.
- **After a halt.** Look at the failed PCs' alerts and diagnostics. Publish a fixed version, then
  start its rollout. A halted release is never offered again unless resumed.

### One restaurant (UPD-002)

- **Hold a PC at a version** from its page. It is offered that version while it runs an older one,
  whatever the rollout, and nothing newer. Release the hold to let it follow its channel again.
- **A hotfix** is a release published for one PC only. That PC gets it ahead of its channel's
  releases. Give it a pre-release version above the PC's own, for example `1.4.1-hotfix.1` for a
  PC on 1.4.0.
- **Security fixes.** A release marked security-critical (UPD-004) may install while tables are
  open, once a manager approves it on the PC.

## Disconnecting an installation

`cli installation:revoke --installation <id> --reason "<why>"` refuses the PC's requests from
then on, with `INSTALLATION_REVOKED`. The restaurant keeps working offline (NFR-A01). Moving an
installation to a new PC is a support action in P7-02.
