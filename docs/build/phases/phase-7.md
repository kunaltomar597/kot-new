# Phase 7: Commercial readiness

BRD §17 Phase 7. Exit criteria: licence and data scenarios S8, S9 and S10 pass.
Everything here is security-sensitive (licensing, crypto, backups): two human reviewers (NFR-M05).

---

## P7-01 Licensing module

Requirements: LIC-001 to LIC-009, LIC-010 (entitlement fields only), SEC-006, R-05, R-16.
Depends on: P0-17.
Deliverables: `packages/licensing` (pure verification of Ed25519-signed licence files: restaurant ID,
installation ID, PC fingerprint, plan, modules, device limits, issue/valid-until, grace days, state);
PC fingerprint tolerant to minor changes (3 of 5 identifiers); server licence agent (verify at
start-up and periodically, rolling 30-day validity renewed at least daily online, Restricted on
missing/unsigned/tampered, entitlements served to clients); state handling with `@rp/domain`
`licenseMachine`, `licenseCapabilities`, `restrictionEffectiveAt` (never mid-service); reactivation
within 1 minute online and signed offline reactivation codes; clock-rollback detection; device-limit
enforcement at pairing; tamper events reported. The signing key lives only in the cloud KMS.
Acceptance: tests for every state transition and capability, tampered file, expired offline,
clock rollback, next-business-day restriction, offline reactivation code.

## P7-02 Control Plane: tenants, subscriptions, licences, vendor access

Requirements: VCP-001, VCP-002, VCP-003, VCP-004 (S), VCP-007, VCP-008, VCP-009, AUTH-014, SEC-018.
Depends on: P0-17, P7-01.
Deliverables in `apps/control-plane`: vendor roles (Super Admin, Onboarding, Support, Finance,
Read-only) with mandatory MFA and full audit; tenant management (contacts, GSTIN, plan, device
limits, activation codes, PC re-binding, relay provisioning with scoped credentials); plans, billing
cycles, manual payment recording, overdue tracking, licence state changes with reasons, issue/revoke,
offline reactivation codes; support notes; documented access policy (no business data except
diagnostics or backups).
Acceptance: API and UI tests per role; MFA enforced; every action audited.

## P7-03 Fleet monitoring and alerts

Requirements: VCP-005, NFR-O03, AUD-003 (chain head in heartbeats), DATA-005.
Depends on: P7-02.
Deliverables: heartbeat every 5 min with online state, versions of every component, disk usage,
backup status, device counts and health, error counts, licence state and audit chain head; fleet
dashboard; alerts for offline > 30 min during business hours, backup failure, disk > 90 %; chain-head
history to detect local tampering.
Acceptance: tests for alert rules; a tampered local chain is detected by comparing heads.

## P7-04 Release management and remote updates

Requirements: UPD-001 to UPD-007, VCP-006, PGR-011 (distribution), R-07.
Depends on: P0-16, P7-02, P2-04.
Deliverables: signed builds from CI promoted to channels (Stable, Pilot/Beta) with per-restaurant
pinning and hotfix builds; staged rollout by percentage/cohort with pause/halt and automatic halt on
error or heartbeat spikes; local update agent: background download, install only in the maintenance
window or on "Install now", never with open tables unless security-critical and approved; pre-update
full backup and integrity check; forward-only migrations; post-update health check with automatic
rollback of app and database; component version matrix and N-1 client compatibility checks; EAS
Update channels for mobile and APK push via MDM/in-app updater; pager firmware distribution.
Acceptance: scenario S9 (forced failed health check → rollback) automated on Windows CI; staged
rollout halt test.

## P7-05 Backup and restore

Requirements: DATA-001 to DATA-005, SEC-007, OI-10.
Depends on: P0-16, P7-02.
Deliverables: WAL archiving (continuous or hourly), nightly full backup to a second location, integrity
checks, retention 14 daily + 8 weekly; nightly encrypted (AES-256-GCM) cloud backup to India storage,
key generated at install (DPAPI) and escrowed wrapped by a vendor KMS key, released only on the
Owner's authenticated restore request; opt-out recorded in audit; one-click restore onto the same or
a new PC after licence re-binding; backup failure alerts; restore runbook and rehearsal checklist.
A restore must delete `system_meta` key `events.stream_id` before the server starts, so every
device does a full refresh instead of resuming from sequences of the lost timeline (P0-12).
Acceptance: automated backup → wipe → restore test with RPO/RTO measured; tampered backup detected.

## P7-06 Data lifecycle

Requirements: DATA-006 to DATA-012, AUD-004 (purge role), §9.3 retention, §12 GST retention.
Depends on: P7-05.
Deliverables: storage monitoring by category with 80/90 % warnings; automatic purge of operational
data after 90 days; archive-then-purge (Owner + 2FA, whole financial years, encrypted checksummed
archive + human-readable export, read-back verification, then delete using the `rp_purge` role and
write a purge record; statutory-period warning); archive viewer (S); full data export in open formats
at any time including restricted mode; personal-data erasure/anonymisation; data-volume test for the
100 GB / 5 years sizing target.
Acceptance: scenario S10 parts: archive-then-purge with verification; erasure keeps invoices.

## P7-07 Onboarding wizard completion and go-live check

Requirements: ONB-001 to ONB-004, ONB-008, ONB-009, ONB-010 (S), ONB-011, BO-5.
Depends on: P1-01 to P1-05, P0-11, P5-04, P7-01 (activation).
Deliverables: resumable first-run wizard in the console covering all 11 steps (profile, tax, invoice,
accounts with Owner 2FA, floor, stations/printers with test print, menu import, staff and PINs,
device pairing, QR table tents, guided go-live test order through every path); activation code entry
binding the licence; settings export/import (S); printable site-readiness checklist.
Acceptance: Playwright run through the whole wizard on a fresh install; timing notes for ONB-009.

## P7-08 Diagnostics, support screen and remote configuration

Requirements: UPD-008, UPD-009, UPD-010, NFR-I03, NFR-O02, VCP-007.
Depends on: P7-02.
Deliverables: "Send diagnostics to support" bundle (logs, versions, configuration without secrets,
device list) and Control Plane request flow that asks the manager to allow it; support screen;
vendor-controlled remote settings and feature flags visible to the manager and audited; error
reporting wired to the vendor service (Sentry or equivalent) with PII and secret scrubbing; no remote
shell.
Acceptance: diagnostics bundle contains no secrets (test scans for known secret patterns).

## P7-09 Digital bills (WhatsApp/SMS)

Requirements: BILL-012 (S), BILL-011 (consent), OI-06, BRD §12 (TRAI DLT, WhatsApp templates).
Depends on: P1-10, P7-02. Business Owner: provider accounts and registrations (items 13).
Deliverables: provider adapter interface with a WhatsApp implementation first; send only with
consent; offline queue; hosted bill copy expiring after 30 days.
Acceptance: adapter tests with a fake provider; consent enforcement test.

## P7-10 Phase 7 exit test: S8, S9, S10

Depends on: P7-01 to P7-09.
Deliverables: automated scenarios for licence staging and reactivation online/offline with export in
restricted mode (S8), update failure rollback (S9), backup/restore to a new PC and archive-then-purge
with archive viewer (S10).
Acceptance: all pass; summary in PROGRESS.md.
