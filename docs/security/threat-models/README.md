# Threat models (STRIDE)

SEC-000: a STRIDE threat model of each component, kept current at each major release. Written in
P8-03b (2026-10-10) from the code as built, by reading it the way an attacker would. Each threat
names the code that answers it and the tests that prove it, so the models are evidence for the
penetration testers (P8-03e) and the standards checklists (P8-03d), not a description of intent.

| Model                                                   | Covers                                                                                                                                   |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| [The LAN and the local server](local-server-and-lan.md) | The restaurant PC's server and database, the staff network, devices, sign-in, money records, the audit log, backups and the Windows host |
| [The pager channel](pager-channel.md)                   | The MQTT broker on the PC, the pagers' credentials and topics, alerts and acknowledgements, firmware through the PC                      |
| [The QR relay and site](qr-relay-and-site.md)           | The diners' QR site, the Supabase relay, its functions and Row-Level Security, the PC's sync agent                                       |
| [The update pipeline](update-pipeline.md)               | CI, signing, releases and rollouts, the PC's update agent and updater, the phones' EAS and APK updates                                   |
| [The licence mechanism](licence-mechanism.md)           | Signed licences, the PC fingerprint, the clock guard, reactivation codes, enforcement                                                    |
| [The Vendor Control Plane](control-plane.md)            | Vendor staff, restaurant PCs' signed requests, tenants, cloud backups and key escrow, diagnostics, remote settings                       |
| [The desktop shell](desktop-shell.md)                   | The Electron POS window on the PC and the console it loads                                                                               |
| [The phones and tablets](phones-and-tablets.md)         | The waiter app, the table tablet in kiosk mode and the Android code they share                                                           |

## How each model is written

- **Scope**, **Assets**, **Entry points**, **Trust boundaries** and **Data flows**, then the
  threats under the six STRIDE categories: Spoofing, Tampering, Repudiation, Information
  disclosure, Denial of service and Elevation of privilege.
- Each threat has an id (`PC-S1`: component, category, number), what the attacker does, and:
  - **Mitigation**: what the software does about it, in plain words;
  - **Code**: the files and the functions, classes or settings in them;
  - **Tests**: test files and the titles of the tests that show it, copied from the files (or
    "none" and why: a procedure, a design limit);
  - **Risk**: the likelihood and impact of what is left after the mitigation, and the rating they
    give (the OWASP Risk Rating matrix: Low × High is Medium, Medium × High is High, High × High
    is Critical, anything with a Low on both sides of Medium is Low);
  - **Status**: `Mitigated`, `Partly mitigated`, `Not mitigated` or `Accepted`. Anything not
    mitigated carries `Plan: <work package or manual task> by <date>` or `Accepted: <why>`. A
    residual High or Critical always has a plan. "Fixed in P8-03b" marks what was found and fixed
    while writing the models.

Dates are targets set in P8-03b. For work that needs hardware or a person (`[H]` work packages,
manual tasks) they are the latest that still leaves time before the pilot; P8-06 (pilot
readiness) reviews them.

## The checks

`pnpm security:threats` (`infra/ci/check-threat-models.mjs`, run by `pnpm check` and CI) keeps the
models honest as the code changes. It fails when:

- a component has no model, or a model lacks a section, a STRIDE category or a field;
- a file it names does not exist, a function or class it names is not in its file, or a test
  title it quotes is not in its test file (so renaming a test means updating the model);
- a rating does not follow from its likelihood and impact;
- a residual High or Critical has no plan, or an open threat has neither a plan nor a reason to
  accept it;
- a plan names a work package that does not exist or is already done (finish the work package by
  updating the threats it planned for), or a manual task that does not exist;
- the summary below is out of date (`pnpm security:threats --write` rewrites it).

Its own tests (`infra/ci/check-threat-models.test.mjs`, `pnpm ci:test`) carry SEC-000.

## Keeping them current

- A change to a component's surface (a new endpoint, topic, file it trusts, secret or device)
  updates its model in the same pull request; a security-sensitive pull request says which threats
  it touches.
- A work package that a plan names updates those threats when it is done: `Mitigated` with its
  code and tests, or a new plan.
- At each major release (SEC-000), and before the penetration test, read every model again
  against the code, and add what the release added.

## Summary

<!-- threat-summary:start -->

Written by `pnpm security:threats --write` from the models; do not edit it by hand.

| Component                                               | Threats | Mitigated | Partly mitigated | Not mitigated | Accepted | Residual Medium | Residual High or Critical |
| ------------------------------------------------------- | ------: | --------: | ---------------: | ------------: | -------: | --------------: | ------------------------: |
| [The LAN and the local server](local-server-and-lan.md) |      45 |        24 |               14 |             4 |        3 |              23 |                         3 |
| [The pager channel](pager-channel.md)                   |      26 |        12 |               10 |             3 |        1 |               4 |                         2 |
| [The QR relay and site](qr-relay-and-site.md)           |      29 |        15 |                8 |             4 |        2 |               9 |                         0 |
| [The update pipeline](update-pipeline.md)               |      21 |        11 |                7 |             2 |        1 |              11 |                         2 |
| [The licence mechanism](licence-mechanism.md)           |      20 |        10 |                6 |             3 |        1 |               7 |                         2 |
| [The Vendor Control Plane](control-plane.md)            |      22 |         8 |               12 |             1 |        1 |               8 |                         1 |
| [The desktop shell](desktop-shell.md)                   |      14 |         5 |                5 |             3 |        1 |               7 |                         0 |
| [The phones and tablets](phones-and-tablets.md)         |      18 |         8 |                7 |             3 |        0 |               6 |                         1 |
| All                                                     |     195 |        93 |               69 |            23 |       10 |              75 |                        11 |

Open threats and their plans, by date:

| Threat                                                                                                                                      | Residual | Status           | Plan           | By         |
| ------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------- | -------------- | ---------- |
| [MOBILE-D1](phones-and-tablets.md#mobile-d1-a-diner-locking-managers-out-from-a-tablet) A diner locking managers out from a tablet          | Medium   | Not mitigated    | P8-03b2        | 2026-10-13 |
| [MOBILE-E3](phones-and-tablets.md#mobile-e3-a-lost-phone-still-signed-in) A lost phone still signed in                                      | Medium   | Partly mitigated | P8-03b2        | 2026-10-13 |
| [MOBILE-S3](phones-and-tablets.md#mobile-s3-a-diner-guessing-a-managers-pin-at-a-tablet) A diner guessing a manager's PIN at a tablet       | High     | Partly mitigated | P8-03b2        | 2026-10-13 |
| [PAGER-D3](pager-channel.md#pager-d3-flooding-the-broker-without-a-credential) Flooding the broker without a credential                     | High     | Not mitigated    | P8-03b2        | 2026-10-13 |
| [PAGER-D4](pager-channel.md#pager-d4-a-signed-in-pager-publishing-too-much) A signed-in pager publishing too much                           | Low      | Partly mitigated | P8-03b2        | 2026-10-13 |
| [PAGER-D6](pager-channel.md#pager-d6-a-pager-the-pc-wrongly-thinks-is-connected) A pager the PC wrongly thinks is connected                 | Low      | Partly mitigated | P8-03b2        | 2026-10-13 |
| [PAGER-E3](pager-channel.md#pager-e3-more-pagers-than-the-licence-allows) More pagers than the licence allows                               | Low      | Partly mitigated | P8-03b2        | 2026-10-13 |
| [PAGER-R2](pager-channel.md#pager-r2-i-did-not-press-it) "I did not press it"                                                               | Low      | Partly mitigated | P8-03b2        | 2026-10-13 |
| [PAGER-R3](pager-channel.md#pager-r3-failed-pager-sign-ins-leave-no-trace) Failed pager sign-ins leave no trace                             | Low      | Not mitigated    | P8-03b2        | 2026-10-13 |
| [PAGER-T1](pager-channel.md#pager-t1-a-forged-acknowledgement) A forged acknowledgement                                                     | Low      | Partly mitigated | P8-03b2        | 2026-10-13 |
| [PAGER-T4](pager-channel.md#pager-t4-going-back-to-older-firmware) Going back to older firmware                                             | Low      | Partly mitigated | P8-03b2        | 2026-10-13 |
| [PC-D1](local-server-and-lan.md#pc-d1-large-bodies-before-authentication) Large bodies before authentication                                | Medium   | Not mitigated    | P8-03b2        | 2026-10-13 |
| [PC-D2](local-server-and-lan.md#pc-d2-lockouts-used-to-stop-the-restaurant) Lockouts used to stop the restaurant                            | Medium   | Partly mitigated | P8-03b2        | 2026-10-13 |
| [PC-D4](local-server-and-lan.md#pc-d4-decompression-bombs-in-uploads) Decompression bombs in uploads                                        | Medium   | Partly mitigated | P8-03b2        | 2026-10-13 |
| [PC-I9](local-server-and-lan.md#pc-i9-diners-personal-data-kept-after-they-ask) Diners' personal data kept after they ask                   | Medium   | Partly mitigated | P8-03b2        | 2026-10-13 |
| [PC-S5](local-server-and-lan.md#pc-s5-guessing-a-pin) Guessing a PIN                                                                        | High     | Partly mitigated | P8-03b2        | 2026-10-13 |
| [PC-T2](local-server-and-lan.md#pc-t2-a-managers-approval-used-on-another-record) A manager's approval used on another record               | Medium   | Not mitigated    | P8-03b2        | 2026-10-13 |
| [PC-T8](local-server-and-lan.md#pc-t8-formulas-in-exported-files) Formulas in exported files                                                | Medium   | Partly mitigated | P8-03b2        | 2026-10-13 |
| [LICENCE-D2](licence-mechanism.md#licence-d2-a-failed-fingerprint-read-taken-for-another-pc) A failed fingerprint read taken for another PC | Medium   | Not mitigated    | P8-03b3        | 2026-10-15 |
| [LICENCE-D3](licence-mechanism.md#licence-d3-a-release-with-no-vendor-keys) A release with no vendor keys                                   | Medium   | Not mitigated    | P8-03b3        | 2026-10-15 |
| [LICENCE-R3](licence-mechanism.md#licence-r3-tampering-nobody-looks-at) Tampering nobody looks at                                           | Low      | Partly mitigated | P8-03b3        | 2026-10-15 |
| [LICENCE-S3](licence-mechanism.md#licence-s3-a-forged-reactivation-code) A forged reactivation code                                         | Low      | Partly mitigated | P8-03b3        | 2026-10-15 |
| [LICENCE-T3](licence-mechanism.md#licence-t3-holding-the-clock-back) Holding the clock back                                                 | High     | Partly mitigated | P8-03b3        | 2026-10-15 |
| [LICENCE-T4](licence-mechanism.md#licence-t4-putting-an-older-licence-back) Putting an older licence back                                   | Low      | Partly mitigated | P8-03b3        | 2026-10-15 |
| [UPDATE-E3](update-pipeline.md#update-e3-an-unsigned-test-build-at-a-restaurant) An unsigned test build at a restaurant                     | Medium   | Partly mitigated | P8-03b3        | 2026-10-15 |
| [UPDATE-T1](update-pipeline.md#update-t1-a-compromised-dependency-or-action) A compromised dependency or Action                             | High     | Partly mitigated | P8-03b3        | 2026-10-15 |
| [UPDATE-T3](update-pipeline.md#update-t3-going-back-to-an-older-version) Going back to an older version                                     | Low      | Partly mitigated | P8-03b3        | 2026-10-15 |
| [UPDATE-E2](update-pipeline.md#update-e2-a-pull-request-signed-as-the-vendors) A pull request signed as the vendor's                        | Medium   | Partly mitigated | manual task 1  | 2026-10-17 |
| [UPDATE-T6](update-pipeline.md#update-t6-unreviewed-code-on-main) Unreviewed code on main                                                   | High     | Not mitigated    | manual task 1  | 2026-10-17 |
| [CP-D3](control-plane.md#cp-d3-going-past-the-daily-ai-limit) Going past the daily AI limit                                                 | Low      | Partly mitigated | P8-03b4        | 2026-10-17 |
| [CP-E3](control-plane.md#cp-e3-one-super-admin-taking-over-another) One Super Admin taking over another                                     | Medium   | Partly mitigated | P8-03b4        | 2026-10-17 |
| [CP-I2](control-plane.md#cp-i2-personal-data-in-diagnostics-bundles) Personal data in diagnostics bundles                                   | Low      | Partly mitigated | P8-03b4        | 2026-10-17 |
| [CP-I3](control-plane.md#cp-i3-secrets-and-links-in-configuration-and-logs) Secrets and links in configuration and logs                     | Low      | Partly mitigated | P8-03b4        | 2026-10-17 |
| [CP-I4](control-plane.md#cp-i4-one-restaurant-reading-anothers-data) One restaurant reading another's data                                  | Medium   | Partly mitigated | P8-03b4        | 2026-10-17 |
| [CP-S1](control-plane.md#cp-s1-guessing-or-stuffing-vendor-passwords) Guessing or stuffing vendor passwords                                 | Medium   | Partly mitigated | P8-03b4        | 2026-10-17 |
| [CP-T2](control-plane.md#cp-t2-a-compromised-pc-deleting-its-own-cloud-backups) A compromised PC deleting its own cloud backups             | High     | Not mitigated    | P8-03b4        | 2026-10-17 |
| [RELAY-D1](qr-relay-and-site.md#relay-d1-flooding-a-table-with-orders) Flooding a table with orders                                         | Medium   | Partly mitigated | P8-03b4        | 2026-10-17 |
| [RELAY-D2](qr-relay-and-site.md#relay-d2-flooding-a-table-with-service-requests) Flooding a table with service requests                     | Low      | Partly mitigated | P8-03b4        | 2026-10-17 |
| [RELAY-D3](qr-relay-and-site.md#relay-d3-large-bodies-before-any-check) Large bodies before any check                                       | Low      | Not mitigated    | P8-03b4        | 2026-10-17 |
| [RELAY-E3](qr-relay-and-site.md#relay-e3-the-functions-login-can-provision-restaurants) The functions' login can provision restaurants      | Medium   | Not mitigated    | P8-03b4        | 2026-10-17 |
| [RELAY-I5](qr-relay-and-site.md#relay-i5-cross-origin-answers-from-the-pcs-function) Cross-origin answers from the PCs' function            | Low      | Partly mitigated | P8-03b4        | 2026-10-17 |
| [RELAY-T8](qr-relay-and-site.md#relay-t8-other-files-in-the-photo-bucket) Other files in the photo bucket                                   | Low      | Partly mitigated | P8-03b4        | 2026-10-17 |
| [CP-D1](control-plane.md#cp-d1-flooding-the-control-plane) Flooding the Control Plane                                                       | Low      | Partly mitigated | P8-03c         | 2026-10-19 |
| [DESKTOP-I1](desktop-shell.md#desktop-i1-script-in-the-console-reading-its-session) Script in the console reading its session               | Low      | Partly mitigated | P8-03c         | 2026-10-19 |
| [PC-D3](local-server-and-lan.md#pc-d3-flooding-the-server-or-the-socket) Flooding the server or the socket                                  | Low      | Partly mitigated | P8-03c         | 2026-10-19 |
| [PC-I2](local-server-and-lan.md#pc-i2-internals-in-answers) Internals in answers                                                            | Low      | Partly mitigated | P8-03c         | 2026-10-19 |
| [PC-I4](local-server-and-lan.md#pc-i4-script-in-the-console-reading-its-credentials) Script in the console reading its credentials          | Low      | Partly mitigated | P8-03c         | 2026-10-19 |
| [RELAY-D4](qr-relay-and-site.md#relay-d4-unthrottled-reads-and-their-cost) Unthrottled reads and their cost                                 | Medium   | Not mitigated    | P8-03c         | 2026-10-19 |
| [RELAY-T5](qr-relay-and-site.md#relay-t5-script-or-printer-commands-in-what-diners-type) Script or printer commands in what diners type     | Low      | Partly mitigated | P8-03c         | 2026-10-19 |
| [CP-R1](control-plane.md#cp-r1-vendor-staff-deny-an-action) Vendor staff deny an action                                                     | Low      | Partly mitigated | P8-03d         | 2026-10-22 |
| [CP-R2](control-plane.md#cp-r2-changes-through-the-admin-cli) Changes through the admin CLI                                                 | Medium   | Partly mitigated | P8-03d         | 2026-10-22 |
| [CP-S2](control-plane.md#cp-s2-a-stolen-vendor-session) A stolen vendor session                                                             | Medium   | Partly mitigated | P8-03d         | 2026-10-22 |
| [CP-T5](control-plane.md#cp-t5-editing-the-vendors-audit-log) Editing the vendor's audit log                                                | Low      | Partly mitigated | P8-03d         | 2026-10-22 |
| [DESKTOP-E2](desktop-shell.md#desktop-e2-chromiums-debugging-switches) Chromium's debugging switches                                        | Medium   | Not mitigated    | P8-03d         | 2026-10-22 |
| [DESKTOP-E3](desktop-shell.md#desktop-e3-usb-serial-hid-and-bluetooth-devices) USB, serial, HID and Bluetooth devices                       | Low      | Partly mitigated | P8-03d         | 2026-10-22 |
| [DESKTOP-E4](desktop-shell.md#desktop-e4-leaving-the-pos-window-for-windows) Leaving the POS window for Windows                             | Medium   | Partly mitigated | P8-03d         | 2026-10-22 |
| [DESKTOP-I3](desktop-shell.md#desktop-i3-developer-tools-in-the-pos-window) Developer tools in the POS window                               | Medium   | Not mitigated    | P8-03d         | 2026-10-22 |
| [DESKTOP-R2](desktop-shell.md#desktop-r2-the-shells-own-events-lost) The shell's own events lost                                            | Low      | Not mitigated    | P8-03d         | 2026-10-22 |
| [DESKTOP-S1](desktop-shell.md#desktop-s1-a-fake-server-on-the-pcs-own-address) A fake server on the PC's own address                        | Medium   | Partly mitigated | P8-03d         | 2026-10-22 |
| [LICENCE-T5](licence-mechanism.md#licence-t5-patching-the-server) Patching the server                                                       | High     | Not mitigated    | P8-03d         | 2026-10-22 |
| [MOBILE-E2](phones-and-tablets.md#mobile-e2-a-diner-leaving-the-kiosk) A diner leaving the kiosk                                            | Medium   | Partly mitigated | P8-03d         | 2026-10-22 |
| [MOBILE-E4](phones-and-tablets.md#mobile-e4-a-rooted-phone) A rooted phone                                                                  | Low      | Not mitigated    | P8-03d         | 2026-10-22 |
| [MOBILE-I3](phones-and-tablets.md#mobile-i3-app-data-in-androids-backups) App data in Android's backups                                     | Low      | Partly mitigated | P8-03d         | 2026-10-22 |
| [MOBILE-I4](phones-and-tablets.md#mobile-i4-pins-in-screenshots-and-the-recent-apps-list) PINs in screenshots and the recent apps list      | Low      | Not mitigated    | P8-03d         | 2026-10-22 |
| [MOBILE-R2](phones-and-tablets.md#mobile-r2-alerts-acknowledged-from-the-lock-screen) Alerts acknowledged from the lock screen              | Low      | Partly mitigated | P8-03d         | 2026-10-22 |
| [MOBILE-S1](phones-and-tablets.md#mobile-s1-a-rogue-server-or-a-man-in-the-middle) A rogue server or a man in the middle                    | Medium   | Partly mitigated | P8-03d         | 2026-10-22 |
| [MOBILE-T3](phones-and-tablets.md#mobile-t3-intents-sent-to-the-apps-components) Intents sent to the apps' components                       | Low      | Partly mitigated | P8-03d         | 2026-10-22 |
| [PC-D6](local-server-and-lan.md#pc-d6-attacks-from-guest-wi-fi-on-a-flat-network) Attacks from guest Wi-Fi on a flat network                | Medium   | Partly mitigated | P8-03d         | 2026-10-22 |
| [PC-E2](local-server-and-lan.md#pc-e2-a-windows-administrator-on-the-pc) A Windows administrator on the PC                                  | High     | Not mitigated    | P8-03d         | 2026-10-22 |
| [PC-I5](local-server-and-lan.md#pc-i5-a-stolen-pc-or-disk) A stolen PC or disk                                                              | High     | Not mitigated    | P8-03d         | 2026-10-22 |
| [PC-I6](local-server-and-lan.md#pc-i6-a-local-windows-user-reads-the-data) A local Windows user reads the data                              | Medium   | Partly mitigated | P8-03d         | 2026-10-22 |
| [PC-S4](local-server-and-lan.md#pc-s4-a-rogue-server-or-a-man-in-the-middle-on-the-lan) A rogue server or a man in the middle on the LAN    | Medium   | Partly mitigated | P8-03d         | 2026-10-22 |
| [PC-T7](local-server-and-lan.md#pc-t7-restoring-an-old-backup-to-hide-fraud) Restoring an old backup to hide fraud                          | Medium   | Partly mitigated | P8-03d         | 2026-10-22 |
| [UPDATE-R3](update-pipeline.md#update-r3-which-commit-a-signed-installer-came-from) Which commit a signed installer came from               | Medium   | Not mitigated    | P8-03d         | 2026-10-22 |
| [UPDATE-S2](update-pipeline.md#update-s2-a-certificate-with-the-vendors-name) A certificate with the vendor's name                          | Medium   | Partly mitigated | P8-03d         | 2026-10-22 |
| [PC-D7](local-server-and-lan.md#pc-d7-ransomware-or-a-dead-disk) Ransomware or a dead disk                                                  | Medium   | Partly mitigated | P8-03e         | 2026-10-24 |
| [RELAY-S3](qr-relay-and-site.md#relay-s3-a-stolen-restaurant-credential) A stolen restaurant credential                                     | Low      | Partly mitigated | P8-03e         | 2026-10-24 |
| [RELAY-S4](qr-relay-and-site.md#relay-s4-a-fake-qr-sticker) A fake QR sticker                                                               | Medium   | Not mitigated    | P8-03e         | 2026-10-24 |
| [RELAY-I3](qr-relay-and-site.md#relay-i3-the-relays-own-secrets) The relay's own secrets                                                    | Medium   | Partly mitigated | manual task 20 | 2026-11-30 |
| [RELAY-I4](qr-relay-and-site.md#relay-i4-diners-privacy) Diners' privacy                                                                    | Low      | Partly mitigated | manual task 21 | 2026-11-30 |
| [LICENCE-I3](licence-mechanism.md#licence-i3-the-vendors-signing-key-leaking) The vendor's signing key leaking                              | Medium   | Partly mitigated | manual task 23 | 2026-11-30 |
| [UPDATE-S3](update-pipeline.md#update-s3-a-spoofed-update-for-the-phones-and-tablets) A spoofed update for the phones and tablets           | Medium   | Partly mitigated | manual task 29 | 2026-11-30 |
| [PAGER-S4](pager-channel.md#pager-s4-firmware-from-a-spoofed-source) Firmware from a spoofed source                                         | Medium   | Partly mitigated | manual task 30 | 2026-11-30 |
| [DESKTOP-T1](desktop-shell.md#desktop-t1-a-changed-app-or-executable) A changed app or executable                                           | Medium   | Partly mitigated | manual task 31 | 2026-11-30 |
| [UPDATE-I1](update-pipeline.md#update-i1-the-signing-certificate-leaking) The signing certificate leaking                                   | Medium   | Partly mitigated | manual task 31 | 2026-11-30 |
| [PAGER-I1](pager-channel.md#pager-i1-reading-alerts-on-the-air) Reading alerts on the air                                                   | Low      | Partly mitigated | P2-05          | 2026-12-15 |
| [PAGER-I4](pager-channel.md#pager-i4-reading-a-stolen-pager) Reading a stolen pager                                                         | Medium   | Not mitigated    | P2-05          | 2026-12-15 |
| [PAGER-S2](pager-channel.md#pager-s2-a-stolen-or-cloned-pager) A stolen or cloned pager                                                     | Medium   | Partly mitigated | P2-05          | 2026-12-15 |
| [PAGER-S3](pager-channel.md#pager-s3-a-rogue-access-point-or-broker) A rogue access point or broker                                         | High     | Partly mitigated | P2-05          | 2026-12-15 |

<!-- threat-summary:end -->
