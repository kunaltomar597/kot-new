# Manual tasks

Everything in the build that needs a person: an account, a signature, a device in your hand, a
Windows PC or a decision only the Business Owner can make. Claude builds everything else and keeps
going; this file is the list to work through when you have time. Detailed steps for each task are
in [`manual-tasks/`](manual-tasks/).

Status: `[ ]` to do, `[x]` done. Tick items here when they are done and tell Claude, so PROGRESS.md
can be updated. Never paste secrets, keys or passwords into a Claude session or a commit.

## 1. Now (unblocks pushing the local build)

- [x] **Log in to GitHub on this Mac** so the local build can be pushed and merged (done:
      the Mac build was merged through PR #85 on 2026-10-11):
      `gh auth login` (GitHub.com, HTTPS, "authenticate Git with your GitHub credentials").
      Steps: [`manual-tasks/01-github-access.md`](manual-tasks/01-github-access.md).
- [x] `main` is the repository's default branch.
- [ ] Protect `main` (pull requests, the CI checks) and require 2FA for everyone with access.
      Same file. Checked 2026-10-11: `main` is not protected yet; the `release-signing`
      environment for the code-signing certificate (SEC-013) exists.

## 2. Accounts and keys (Business Owner)

The full list with what each one unblocks is in
[`docs/owner/OWNER_CHECKLIST.md`](docs/owner/OWNER_CHECKLIST.md). The ones that block finished
code from going live:

- [ ] Domain name + DNS (QR site, Control Plane, update server).
- [ ] Cloud hosting in India + cloud KMS / secrets manager (Control Plane, licence-signing key).
- [ ] Windows code-signing certificate (signed installer and updates). Put it into the secrets of
      the GitHub environment `release-signing` (never the repository's own secrets, which every
      branch can read) as `WINDOWS_CERTIFICATE_P12` (the .p12 file in base64) and
      `WINDOWS_CERTIFICATE_PASSWORD`, and its subject (`certutil -dump`, "Subject:") into the
      repository variable `RP_UPDATE_PUBLISHER` (and its issuer, "Issuer:", into `RP_UPDATE_ISSUER`); the CI job "Windows installer" then signs pushes
      to `main`, and the installed PCs accept only updates signed with it
      (`docs/runbooks/windows-installer.md`, "Building it"; `docs/runbooks/software-updates.md`,
      "Signing"). Certificates issued since June 2023 keep their key in a hardware token or a
      cloud HSM (SEC-006), so there may be no .p12 to export: tell Claude which signing service
      the certificate comes with, and the job will call it from that environment instead:
      [`manual-tasks/31-code-signing.md`](manual-tasks/31-code-signing.md).
- [ ] Rate limits at the edge in front of the Control Plane, the relay and the QR site, once they
      have a host, then run `infra/edge/check-edge.mjs` against staging (threats CP-D1, RELAY-D4):
      [`manual-tasks/32-edge-rate-limits.md`](manual-tasks/32-edge-rate-limits.md).
- [ ] The Control Plane host's log store (the audit log's copy, kept 180 days) and the operator host
      for the admin CLI (threats CP-T5, CP-R2):
      [`manual-tasks/34-control-plane-host-logs.md`](manual-tasks/34-control-plane-host-logs.md).
- [ ] The restaurant PC's accounts, BitLocker and separate staff Wi-Fi, at each installation and
      yearly (threats PC-E2, DESKTOP-E4, PC-D6):
      [`manual-tasks/35-windows-host-checks.md`](manual-tasks/35-windows-host-checks.md).
- [ ] Android checks on a real phone and tablet: backups off, PIN screens not captured, the private
      lock-screen alert, the kiosk's user restrictions, a rogue server refused (threats MOBILE-E2,
      R2, I4, S1): [`manual-tasks/33-android-device-checks.md`](manual-tasks/33-android-device-checks.md).
- [ ] Supabase organisation, Mumbai region (QR relay), then deploy the relay schema and give the
      edge functions and the Control Plane their logins:
      [`manual-tasks/20-supabase-relay.md`](manual-tasks/20-supabase-relay.md).
- [ ] Host the QR menu site (Next.js, India region) on its domain:
      [`manual-tasks/21-qr-site.md`](manual-tasks/21-qr-site.md).
- [ ] Legal review of the QR site's privacy notice and terms (drafts at `/privacy` and `/terms`).
- [ ] Expo account + Android app-signing keystore (signed APKs, OTA updates), and the update
      signing key of each app, then a check on a phone and a tablet, also of new APKs installed
      from the restaurant PC:
      [`manual-tasks/29-mobile-updates.md`](manual-tasks/29-mobile-updates.md).
- [ ] MDM subscription (kiosk tablets, APK distribution).
- [ ] Backup storage in India (S3-compatible), error monitoring (Sentry), transactional e-mail.
- [ ] AI provider account and its key in the Control Plane's secret manager (AI menu import):
      [`manual-tasks/22-ai-menu-import.md`](manual-tasks/22-ai-menu-import.md).
- [ ] Digital bills: the WhatsApp Business Platform number, a system user's token and the
      approved `digital_bill` template in the Control Plane's secret manager; SMS needs TRAI DLT
      registration first (see `manual-tasks/28-digital-bills.md`).
- [ ] Pager firmware: create the secure boot signing key offline, put its digest into the
      software, and release the first firmware through a pilot PC:
      [`manual-tasks/30-pager-firmware-signing.md`](manual-tasks/30-pager-firmware-signing.md).
- [ ] Licensing: create the vendor licence-signing key in the cloud KMS, put its public key into
      the software, and have two people review the licensing code (NFR-M05):
      [`manual-tasks/23-licensing.md`](manual-tasks/23-licensing.md).
- [ ] Error reporting: a Sentry-compatible service (best in India), two projects and their DSNs in
      the Control Plane's secret manager and the installer's CI secret:
      [`manual-tasks/24-error-reporting.md`](manual-tasks/24-error-reporting.md).
- [ ] Cloud backup storage: an S3 bucket in India (ap-south-1) per environment, with versioning
      and a 35-day object lock, its access key in the Control Plane's secret manager:
      [`manual-tasks/26-cloud-backup-storage.md`](manual-tasks/26-cloud-backup-storage.md).
- [ ] Backup key escrow: the restore policy with counsel (OI-10) and the KMS key in India:
      [`manual-tasks/27-key-escrow.md`](manual-tasks/27-key-escrow.md).

## 3. Hardware and on-site tests

Claude prepares the firmware, scripts and procedures; you run them on real devices and paste the
results into a session (or into the results template in each file).

| Task                                                                         | Work package   | Procedure                              | Ready to run?                      |
| ---------------------------------------------------------------------------- | -------------- | -------------------------------------- | ---------------------------------- |
| Pager battery test (≥ 14 h at 60 alerts/hour)                                | P0-H1          | `manual-tasks/10-pager-battery.md`     | Not yet (firmware to come)         |
| Wi-Fi coverage walk test at the pilot site                                   | P0-H2          | `manual-tasks/11-wifi-coverage.md`     | Yes (phone pass)                   |
| Kiosk mode and session on the chosen tablet                                  | P0-H3, P3-01b  | `manual-tasks/12-tablet-kiosk.md`      | Yes (dev or preview build)         |
| Thermal printers and cash drawer (80/58 mm, USB, LAN)                        | P0-H4, P4-07b  | `manual-tasks/13-printer-test.md`      | Yes (network printers)             |
| Installer on a clean Windows 11 PC, and the camera reading a pager's QR code | P0-16, P2-04b2 | `manual-tasks/14-windows-installer.md` | After the first push (CI artifact) |
| Flash and test the production pager firmware                                 | P2-05          | `manual-tasks/15-pager-firmware.md`    | Not yet                            |
| Alert latency and escalation on the lab rig                                  | P2-07          | `manual-tasks/16-lab-rig-latency.md`   | Not yet                            |
| Voice search on the tablet (with/without offline pack)                       | P6-03          | `manual-tasks/17-voice-search.md`      | Not yet                            |
| Restore rehearsal (same PC, a spare PC, to a moment), RTO and RPO timed      | P7-05b, P7-05c | `manual-tasks/25-restore-rehearsal.md` | After the installer (P0-16)        |
| Failure drills (power cut, router off, printer off)                          | P8-02          | `manual-tasks/18-failure-drills.md`    | Not yet                            |

## 4. Decisions only the Business Owner can make

Claude has built a default for each and recorded it in `docs/build/PROGRESS.md` "Decisions". Change
any of them by telling Claude.

- [ ] Refund on a voided paid invoice: record mode and amount? Separate manager approval? (Today:
      no refund recorded.)
- [ ] OI-01 product name, logo and brand colours (today: working title, neutral slate/blue).
- [ ] OI-03 bar/liquor VAT billing for the pilot (today: excluded).
- [ ] OI-04 hardware models; OI-05 MDM vendor.
- [ ] OI-06 WhatsApp or SMS for digital bills (today: WhatsApp).
- [ ] OI-08 grace period and subscription terms (today: 7 days); OI-10 backup key escrow (today:
      escrowed in the KMS, released by a one-time restore code Support issues after verifying the
      Owner by video call with ID and a call back; the Owner is alerted; see manual task 27).
      Should a second vendor person approve each release of a key (threat model CP-I1)? Today
      Support alone can.
- [ ] Pricing and plans.

## 5. Legal, compliance and pilot

From BRD §19.2 and §19.3; details in `docs/owner/OWNER_CHECKLIST.md`.

- [ ] Subscription agreement / EULA matching the licence states (LIC-005), DPA, privacy notices.
- [ ] DPDP review with counsel; CERT-In point of contact. The incident response plan's names, the first
      tabletop exercise and the penetration test (SEC-016, SEC-017):
      [`manual-tasks/36-incident-response-and-pentest.md`](manual-tasks/36-incident-response-and-pentest.md).
- [ ] Pager certification (WPC, BIS) through a compliance consultant.
- [ ] Penetration-testing firm (needed before the pilot, P8-03).
- [ ] Pilot restaurant(s), baseline KPIs, the restaurant CA's confirmation of the invoice template
      and tax rates.
- [ ] Approve the menu template, user manuals and training-video scripts (P8-05).
