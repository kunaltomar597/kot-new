# Threat model: The pager channel

The ESP32-S3 wrist pagers the waiters and managers wear, and the MQTT broker inside the restaurant
PC's server that sends them alerts, hears their acknowledgements and heartbeats, and passes on
their firmware. Written in P8-03b (2026-10-10). The pager's own firmware is P2-05, which needs the
hardware; what it must do is in [`firmware/pager/README.md`](../../../firmware/pager/README.md)
and the threats below planned for P2-05. Related: [ADR-0018](../../adr/0018-pager-firmware-distribution.md),
[authorisation.md](../authorisation.md) "Pagers (MQTT)".

## Scope

- The broker in `apps/server/src/pagers/`: MQTTS on the staff network with the installation's CA,
  each pager's own credential, the topic rules, alerts, acknowledgements and heartbeats.
- Registering, giving, taking back, replacing the credential of and unpairing a pager.
- Firmware through the PC (`apps/server/src/pager-firmware/`): the release from the Control Plane,
  the image's checks, the offer on the pager's `ota` topic and the download with its token.
- What the pager itself must protect (its secret, its boot chain), as requirements on P2-05.

## Assets

- The wearer's alerts, and how fast they arrive (NFR-P03).
- Acknowledgements: they stop the repeats and the escalation (NTF-004, NTF-005) and feed the staff
  reports.
- Each pager's MQTT secret: its Argon2id hash with a pepper on the PC, the secret itself on the
  pager.
- The installation's CA key, which the pagers trust.
- The vendor's firmware signing key, and the pagers' boot chain.
- The POS server staying up: the broker runs in its process.
- Who wears which pager, and the audit of it.

## Entry points

- MQTTS on port 8883 of the PC: CONNECT, SUBSCRIBE, PUBLISH, will messages.
- `/api/v1/pagers` (managers) and `/api/v1/pagers/:id/firmware-update` ("Update now").
- `GET /api/v1/pager-firmware/:token`, public, for a pager's download.
- The Devices page's "Unpair".
- The Control Plane's `PAGER_FIRMWARE` release and the address of its image.
- The pager in someone's hand: its flash, JTAG, UART and radio.

## Trust boundaries

1. Pager ↔ staff Wi-Fi ↔ PC: TLS with the installation's CA.
2. Any host on the LAN ↔ the broker's sign-in.
3. The vendor's cloud ↔ the PC: HTTPS, then the image's signature against keys built into the
   software.
4. The pager's hardware ↔ the secrets kept in it.
5. The PC's disk ↔ the server's process.

## Data flows

1. Alerts: the notification engine → the event bus → the broker → `rp/<restaurant>/pagers/<pager>/alerts`
   (QoS 1).
2. Acknowledgements: the pager's `ack` topic → the notification engine, as the wearer → every
   screen.
3. Heartbeats: the pager's `heartbeat` topic → the device's state and battery → the firmware
   rollout.
4. Firmware: the Control Plane's release → download and checks on the PC → an offer on the
   pager's `ota` topic → the pager downloads the image with a 15-minute token.

## Threats

### Spoofing

#### PAGER-S1 Posing as a pager without its credential

A host on the LAN signs in to the broker as a pager to read its wearer's alerts or acknowledge
them.

- Mitigation: the client id and user name are an active pager's id, the password its 192-bit
  secret, checked against its peppered Argon2id hash.
- Code: `apps/server/src/pagers/pager-broker.ts` (`PagerBroker.authenticate`);
  `apps/server/src/pagers/pagers.service.ts` (`PagersService.create`).
- Tests: `apps/server/test/integration/pagers.int.test.ts` "refuses a wrong password and another
  pager’s topics", "registers pagers with unique credentials, one per wearer".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

#### PAGER-S2 A stolen or cloned pager

Someone takes a pager, or reads its secret and makes a copy, to see a waiter's alerts and silence
them.

- Mitigation: a manager replaces the pager's credential or unpairs it, which drops its connection
  at once and frees its wearer; the broker keeps one session per pager. The secret on the pager is
  as safe as its flash, which P2-05 encrypts.
- Code: `apps/server/src/pagers/pagers.service.ts` (`PagersService.rotate`);
  `apps/server/src/pagers/pager-broker.ts` (`disconnect`);
  `apps/server/src/devices/devices.service.ts` (`DevicesService.revoke`).
- Tests: `apps/server/test/integration/pagers.int.test.ts` "replaces a credential, after which the
  old one no longer signs in", "ends its connection at once and frees its wearer".
- Risk: likelihood Medium, impact Medium: Medium.
- Status: Partly mitigated (fixed in P8-03b: unpairing a pager left its session open). Plan: P2-05
  by 2026-12-15: flash encryption and encrypted NVS on the pager, so its secret cannot be read
  out.

#### PAGER-S3 A rogue access point or broker

A fake access point with the staff network's name catches the pagers, collects their secrets from
CONNECT and sends them fake alerts.

- Mitigation: the broker speaks MQTTS with the installation's CA, and production refuses to start
  without TLS. The pager has to check the server's certificate against the CA it was given and the
  host name; that is the firmware's job.
- Code: `apps/server/src/pagers/pager-broker.ts` (`listenerOptions`);
  `apps/server/src/config/app-config.ts` (`loadConfig`).
- Tests: `apps/server/test/unit/app-config.test.ts` "needs TLS in production".
- Risk: likelihood Medium, impact High: High.
- Status: Partly mitigated. Plan: P2-05 by 2026-12-15: the pager pins the installation's CA and
  checks the host name before it sends its secret; P2-05's integration test runs over MQTTS.

#### PAGER-S4 Firmware from a spoofed source

A compromised Control Plane, or someone between it and the PC, gives the pagers their own
firmware.

- Mitigation: the image is downloaded over HTTPS and checked for its size and SHA-256, its chip,
  project and version, and its secure boot v2 signature against the key digests built into the
  software; production takes no other keys. The pager's bootloader checks the signature again.
- Code: `apps/server/src/pager-firmware/firmware-image.ts` (`checkFirmwareImage`,
  `verifyFirmwareSignature`); `apps/server/src/pager-firmware/firmware-keys.ts`
  (`PAGER_FIRMWARE_KEY_DIGESTS`).
- Tests: `apps/server/test/unit/pager-firmware-image.test.ts` "refuses an image signed with a key
  the pagers do not trust, or when it trusts none";
  `apps/server/test/integration/pager-firmware.int.test.ts` "refuses for good a release signed
  with a key the pagers do not trust"; `apps/server/test/unit/app-config.test.ts` "trusts only
  the firmware keys built in, in production".
- Risk: likelihood Low, impact High: Medium.
- Status: Partly mitigated. Plan: manual task 30 by 2026-11-30: the signing key made offline and
  its digest built in (the list is empty until then, so no firmware is passed on); P2-05 turns on
  secure boot v2 in the pager's bootloader.

### Tampering

#### PAGER-T1 A forged acknowledgement

A pager, or a copy of one, acknowledges alerts it was not sent, stopping their repeats and
escalation and falsifying response times.

- Mitigation: a pager may publish only on its own `ack` topic, and acknowledges as its wearer. A
  pager worn by a manager acknowledges with a manager's reach, so any alert in the restaurant whose
  id it learns.
- Code: `packages/domain/src/pager.ts` (`pagerMayPublish`);
  `apps/server/src/notifications/notifications.service.ts` (`acknowledge`, `acknowledgeForDevice`).
- Tests: `apps/server/test/integration/pagers.int.test.ts` "ignores a pager publishing where it
  may not", "delivers an alert within 2 s, and the button acknowledges it everywhere".
- Risk: likelihood Low, impact Medium: Low.
- Status: Partly mitigated. Plan: P8-03b2 by 2026-10-13: a pager acknowledges only alerts that
  were sent to it, as the waiter phone already does.

#### PAGER-T2 Getting round the topic rules

A pager subscribes with a wildcard, another pager's id or another restaurant's, to read or write
where it may not.

- Mitigation: the rules compare whole topics built from the database's ids, never from the
  client: a pager reads its own `alerts` and `ota` and writes its own `ack` and `heartbeat`.
- Code: `packages/domain/src/pager.ts` (`pagerMaySubscribe`, `pagerMayPublish`).
- Tests: `packages/domain/test/pager.test.ts` "lets a pager read only its own alerts and write only
  its own ack and heartbeat", "lets a pager read its own firmware offers, never write them";
  `apps/server/test/integration/pagers.int.test.ts` "refuses a wrong password and another pager’s
  topics"; `apps/server/test/integration/pager-firmware.int.test.ts` "keeps a pager to its own
  firmware offers".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

#### PAGER-T3 A changed firmware image

Someone changes the firmware image on its way to the PC, or on the PC's disk, so the pagers run
their code.

- Mitigation: see PAGER-S4; a changed byte, a forged signature block or an unsigned image is
  refused, and so is an image for another chip, project or version. An image changed on the PC's
  disk after its check is caught by the pager, which checks the SHA-256 it was offered, and by its
  bootloader, which checks the signature.
- Code: `apps/server/src/pager-firmware/firmware-image.ts` (`checkFirmwareImage`).
- Tests: `apps/server/test/unit/pager-firmware-image.test.ts` "refuses a changed image or a forged
  signature block", "refuses an unsigned image", "refuses another chip, another project or
  another version than the release".
- Risk: likelihood Low, impact High: Medium.
- Status: Mitigated.

#### PAGER-T4 Going back to older firmware

Someone gets the pagers to run an older, signed firmware with a known flaw.

- Mitigation: only a newer version is offered, and never again one a pager rolled back from. The
  image's secure version is read but not compared, and the pager's anti-rollback fuse is P2-05's.
- Code: `apps/server/src/pager-firmware/pager-firmware.service.ts` (`PagerFirmwareService`);
  `packages/domain/src/pager-firmware.ts` (`pagerFirmwareVerdict`).
- Tests: `packages/domain/test/pager-firmware.test.ts` "leaves a pager on the same or a newer
  version alone", "never offers a version again to a pager that rolled back from it".
- Risk: likelihood Low, impact Medium: Low.
- Status: Partly mitigated. Plan: P8-03b2 by 2026-10-13: the PC refuses a release whose secure
  version is lower than the one it serves; P2-05 burns the anti-rollback fuse on the pager.

#### PAGER-T5 Forged heartbeats or update reports

A pager reports a false battery level, firmware version or a rollback.

- Mitigation: a pager reports only about itself, on its own topic, in a strict format; an update
  report counts only for the latest offer the PC made to that pager, once.
- Code: `apps/server/src/pager-firmware/pager-firmware.service.ts` (`PagerFirmwareService`).
- Tests: `apps/server/test/integration/pagers.int.test.ts` "records battery and signal, alerts at
  low battery, and marks the pager offline after 3 missed beats".
- Risk: likelihood Low, impact Low: Low.
- Status: Accepted: the worst a false report does is mislabel its own pager, or halt a rollout the
  vendor then looks at and resumes.

### Repudiation

#### PAGER-R1 Who changed a pager

A manager registers, gives, takes back or replaces the credential of a pager and later denies it.

- Mitigation: each is audited with the actor and the device.
- Code: `apps/server/src/pagers/pagers.service.ts` (`PagersService`).
- Tests: `apps/server/test/integration/pagers.int.test.ts` "gives the pager to a manager at once,
  taking it from the waiter".
- Risk: likelihood Low, impact Low: Low.
- Status: Mitigated.

#### PAGER-R2 "I did not press it"

A waiter says the alert was acknowledged by someone else.

- Mitigation: the acknowledgement records the wearer; it does not record that it came from the
  pager rather than the phone.
- Code: `apps/server/src/notifications/notifications.service.ts` (`acknowledge`).
- Tests: `apps/server/test/integration/pagers.int.test.ts` "delivers an alert within 2 s, and the
  button acknowledges it everywhere".
- Risk: likelihood Medium, impact Low: Low.
- Status: Partly mitigated. Plan: P8-03b2 by 2026-10-13: the acknowledgement records the pager it
  came from.

#### PAGER-R3 Failed pager sign-ins leave no trace

Someone tries pagers' credentials against the broker and nobody can see it.

- Mitigation: a failed sign-in is refused without a log line or a count.
- Code: `apps/server/src/pagers/pager-broker.ts` (`authenticate`).
- Tests: `apps/server/test/integration/pagers.int.test.ts` "refuses a wrong password and another
  pager’s topics".
- Risk: likelihood Low, impact Low: Low.
- Status: Not mitigated. Plan: P8-03b2 by 2026-10-13: failed sign-ins are logged and counted.

### Information disclosure

#### PAGER-I1 Reading alerts on the air

Someone on the staff network or near it reads the alerts or the secrets the pagers send.

- Mitigation: MQTTS with TLS 1.2 or later; the pager's check of the server's certificate is
  P2-05's (PAGER-S3).
- Code: `apps/server/src/tls/tls-store.ts` (`serverTlsOptions`).
- Tests: `apps/server/test/integration/tls.int.test.ts` "accepts TLS 1.2 and refuses older
  protocols".
- Risk: likelihood Low, impact Medium: Low.
- Status: Partly mitigated. Plan: P2-05 by 2026-12-15: the pager pins the CA.

#### PAGER-I2 Reading another pager's alerts

A signed-in pager subscribes to another pager's topic to read its alerts.

- Mitigation: the topic rules (PAGER-T2).
- Code: `packages/domain/src/pager.ts` (`pagerMaySubscribe`).
- Tests: `apps/server/test/integration/pagers.int.test.ts` "refuses a wrong password and another
  pager’s topics".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

#### PAGER-I3 Pager secrets from a stolen database

Someone copies the database or a backup and recovers the pagers' secrets from it.

- Mitigation: only an Argon2id hash with the OWASP parameters is stored, peppered with a key from
  the DPAPI store, so a copied database alone opens nothing.
- Code: `apps/server/src/auth/credential-hasher.ts` (`CredentialHasher`).
- Tests: `apps/server/test/unit/auth-primitives.test.ts` "depends on the pepper, so a stolen hash
  alone is useless", "uses Argon2id with the OWASP parameters".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

#### PAGER-I4 Reading a stolen pager

Someone opens a pager and reads its flash, or uses JTAG or UART, to get its secret and the CA.

- Mitigation: none on the PC beyond replacing the credential; the protections are the
  firmware's.
- Code: none, the firmware is P2-05 (`firmware/pager/README.md`).
- Tests: none, the firmware does not exist yet.
- Risk: likelihood Medium, impact Medium: Medium.
- Status: Not mitigated. Plan: P2-05 by 2026-12-15: flash encryption and encrypted NVS, JTAG off
  by eFuse and secure download mode, checked against ETSI EN 303 645 in P8-03d.

#### PAGER-I5 The firmware download token leaking

Someone sees a download address and fetches the image with its token.

- Mitigation: a 256-bit token lasting 15 minutes, sent only on the pager's own `ota` topic and
  answered with `no-store`; the image is signed and not secret.
- Code: `apps/server/src/pager-firmware/pager-firmware.service.ts` (`download`).
- Tests: `apps/server/test/integration/pager-firmware.int.test.ts` "refuses an unknown or expired
  download token".
- Risk: likelihood Low, impact Low: Low.
- Status: Mitigated.

### Denial of service

#### PAGER-D1 Jamming, or a pager out of range

The Wi-Fi is jammed or a waiter walks out of range, so alerts do not arrive.

- Mitigation: the PC knows: three missed heartbeats mark the pager offline and alert the managers;
  a waiter with neither pager nor app connected has alerts escalated at once (NTF-007); open
  alerts are sent again when the pager comes back; escalation runs on the PC's timers.
- Code: `apps/server/src/pagers/pager-broker.ts` (`checkOffline`, `resend`).
- Tests: `apps/server/test/integration/pagers.int.test.ts` "records battery and signal, alerts at
  low battery, and marks the pager offline after 3 missed beats", "sends open alerts again when
  the pager reconnects"; `apps/server/test/integration/notifications.int.test.ts` "goes to the
  managers at once when the waiter has neither pager nor app".
- Risk: likelihood Medium, impact Low: Low.
- Status: Mitigated.

#### PAGER-D2 A pager that never acknowledges

A pager is broken, switched off or ignored, and its wearer's alerts would wait for ever.

- Mitigation: repeats and escalation do not depend on the pager; the PC never restarts a pager for
  an update while it has an alert its wearer has not acknowledged.
- Code: `apps/server/src/notifications/notifications.service.ts` (`NotificationsService`).
- Tests: `apps/server/test/integration/notifications.int.test.ts` "repeats every R and escalates
  after N to the managers on duty, once"; `packages/domain/test/pager-firmware.test.ts` "never
  reboots a pager with an alert its wearer has not acknowledged".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

#### PAGER-D3 Flooding the broker without a credential

Any host on the LAN opens many connections to port 8883 and announces huge packets; the broker
reads them before sign-in, and the POS server, in the same process, runs out of memory.

- Mitigation: none yet: the broker sets no packet size, no connection limit and a 30-second
  sign-in time.
- Code: `apps/server/src/pagers/pager-broker.ts` (`PagerBroker`).
- Tests: none, no test floods the broker yet; P8-03b2 adds them with the limits.
- Risk: likelihood Medium, impact High: High.
- Status: Not mitigated. Plan: P8-03b2 by 2026-10-13: a packet size limit before and after
  sign-in, a connection limit, a short sign-in time and a limit on Argon2 checks at once.

#### PAGER-D4 A signed-in pager publishing too much

A pager, or a copy, sends heartbeats as fast as it can, or retained or large messages.

- Mitigation: each heartbeat is checked and stored; nothing limits their rate, retained messages
  or their size.
- Code: `apps/server/src/pagers/pager-broker.ts` (`PagerBroker`).
- Tests: `apps/server/test/integration/pagers.int.test.ts` "ignores a pager publishing where it
  may not".
- Risk: likelihood Low, impact Medium: Low.
- Status: Partly mitigated. Plan: P8-03b2 by 2026-10-13: heartbeats faster than half the interval
  are dropped, retained and large messages refused.

#### PAGER-D5 A firmware update stopping pagers in service

A bad firmware, or one installed at the wrong moment, leaves waiters without pagers mid-service.

- Mitigation: an update is offered only to a free pager (connected, charged, no open alert, not
  worn or in the maintenance window), two at a time; a pager that rolls back is not offered that
  version again, and the vendor halts a rollout that fails.
- Code: `packages/domain/src/pager-firmware.ts` (`pagerFirmwareVerdict`).
- Tests: `packages/domain/test/pager-firmware.test.ts` "updates a few pagers at a time";
  `apps/server/test/integration/pager-firmware.int.test.ts` "stops offering a version whose
  rollout the vendor halted".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

#### PAGER-D6 A pager the PC wrongly thinks is connected

When a pager reconnects while its old session is still open, or its socket closes during the
sign-in check, the PC's list of connected pagers can be wrong for a while: alerts are not sent, or
a waiter without a working pager counts as reachable and NTF-007's immediate escalation is skipped.

- Mitigation: the offline check after three missed heartbeats corrects it.
- Code: `apps/server/src/pagers/pager-broker.ts` (`isStaffConnected`, `checkOffline`).
- Tests: `apps/server/test/integration/pagers.int.test.ts` "sends open alerts again when the pager
  reconnects".
- Risk: likelihood Low, impact Medium: Low.
- Status: Partly mitigated. Plan: P8-03b2 by 2026-10-13: a connection counts only once the broker
  has it, and a closing session removes only its own entry.

### Elevation of privilege

#### PAGER-E1 A pager's credential on the REST API

Someone uses a pager's identity to call the PC's HTTPS endpoints.

- Mitigation: pagers never hold a device key or token: no pairing code is made for a pager, and
  every device endpoint refuses the pager type.
- Code: `apps/server/src/devices/devices.service.ts` (`createPairingCode`).
- Tests: `apps/server/test/integration/devices.int.test.ts` "makes no code for a pager, which never
  gets a device key"; `apps/server/test/integration/authorisation-sweep.int.test.ts` "refuses each
  device endpoint to every kind of device it does not serve".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

#### PAGER-E2 A waiter managing pagers or starting updates

A waiter gives themselves a manager's pager, or starts a firmware update during service.

- Mitigation: registering, giving, replacing and updating pagers need managers' capabilities.
- Code: `apps/server/src/pagers/pagers.controller.ts` (`PagersController`).
- Tests: `apps/server/test/integration/pagers.int.test.ts` "registers pagers with unique
  credentials, one per wearer"; `apps/server/test/integration/authorisation-sweep.int.test.ts`
  "refuses each role what".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

#### PAGER-E3 More pagers than the licence allows

A restaurant registers more pagers than its licence counts, as the device limits allow for other
devices (LIC-001).

- Mitigation: the licence's limits apply to pairing codes; registering a pager does not check
  them.
- Code: `apps/server/src/pagers/pagers.service.ts` (`PagersService.create`);
  `apps/server/src/licensing/licence-agent.service.ts` (`limitFor`).
- Tests: `apps/server/test/integration/licence-agent.int.test.ts` "pairs no more devices of a kind
  than the licence allows".
- Risk: likelihood Medium, impact Low: Low.
- Status: Partly mitigated. Plan: P8-03b2 by 2026-10-13: registering a pager checks the licence's
  pager limit.
