# Phase 8: Hardening and pilot

BRD §17 Phase 8 and §18. Exit criteria: §18 acceptance met (S1 to S14 pass, no open Sev-1/Sev-2,
penetration test with no open Critical/High findings), pilot KPIs measured, pilot of 1 to 2
restaurants for at least 4 weeks.

---

## P8-01 Load and capacity tests

Requirements: BRD §7.1 (NFR-P01 to NFR-P12), §7.2 capacity, S1, DATA-012, RPT-018.
Deliverables: k6 (or similar) scenarios simulating 100 tables, 60 tablets, 30 pagers, 20 waiter
devices, 6 KDS, 8 printers, 2,000 orders/day with a 300/hour peak and 200 concurrent real-time
connections; simulated MQTT pagers; a generated 5-year dataset for report and sizing tests; a report
of p95 figures against every NFR-P target. S1 dinner rush on the lab rig with real devices.
Acceptance: all targets met or tickets raised with fixes.

Split (2026-10-09), because the simulated rush, the online targets and the lab rig are separate
pieces of work:

### P8-01a The simulated rush at design capacity

Requirements: NFR-P01, NFR-P02, NFR-P03, NFR-P04, NFR-P08, NFR-P09, NFR-P10, NFR-P11, §7.2, S1
(simulated part: zero lost or duplicate orders and KOTs).
Deliverables: a load harness in `apps/server/test/load/` (the "similar" to k6: Node.js with the
apps' own `@rp/api-client`, Socket.io and MQTT clients). It runs the built server in a process of
its own, with TLS as on the restaurant PC. It simulates the restaurant of §7.2:

- 100 tables, 1,000 dishes and 6 stations, with 60 tablets, 20 waiter phones, 6 kitchen screens,
  POS terminals and dashboards making up 200 live connections;
- 30 pagers on MQTT and 8 network printers on TCP;
- a peak hour of 300 orders an hour as an open-loop arrival rate, on 12 months of generated
  history.

The simulated screens read again after events as the apps do. The kitchen cooks, waiters
approve, pick up and serve, diners call, cashiers bill and print, managers change availability
and run reports. At the end the server is killed and started again under all its connections.
The run reports p95 figures against each target, the server's CPU and memory, and checks that
every order, KOT, print and alert happened once. A short in-process version of the same run is
in the integration suite. The measured figures go in `docs/build/performance.md`.
Acceptance: the run passes on this Mac with every target met, or with tickets raised with fixes.

### P8-01b Online and on-screen targets

Requirements: NFR-P05, NFR-P06 (QR through the relay, during the rush), NFR-P07 (tap feedback
and screen transitions on the console, measured with the browser's Event Timing in Playwright),
NFR-P12 (already a Playwright test, P5-05b). Their figures are added to `performance.md`.
Deliverables: the rush of P8-01a with the QR relay (`@rp/relay/testing`, with its Realtime
stand-in) behind simulated internet lines, the server syncing with it as on the restaurant PC, and
diners' QR pages on the tables without a tablet doing what the QR site does (the menu every
refresh, orders sent and followed); a Playwright speed test of the console on a restaurant of the
design capacity's size with a slowed-down CPU; the QR site's LCP test run and recorded.
Acceptance: every figure in `performance.md`, each target met or fixed.

### P8-01c S1 on the lab rig [H]

Requirements: S1 with real devices: 40 tables, 3 stations, 8 waiters, 25 tablets, 10 pagers,
600 orders in 3 hours. Claude prepares the harness against a real install and the procedure. A
person runs it on the lab rig with real phones, tablets, pagers and printers and reports back.
Also measured there (P8-01b could not): NFR-P07 on the waiter phones and table tablets, and
NFR-P05 and NFR-P06 against the deployed relay (manual task 20) with the harness's QR pages.

## P8-02 Failure drills

Requirements: S2 to S5, S7, S14, NFR-A01 to NFR-A04, §7.3 failure table.
Deliverables: scripted drills for internet outage, server restart mid-service, printer failure, pager
out of range/battery dead, move table with tickets in progress, escalation; power-cut recovery on the
lab PC; a laptop on the staff Wi-Fi flooding the lab PC during service (PC-D3: the flood test of
P8-03c2a, `apps/server/test/integration/flood.int.test.ts`, ran on a development machine, not on the
Windows PC and its Wi-Fi); results recorded.
Acceptance: every drill passes; no lost or duplicate orders/KOTs.

## P8-03 Security hardening and penetration-test readiness

Requirements: SEC-000 to SEC-019, BRD §8.1 standards, SEC-016 (incident response), SEC-017.
Deliverables: STRIDE threat model per component (LAN, pager channel, relay, update pipeline, licence
mechanism) in `docs/security/`; OWASP ASVS L2 and MASVS checklists with evidence links; DAST on the
QR site, relay and Control Plane; Electron hardening review; MDM policy document; incident response
plan with CERT-In 6-hour reporting and DPDP breach notifications; fixes for all findings; support for
the external penetration test.
People needed: Business Owner engages a CERT-In empanelled testing firm.
Acceptance: zero open Critical/High; Medium findings with dated remediation plans.

Split (2026-10-10) into five, because each is a different kind of work; `docs/security/` holds
what they produce:

### P8-03a Authorisation sweep

Requirements: SEC-003, SEC-017 (automated authorisation tests), AUTH-005, AUTH-009, AUTH-010,
SEC-012, SEC-018.
Deliverables: every endpoint of the local server and the Control Plane called the way an attacker
would (no credential, unpaired device, wrong kind of device, nobody signed in, another device's
token, signed-out session, each role or vendor role without the capability, station mode, a PC on
vendor endpoints and the other way round, a revoked PC), on every build; device endpoints name the
kinds of device they serve and the guard refuses the rest; staff sign in only on staff devices,
never on a table tablet or a pager; no pairing code for a pager; the Control Plane's routes
checked against its registry; `docs/security/authorisation.md` with the evidence per surface.
Acceptance: both sweeps pass; every finding fixed.

### P8-03b STRIDE threat models

Requirements: SEC-000.
Deliverables: a STRIDE threat model per component in `docs/security/threat-models/` (the LAN and
the local server, the pager channel, the QR relay and site, the update pipeline, the licence
mechanism, the Control Plane, the desktop shell, the phones and tablets), each threat with its
mitigation and the code or test that shows it, and the gaps found, fixed or given to a WP.
Acceptance: every component covered; no unmitigated High threat without a fix or a dated plan.

Split (2026-10-10), because the models found more to fix than one pull request should hold. Each
model's threats name the part that fixes them (`Plan: P8-03b2 by <date>`), and
`pnpm security:threats` refuses a plan whose work package is done, so finishing one means updating
those threats:

- **P8-03b1 The threat models (done).** The eight models and their index in
  `docs/security/threat-models/`, `pnpm security:threats` (`infra/ci/check-threat-models.mjs`)
  checking every model's evidence on every build, the High finding fixed (the code-signing
  certificate within reach of pull-request builds) and the smallest findings fixed on the way.
  As built (2026-10-10):
  - 195 threats over the eight components, each with its code and the titles of its tests: 93
    mitigated, 13 accepted with a reason, 89 with a dated plan (P8-03b2 18, P8-03b3 9, P8-03b4 13,
    P8-03c 7, P8-03d 26, P8-03e 3, P2-05 4, manual tasks 1, 20, 21, 23, 29, 30 and 31). Eleven
    residual Highs, each planned; no Critical.
  - The checks: every file, function and test title named exists; ratings follow the OWASP matrix
    of likelihood and impact; a residual High or Critical has a plan; an open threat has a plan or
    a reason; a plan names an open work package or a manual task; the index's summary is current.
    In `pnpm check` and the CI job; its tests (`[SEC-000]`) in `pnpm ci:test`.
  - Fixed: CI signed every pull request's installer (now pushes to `main` only, in the
    `release-signing` environment; `infra/ci/signing-policy.test.mjs`); the server's database role
    could UPDATE payments, cash movements and day-ends; an unpaired pager kept its MQTT session and
    its wearer; production started without TLS; the request log wrote the `x-override-token`
    header. ADR-0015 ("RLS forced") and ADR-0018 ("one-time token") corrected; manual task 1
    makes branch protection and two-factor sign-in required; manual task 31 (the code-signing
    certificate in an HSM) added.
- **P8-03b2 Fixes on the restaurant PC.** The threats planned for P8-03b2 in the models of the
  LAN and the local server, the pager channel and the phones and tablets: approvals bound to their
  record, large bodies only from paired devices, PIN failures per device and weak PINs, erasure of
  diners' numbers on orders and bills, formulas in the data export, the workbook's inflate limit,
  the broker's limits and acknowledgements, and the waiter phone's inactivity sign-out. Split
  (2026-10-10) into three, by the part of the PC each touches (18 threats were too many for one
  pull request):
  - **P8-03b2a Sign-in and approvals** (PC-S5, PC-D2, MOBILE-S3, MOBILE-D1, PC-T2, MOBILE-E3):
    a failure budget per device (wrong PINs or passwords on one device within the lockout window
    stop it taking any for the lockout time; a manager lets it take them again from the Devices
    page); wrong PINs typed on a table tablet count against the tablet, not the person; easily
    guessed PINs refused when a PIN is set (a setting, on by default); managers and the Owner
    alerted to every lockout (`SIGN_IN_LOCKED`), the alert cleared when the lock is lifted; an
    approval for a voided item, a reopened or voided invoice or a discount above the limit must
    name its record and works only on it, refused without being spent on another; the apps tell
    the server how long the person has been idle (`x-rp-idle-seconds`), so reads a waiter phone
    makes by itself no longer keep the session alive.
  - **P8-03b2b The pager broker** (PAGER-D3, PAGER-D4, PAGER-D6, PAGER-E3, PAGER-R2, PAGER-R3,
    PAGER-T1, PAGER-T4): packet, connection, sign-in time and Argon2 limits, heartbeat rate and
    retained messages, the connected-pager list, the licence's pager limit, acknowledgements only
    of alerts sent to the pager and recorded with it, failed sign-ins logged and counted, and no
    firmware release with a lower secure version. Done (2026-10-10): every TCP connection admitted
    before its TLS handshake (4 sign-ins in progress per address, 64 in all, 256 connections), 10 s
    to sign in, packets checked at their header (1 KB before sign-in, 4 KB after), 2 Argon2id
    checks at once with 64 waiting (`apps/server/src/pagers/broker-limits.ts`); heartbeats faster
    than half the interval dropped, retained, QoS 2 and will messages refused; a pager's button
    acknowledges only alerts sent to it and the device is recorded with every acknowledgement; a
    pager counts as connected once the broker has its client; failed sign-ins logged once a minute
    per address and counted on the pager (shown on the Pagers page); the licence's pager limit;
    firmware with a lower anti-rollback version refused. Seven threats mitigated; PAGER-T4's
    remaining part is the pager's eFuse (P2-05). What the broker refuses is in
    `firmware/pager/README.md` for P2-05.
  - **P8-03b2c Bodies, uploads, exports and erasure** (PC-D1, PC-D4, PC-T8, PC-I9): a device
    check before the large body parsers, the workbook inflated with a limit on what comes out,
    `csvCell` in the data export and the invoice register, and erasure of a diner's number on
    orders and bills. Done (2026-10-10): the device token checked before any body is read, 16 KB
    for a caller without a paired device and a larger announced body refused before it is read
    (`apps/server/src/http/body-limits.ts`); the workbook's XML parts inflated by the server a
    byte past the directory's size at most, and given to the reader again stored; `csvCell` in
    the data export's CSV files and the invoice register; erasure clears the number on orders and
    bills (matched on its last ten digits) and withdraws the invoices' consent, so no digital bill
    goes to it again, leaving sent ones as they were. Four threats mitigated.
- **P8-03b3 Fixes to the licence and the update pipeline.** The threats planned for P8-03b3: the
  clock guard, fingerprint reads, licence replay, reactivation reports, tamper alerts, builds
  without vendor keys, the updater's version check and pinned CI actions. Split (2026-10-10) into
  two, by where the fix lives:
  - **P8-03b3a The licence** (LICENCE-S3, LICENCE-T3, LICENCE-T4, LICENCE-D2, LICENCE-R3): the
    judged time moving on with the server's running time and never behind the signed issue times,
    a clock held back reported, the newest issue time kept and an older file counted as tampered,
    a fingerprint read of fewer than three identifiers neither kept nor judged (nor bound by the
    Control Plane), codes reaching 60 days at most, the last code taken reported and compared with
    those issued, and a licence tampering fleet alert (SEC-015). Done (2026-10-10): `guardedNow`
    takes the last judged time and clock, the monotonic time since and the signed floors (the
    heartbeat answer's server time is not one: it is not signed); the sealed record keeps
    `clockAt`, `newestIssuedAt` and `lastCode`; `fingerprintKnown`; the Control Plane's
    `licence_reactivation_codes` and `checkReactivation`; `tamperAlertDue` (serious kinds and an
    unissued code at once, the clock's after three reports in seven days) and the
    `LICENCE_TAMPERING` alert, closed by a person with a reason. Five threats mitigated or
    accepted with what remains.
  - **P8-03b3b The update pipeline and the builds** (UPDATE-T1, UPDATE-T3, UPDATE-E3, LICENCE-D3):
    every GitHub Action pinned to a commit with a test that keeps them pinned, the updater refusing
    an installer whose product version is not the one asked for, the heartbeat saying whether the
    PC takes unsigned updates with a fleet alert for it, and the build's guard a tested function
    that also refuses a signed build without the licence keys or the pager firmware keys. Done
    (2026-10-10): every Action in the three workflows at a full commit with its version in a
    comment, one commit per Action, Dependabot's cooldown for Actions too
    (`infra/ci/pinned-actions.test.mjs`); the installer's product version (its version resource)
    compared with the version asked for by the agent after the download
    (`installerVersionProblem`) and by the updater before it stops anything
    (`Get-RPInstallerVersion`); `updateSigning` on the heartbeat (`updateSigningOf`) and the
    `UNSIGNED_UPDATES` fleet alert, which closes by itself once a signed build replaces the test
    build; `release-guard.ts` (`releaseRefusals`), which refuses a signed build that allows
    unsigned updates, names no publisher, was staged off Windows, or whose staged server has no
    licence key or pager firmware key digest (`stagedKeys`). Four threats mitigated; P8-03b3 is
    done.
- **P8-03b4 Fixes in the Control Plane and the QR relay.** The threats planned for P8-03b4: backup
  dates and retention, diagnostics retention, vendor sign-in races, tenant isolation (an ADR and a
  cross-tenant test), https for every service, bill links in logs, the relay's service-request and
  order limits, body limits, the provisioning role and the photo bucket. Split (2026-10-10) into
  two, by component, as P8-03b2 and P8-03b3 were (13 threats):
  - **P8-03b4a The Control Plane** (CP-S1, CP-T2, CP-I2, CP-I3, CP-I4, CP-D3, CP-E3): each
    sign-in try counted before it is checked and a code's step spent once, one answer for an
    unknown email, a disabled account and a wrong password; retention by the times the Control
    Plane stored each backup, no backup dated after its clock and a few a day per PC; diagnostics
    deleted after 30 days; https for every outside service and the bill and grant tokens masked in
    the request log; ADR-0021 and a test that calls every PC endpoint with another restaurant's
    ids; the AI limit counted under a lock; a Super Admin's reset by two other Super Admins.
    Done (2026-10-10): `VendorAuthService.signIn` claims a try in one `UPDATE` before Argon2 and
    spends the step with a conditional update, and counts emails without a usable account in
    memory so they lock alike; `CloudBackupsService` keeps by `completedAt`, refuses a date more
    than 10 minutes ahead (`CLOUD_BACKUP_DATE`) and starts 8 files a day per PC under an advisory
    lock (`CLOUD_BACKUP_LIMIT`), the bucket's object lock in manual task 26;
    `DiagnosticsService.purge` hourly, audited; `OUTSIDE_SERVICES` in the configuration and
    `src/http/log-redaction.ts`; `tenant-isolation.int.test.ts` with a case per PC endpoint of the
    registry; `lockFor` for AI menus and digital bills; reset requests on `vendor_users`, a 202
    for the first Super Admin and the setup link for the second, shown on the Staff page. Six
    threats mitigated, CP-T2 partly (the object lock is the vendor's to set up).
  - **P8-03b4b The QR relay** (RELAY-D1, RELAY-D2, RELAY-D3, RELAY-E3, RELAY-I5, RELAY-T8):
    rejected orders not counted against the table, service requests limited per table and per
    browser under a lock, bodies refused by `content-length` and read with a cap, the functions'
    login without the provisioning role and a provisioning login for the Control Plane, no CORS
    on the PCs' function, and the photo bucket WebP only in every configuration. Done
    (2026-10-10): `relay.rate_limit_wait` no longer counts `REJECTED` orders against the table;
    `relay.service_request_wait` (10 a table, 6 a browser in 10 minutes, rejected ones not counted
    at the table) under per-table and per-browser advisory locks; `readCapped` in
    `infra/supabase/src/http.ts` (512 KB for the diners' functions, 8 MB for `server`), with the
    table code or the credential checked for its form before any body is read; the
    `relay_control_plane` login, a member of `relay_provisioner` only, and `relay_edge` no longer
    one; `serveRoutes(..., { browsers: false })` for `server`; WebP only in `config.toml` and the
    photos table. Six threats mitigated; `docs/runbooks/qr-relay.md`. P8-03b is done.

Acceptance of each fix part: no threat planned for it is left open; `pnpm security:threats` passes.

### P8-03c DAST of the QR site, relay and Control Plane

Requirements: SEC-017, SEC-001, SEC-004.
Deliverables: OWASP ZAP scans (baseline and API scan from the OpenAPI documents) of the QR site,
the relay functions, the Control Plane and the local server's HTTPS, runnable locally and in CI;
security headers; fixes for the findings; results in `docs/security/dast.md`. Also every threat
whose plan names P8-03c in `docs/security/threat-models/` (the summary in its README lists them).
Acceptance: no open High finding; the rest triaged; no threat left planned for P8-03c.

Split (2026-10-10) in two, because the scans and the headers they check are one piece of work
and the floods, which need load from the LAN and limits at the edge, are another:

- **P8-03c1 The ZAP scans, security headers and the CSPs (done).** `infra/dast` (`@rp/dast`) starts the
  four surfaces as they run for real (the QR site with its relay, the relay's functions, the
  Control Plane with the vendor web app, the local server over HTTPS with the console), signs in
  where a surface needs it, and runs OWASP ZAP's Automation Framework on each: the pages spidered
  and passively scanned, the OpenAPI documents imported and actively scanned. Every finding is
  judged against `infra/dast/triage.json`: a High is never accepted, everything else needs a
  reason. Runnable on a developer's machine (`ZAP_PATH`) and in CI (the ZAP container, a job in
  `security.yml`). Also: security headers on every API answer (local server, Control Plane,
  relay); the QR site's CSP with a nonce per request instead of `'unsafe-inline'` scripts
  (RELAY-T5); Trusted Types in the console's CSP, and the vendor web app's (PC-I4, DESKTOP-I1);
  `/version` without the exact Node.js version (PC-I2); the results in `docs/security/dast.md`.
  Acceptance: no open High finding, the rest triaged; those four threats no longer planned for
  P8-03c.
- **P8-03c2 Floods and rate limits.** PC-D3 (flood tests of the HTTPS server and the socket from
  the LAN: connections per device, handshakes, timeouts, and the limits they show are needed),
  CP-D1 (rate limits in front of the Control Plane), RELAY-D4 (reads of the menu and order status
  throttled at the relay and the site). Acceptance: the flood tests pass; no threat left planned
  for P8-03c2. Split (2026-10-10) in two, because the LAN and the cloud's edges are limited in
  different places:
  - **P8-03c2a Floods from the LAN (PC-D3) (done).** The local server's HTTPS port: connections
    per address and in all, how fast an address opens them and sends requests (429 and the
    connection closed), the TLS handshake and the request headers within 10 s; the socket: live
    connections and handshakes per device, a connection that stops reading closed; the PC's own
    address never limited. Flood tests from two addresses over HTTPS. Acceptance: the flood tests
    pass, the load test's rush is not limited; PC-D3 mitigated. As built: `limitFloods` in
    `apps/server/src/http/flood-limits.ts` with `DEFAULT_SERVER_LIMITS` (256 connections per
    address, 4,096 in all, 120 new at once then 20 a second, 400 requests at once then 100 a
    second, 10 s for the handshake and the headers, 5 s idle), the mechanisms shared with the
    pager broker in `src/common/flood-limits.ts`; `forceCloseConnections`, since connections held
    without a request kept the server from stopping; per device on the socket 16 connections and
    60 handshakes a minute (`TOO_MANY_CONNECTIONS`, retried by the apps), and a connection with
    1,000 messages waiting and none written in a sweep destroyed; `flood.int.test.ts` from
    127.0.0.1 and ::1, with a flood at full speed from a worker thread against the production
    limits.
  - **P8-03c2b Floods at the cloud's edges (CP-D1, RELAY-D4) (done).** Rate limits in the Control
    Plane and the configuration of the edge in front of it; the relay's reads throttled per table
    and the QR site's menu fetch made cheap; the checks against a deployment. Acceptance: no threat
    left planned for P8-03c2. As built: `requestLimitMiddleware` in the Control Plane (per address
    300 at once then 30 a second, digital bill pages 60 then 5, `/v1/health` never; settings
    `CP_REQUEST_BURST` and the three others; staging and production need `CP_TRUST_PROXY`);
    `ReadThrottle` in the relay's functions (per table token 40 then 5 a second, per address 120
    then 20) before the database; `sharedMenu` on the QR site (one read of the relay per table in
    5 s); `infra/edge` with the rules the edge must have and `check-edge.mjs`, which floods a
    deployment and expects 429 with `Retry-After`; the edge itself needs the hosting accounts
    (manual task 32), so CP-D1 and RELAY-D4 stay "Partly mitigated" with that plan.

### P8-03d Standards checklists, Electron review and MDM policy

Requirements: BRD §8.1 (OWASP ASVS L2, OWASP Top 10 and API Top 10, MASVS-L1 with resilience for
the kiosk tablet, ETSI EN 303 645, CIS for the Windows host), SEC-010, SEC-011.
Deliverables: each checklist with every control's status and its evidence link; the Electron
hardening review; the MDM policy document for phones and tablets. Also every threat whose plan
names P8-03d in `docs/security/threat-models/` (26 at P8-03b: the PC's administrator account and
BitLocker, the database's service account, the CA's name constraints, the Electron shell's
developer tools, debugging switches and device permissions, the kiosk's restrictions, the phones'
backups and screen capture, build provenance, LIC-007's integrity checks).
Acceptance: every control met, not applicable with a reason, or a finding with a plan; no threat
left planned for P8-03d.

Split (2026-10-10): P8-03d1 is the Electron shell's hardening, as built: the shell quits on a
debugging switch, the POS window has no developer tools or menu, devices and their pickers are
refused, the CA pin decides on the PC's own address, and the shell logs to
`<data folder>/logs/desktop-shell.log`. P8-03d2 is everything else above.

P8-03d2a (2026-10-10) is the phones and tablets, as built: `allowBackup` off in both apps, a manifest
test, `FLAG_SECURE` while a PIN pad shows (`setScreenGuard` in `@rp/ui-native`), a private
lock-screen alert with Acknowledge after unlocking (channel `rp.alerts.v2`), the kiosk's user
restrictions, `docs/runbooks/mdm-policy.md` (root detection left to the MDM) and manual task 33 for
the device checks. P8-03d2b is the checklists (ASVS, MASVS, ETSI, CIS) and the PC, Control Plane,
update and licence threats still planned for P8-03d.

P8-03d2b1 (2026-10-11) is the Control Plane's, as built: ten sensitive operations
(`STEP_UP_OPERATIONS`) ask for a new authenticator code in `x-rp-step-up` (CP-S2); every audit entry
is also a log line for the host (CP-T5); every vendor read is classified (CP-R1); the access policy
names the CLI's host (CP-R2); manual task 34 for the host's log store. P8-03d2b2 is the
checklists and the PC, update and licence threats.

P8-03d2b2 (2026-10-11) is split: **a** UPDATE-S2, the update signer pinned by its issuer as well as its
subject (`RP_UPDATE_ISSUER`; done); **b** UPDATE-R3 (b1, done: the `release-evidence` job) and LICENCE-T5 (b2); **c** the PC's threats (PC-E2, I5,
I6, S4, T7, D6; DESKTOP-E4; c1 done: the procedures and the BitLocker warning; c2: I6 and S4); **d** the four checklists (done: `docs/security/checklists/`, `pnpm security:checklists`).

### P8-03e Incident response plan and penetration-test support (done 2026-10-11)

Requirements: SEC-016, SEC-017.
Deliverables: the incident response plan (severities, contacts and on-call, CERT-In within 6 hours,
DPDP breach notifications, templates for restaurants, the annual tabletop exercise); the pack for
the testing firm (scope, rules of engagement, test environment and accounts, what to send back).
People needed: the Business Owner names the CERT-In point of contact and engages the firm; the
external test and fixing its findings follow it [H].
Also every threat whose plan names P8-03e in `docs/security/threat-models/` (a stolen relay
credential, fake QR stickers, ransomware), and the threat models in the testers' pack.
Acceptance: plan reviewed by the Business Owner; the firm can start from the pack.

## P8-04 UX polish and accessibility audit

Requirements: NFR-U01 to NFR-U07, KDS-011, TAB-016.
Deliverables: audit of every screen for empty, loading and error states and plain-language errors;
touch targets; WCAG 2.2 AA audit of QR menu and dashboard; usability test scripts for 5 users per
role (waiter proficient ≤ 30 min, diner first order ≤ 2 min, split bill ≤ 1 min); contextual help (S).
Acceptance: audit issues closed; usability results recorded.

## P8-05 Runbooks, manuals and training material

Requirements: NFR-M06, NFR-U07, BRD §19.3 (manuals, training videos approved by the Business Owner).
Deliverables in `docs/runbooks/` and `docs/manuals/`: installation, restore, update, rollback,
incident response, support playbook, developer onboarding guide; user manuals per role; scripts for
training videos.
Acceptance: Business Owner review.

## P8-06 Pilot readiness

Requirements: BRD §18.3 acceptance, §2 KPIs, R-04 (approval time), R-06.
Deliverables: `pnpm trace --strict` passes (every Must requirement linked to a passing test); UAT
plan and results; go-live checklist; KPI measurement plan and dashboards for the pilot (approval
time, ack time, ready-to-pickup, attach rate, availability); pilot feedback loop.
Acceptance: pilot entry criteria met and signed off by the Business Owner.
