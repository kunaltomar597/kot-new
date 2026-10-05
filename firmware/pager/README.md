# firmware/pager: wrist pager firmware (C9)

ESP-IDF (C) project for the ESP32-S3 pager (pilot hardware: LilyGO T-Watch S3 or equivalent,
PGR-004). esp-mqtt over TLS with QoS 1, per-device credentials, vibration patterns, 2×12 text,
acknowledge button, heartbeat, power save, signed OTA with A/B rollback, secure boot and flash
encryption in production.

Built by: P0-H1 (battery prototype), P2-05 (production firmware). Not started yet.
Outside the pnpm workspace; built with the ESP-IDF Docker image in CI.

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
