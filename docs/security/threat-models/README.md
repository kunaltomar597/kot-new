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
| [The LAN and the local server](local-server-and-lan.md) |      45 |        37 |                5 |             0 |        3 |              18 |                         0 |
| [The pager channel](pager-channel.md)                   |      26 |        19 |                5 |             1 |        1 |               4 |                         1 |
| [The QR relay and site](qr-relay-and-site.md)           |      29 |        22 |                4 |             1 |        2 |               6 |                         0 |
| [The update pipeline](update-pipeline.md)               |      21 |        16 |                3 |             1 |        1 |              10 |                         1 |
| [The licence mechanism](licence-mechanism.md)           |      20 |        14 |                4 |             0 |        2 |               7 |                         0 |
| [The Vendor Control Plane](control-plane.md)            |      22 |        16 |                5 |             0 |        1 |               7 |                         0 |
| [The desktop shell](desktop-shell.md)                   |      14 |        11 |                2 |             0 |        1 |               5 |                         0 |
| [The phones and tablets](phones-and-tablets.md)         |      18 |        13 |                4 |             0 |        1 |               5 |                         0 |
| All                                                     |     195 |       148 |               32 |             3 |       12 |              62 |                         2 |

Open threats and their plans, by date:

| Threat                                                                                                                                 | Residual | Status           | Plan           | By         |
| -------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------- | -------------- | ---------- |
| [UPDATE-E2](update-pipeline.md#update-e2-a-pull-request-signed-as-the-vendors) A pull request signed as the vendor's                   | Medium   | Partly mitigated | manual task 1  | 2026-10-17 |
| [UPDATE-T6](update-pipeline.md#update-t6-unreviewed-code-on-main) Unreviewed code on main                                              | High     | Not mitigated    | manual task 1  | 2026-10-17 |
| [PC-D7](local-server-and-lan.md#pc-d7-ransomware-or-a-dead-disk) Ransomware or a dead disk                                             | Medium   | Partly mitigated | P8-03e         | 2026-10-24 |
| [RELAY-S3](qr-relay-and-site.md#relay-s3-a-stolen-restaurant-credential) A stolen restaurant credential                                | Low      | Partly mitigated | P8-03e         | 2026-10-24 |
| [RELAY-S4](qr-relay-and-site.md#relay-s4-a-fake-qr-sticker) A fake QR sticker                                                          | Medium   | Not mitigated    | P8-03e         | 2026-10-24 |
| [MOBILE-E2](phones-and-tablets.md#mobile-e2-a-diner-leaving-the-kiosk) A diner leaving the kiosk                                       | Medium   | Partly mitigated | manual task 33 | 2026-10-31 |
| [MOBILE-I4](phones-and-tablets.md#mobile-i4-pins-in-screenshots-and-the-recent-apps-list) PINs in screenshots and the recent apps list | Low      | Partly mitigated | manual task 33 | 2026-10-31 |
| [MOBILE-R2](phones-and-tablets.md#mobile-r2-alerts-acknowledged-from-the-lock-screen) Alerts acknowledged from the lock screen         | Low      | Partly mitigated | manual task 33 | 2026-10-31 |
| [MOBILE-S1](phones-and-tablets.md#mobile-s1-a-rogue-server-or-a-man-in-the-middle) A rogue server or a man in the middle               | Medium   | Partly mitigated | manual task 33 | 2026-10-31 |
| [DESKTOP-E4](desktop-shell.md#desktop-e4-leaving-the-pos-window-for-windows) Leaving the POS window for Windows                        | Medium   | Partly mitigated | manual task 35 | 2026-10-31 |
| [PC-D6](local-server-and-lan.md#pc-d6-attacks-from-guest-wi-fi-on-a-flat-network) Attacks from guest Wi-Fi on a flat network           | Medium   | Partly mitigated | manual task 35 | 2026-10-31 |
| [PC-E2](local-server-and-lan.md#pc-e2-a-windows-administrator-on-the-pc) A Windows administrator on the PC                             | Medium   | Partly mitigated | manual task 35 | 2026-10-31 |
| [RELAY-I3](qr-relay-and-site.md#relay-i3-the-relays-own-secrets) The relay's own secrets                                               | Medium   | Partly mitigated | manual task 20 | 2026-11-30 |
| [RELAY-I4](qr-relay-and-site.md#relay-i4-diners-privacy) Diners' privacy                                                               | Low      | Partly mitigated | manual task 21 | 2026-11-30 |
| [LICENCE-I3](licence-mechanism.md#licence-i3-the-vendors-signing-key-leaking) The vendor's signing key leaking                         | Medium   | Partly mitigated | manual task 23 | 2026-11-30 |
| [CP-T2](control-plane.md#cp-t2-a-compromised-pc-deleting-its-own-cloud-backups) A compromised PC deleting its own cloud backups        | Low      | Partly mitigated | manual task 26 | 2026-11-30 |
| [UPDATE-S3](update-pipeline.md#update-s3-a-spoofed-update-for-the-phones-and-tablets) A spoofed update for the phones and tablets      | Medium   | Partly mitigated | manual task 29 | 2026-11-30 |
| [PAGER-S4](pager-channel.md#pager-s4-firmware-from-a-spoofed-source) Firmware from a spoofed source                                    | Medium   | Partly mitigated | manual task 30 | 2026-11-30 |
| [DESKTOP-T1](desktop-shell.md#desktop-t1-a-changed-app-or-executable) A changed app or executable                                      | Medium   | Partly mitigated | manual task 31 | 2026-11-30 |
| [UPDATE-I1](update-pipeline.md#update-i1-the-signing-certificate-leaking) The signing certificate leaking                              | Medium   | Partly mitigated | manual task 31 | 2026-11-30 |
| [CP-D1](control-plane.md#cp-d1-flooding-the-control-plane) Flooding the Control Plane                                                  | Low      | Partly mitigated | manual task 32 | 2026-11-30 |
| [RELAY-D4](qr-relay-and-site.md#relay-d4-unthrottled-reads-and-their-cost) Unthrottled reads and their cost                            | Low      | Partly mitigated | manual task 32 | 2026-11-30 |
| [CP-R2](control-plane.md#cp-r2-changes-through-the-admin-cli) Changes through the admin CLI                                            | Medium   | Partly mitigated | manual task 34 | 2026-11-30 |
| [CP-T5](control-plane.md#cp-t5-editing-the-vendors-audit-log) Editing the vendor's audit log                                           | Low      | Partly mitigated | manual task 34 | 2026-11-30 |
| [PAGER-I1](pager-channel.md#pager-i1-reading-alerts-on-the-air) Reading alerts on the air                                              | Low      | Partly mitigated | P2-05          | 2026-12-15 |
| [PAGER-I4](pager-channel.md#pager-i4-reading-a-stolen-pager) Reading a stolen pager                                                    | Medium   | Not mitigated    | P2-05          | 2026-12-15 |
| [PAGER-S2](pager-channel.md#pager-s2-a-stolen-or-cloned-pager) A stolen or cloned pager                                                | Medium   | Partly mitigated | P2-05          | 2026-12-15 |
| [PAGER-S3](pager-channel.md#pager-s3-a-rogue-access-point-or-broker) A rogue access point or broker                                    | High     | Partly mitigated | P2-05          | 2026-12-15 |
| [PAGER-T4](pager-channel.md#pager-t4-going-back-to-older-firmware) Going back to older firmware                                        | Low      | Partly mitigated | P2-05          | 2026-12-15 |

<!-- threat-summary:end -->
