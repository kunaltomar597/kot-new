# firmware/pager: wrist pager firmware (C9)

ESP-IDF (C) project for the ESP32-S3 pager (pilot hardware: LilyGO T-Watch S3 or equivalent,
PGR-004). esp-mqtt over TLS with QoS 1, per-device credentials, vibration patterns, 2×12 text,
acknowledge button, heartbeat, power save, signed OTA with A/B rollback, secure boot and flash
encryption in production.

Built by: P0-H1 (battery prototype), P2-05 (production firmware). Not started yet.
Outside the pnpm workspace; built with the ESP-IDF Docker image in CI.

## The pairing screen's QR code (P2-04b2)

The manager registers a pager on the Pagers page by its serial: typed, typed by a barcode scanner,
or read from the pager's QR code with a phone's or the PC's camera (PGR-012, ADR-0019). P2-05's
pairing screen and the printed label must show:

- the QR code of `RP-PAGER:<serial>` (`pagerQrText` in `packages/contracts/src/pagers.ts`), error
  correction M, with its four-module quiet zone. Use an upper-case serial of 4 to 32 letters,
  digits or dashes; up to 11 characters keep it at version 1 (21 modules);
- the serial in text under it, for typing.

A bare serial in a supplier's QR code is read too.

## What the broker refuses (P8-03b2b)

The PC's broker protects the POS server it runs in (PAGER-D3, PAGER-D4 in
`docs/security/threat-models/pager-channel.md`). P2-05's firmware must stay within it:

- finish the TLS handshake and send CONNECT within 10 seconds of opening the connection;
- a CONNECT of at most 1 KB, without a will message; every packet after sign-in at most 4 KB;
- publish at QoS 0 or 1, never retained, only on its own `ack` and `heartbeat` topics; anything
  else ends the connection;
- a heartbeat less than half the interval (⚙ `pagers.heartbeatSeconds`, 30 s) after the last
  one taken is dropped: send one on connecting and then every interval. Acknowledgements beyond
  ten at once, then one a second, are dropped too;
- three missed heartbeats end the session: sign in again;
- a CONNACK of "server unavailable" (3) means too many sign-ins at once: try again after a
  random 1 to 5 seconds. "Not authorized" (5) means a wrong or replaced credential: the pager
  shows it and tries again with a growing wait, up to a minute; each attempt is counted on the
  Pagers page.

## Over-the-air updates: what the server already does (P2-04b1)

The restaurant PC passes on firmware the vendor releases in the Control Plane (PGR-011, ADR-0018,
`docs/runbooks/pager-firmware.md`). P2-05 implements the pager's side of it:

- Build the app as ESP-IDF project `rp-pager` (the PC checks `esp_app_desc_t.project_name`), with
  `PROJECT_VER` the release version, for the ESP32-S3, signed for secure boot v2 (RSA-3072) with
  the vendor key whose digest is in `apps/server/src/pager-firmware/firmware-keys.ts`.
- Subscribe to `rp/<restaurant>/pagers/<device>/ota` (QoS 1) as well as `alerts`. A
  `PagerFirmwareOffer` there gives `version`, `attempt`, `port`, `path`, `sha256`, `sizeBytes`,
  `expiresAt`.
- Download `https://<the broker's host>:<port><path>` with `esp_https_ota`, pinning the restaurant
  CA as for MQTT; check size and SHA-256; let the bootloader check the signature.
- In each heartbeat until the version runs or a new offer comes, send
  `ota: { version, attempt, state: 'DOWNLOADING' | 'FAILED', error? }`, plus `charging: true` on
  the charger.
- Mark the new image valid only once connected to the broker again; after a rollback report
  `ota: { version: <invalid one>, state: 'ROLLED_BACK' }` from
  `esp_ota_get_last_invalid_partition()`.

The messages are `PagerFirmwareOffer`, `PagerHeartbeat` and `PagerOtaReport` in
`packages/contracts/src/pagers.ts` (`docs/api/asyncapi.yaml`, channel `pagerOta`).
