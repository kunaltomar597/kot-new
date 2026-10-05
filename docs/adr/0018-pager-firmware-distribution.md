# ADR-0018: Pager firmware through the restaurant PC

Status: Accepted
Date: 2026-10-05
Work package: P2-04b1
Requirements: PGR-011, UPD-001, UPD-002, UPD-003, UPD-004, UPD-007, SEC-012, NFR-A01

## Context

PGR-011: "Over-the-air firmware updates are signed, use A/B partitions and roll back automatically
if the new firmware fails to boot. They are distributed through the local server from firmware
released in the Vendor Control Plane." UPD-001 repeats it ("Pager firmware: OTA via the local
server"), UPD-002 and UPD-003 ask for channels, staged rollouts and halting, UPD-007 for signed
artefacts verified before installation over HTTPS.

The pagers are ESP32-S3 devices (PGR-004) on the restaurant's Wi-Fi. They have no internet route
of their own that the restaurant can rely on (NFR-A01), they hold only an MQTT credential for the
local broker (SEC-012, P2-04a), and a pager rebooting mid-service would miss alerts. ESP-IDF
already offers what the device needs: two OTA app partitions, `esp_https_ota`, rollback when the
new image is not marked valid, and secure boot v2 (RSA-3072 RSA-PSS signature blocks checked by
the bootloader against key digests burned into eFuses), which PGR-010 asks for anyway.

## Decision

1. **The Control Plane releases firmware like the PC's installer.** `PAGER_FIRMWARE` is a release
   component next to `RESTAURANT_PC`: channel, staged rollout by percentage or cohort, pause,
   halt, hotfix for one PC. Holding a PC at a version holds its installer only. A PC that says
   which firmware it serves (`pagerFirmware` in the heartbeat) is answered with a newer release
   its rollout reaches, and with whether the version it serves was halted. PCs report `INSTALLED`
   (checked and served), `FAILED` (refused) or `ROLLED_BACK` (a pager went back from it); these
   count in the rollout's health, so it halts by itself when failures spread (UPD-003). They do
   not open the PC's `UPDATE_FAILED` fleet alert.
2. **The signature is ESP-IDF secure boot v2, and the PC checks it first.** The vendor signs the
   image with `espsecure sign-data --version 2` (RSA-3072). The PC downloads it over HTTPS (size,
   SHA-256), reads the image header and app description (ESP32-S3, project `rp-pager`, the
   release's version) and verifies a signature block against the key digests built into the
   software (`PAGER_FIRMWARE_KEY_DIGESTS`; `RP_PAGER_FIRMWARE_KEYS` adds keys in development and
   tests, refused in production). A release that fails is refused for good and reported. The
   pager's bootloader checks the same signature against its eFuse, so the PC's check is defence in
   depth: a wrong image never reaches a pager, and the vendor hears about it at once.
3. **Offers over MQTT, the image over HTTPS from the PC.** A pager may subscribe to its own
   `rp/<restaurant>/pagers/<device>/ota` topic too. The PC sends `PagerFirmwareOffer` there
   (version, attempt, port, a path with a random 256-bit token valid 15 minutes, SHA-256, size).
   The pager downloads `GET /api/v1/pager-firmware/<token>` from the host it reaches the broker
   at, over the pinned LAN CA, writes the other OTA partition, boots it and marks it valid once it
   is connected to the broker again; otherwise ESP-IDF rolls back. The route is public because a
   pager has no device token; the token went to that pager alone behind its credential and the
   ACL. Progress comes back in the heartbeat (`ota`: DOWNLOADING, FAILED, ROLLED_BACK, with the
   offer's attempt so a stale report cannot overwrite a newer offer), and success is the
   heartbeat's firmware version.
4. **A pager updates only when it is free** (`pagerFirmwareVerdict` in `@rp/domain`): connected,
   battery at least 30 % or charging, no unacknowledged alert, and nobody wears it or the
   maintenance window ⚙ `updates.maintenanceWindow` is open, or a manager pressed "Update now"
   (`UPDATE_INSTALL_NOW`, audited). Two pagers at a time. A failure is tried again after 30
   minutes, three times; a rollback is never tried again on that pager until "Update now". These
   are fixed vendor values, not settings: the BRD has no ⚙ for them.
5. **The PC keeps one image** (`<data>/firmware/pager/rp-pager-<version>.bin`) and its state in
   `system_meta`; each pager's attempt is a `pager_firmware_updates` row.

## Alternatives considered

- **Pagers fetch firmware from the cloud.** Needs internet on the staff Wi-Fi and a cloud
  credential per pager; contradicts PGR-011 ("through the local server") and NFR-A01.
- **A separate vendor signature (Ed25519 over the image) checked by the PC.** A second key to
  manage, and the pager would still need secure boot v2 for PGR-010. Verifying the secure boot
  signature itself checks exactly what the device will accept.
- **Firmware inside the PC's installer, like the APKs (P7-04e2).** Ties firmware releases to PC
  releases; a firmware fix would need a full PC update in its maintenance window, and the pagers'
  rollout could not be staged or halted on its own.
- **Pushing the image over MQTT in chunks.** Slower and heavier on the broker, and re-implements
  what `esp_https_ota` does with resumption and TLS.
- **Basic auth with the pager's MQTT secret on the download.** Works, but costs an Argon2id check
  per request and sends the long-lived secret again; a one-time token tied to the offer is
  narrower.

## Consequences

- P2-05 implements the pager side: subscribe to `ota`, download with `esp_https_ota` over the
  pinned CA, report in the heartbeat, mark valid after reconnecting, and report a rollback from
  `esp_ota_get_last_invalid_partition()` (see `firmware/pager/README.md`).
- The vendor must create the firmware signing key and build its digest into the software before
  pagers can be updated (manual task 30); until then production passes no firmware on and says so.
- The PC's check was tested against espsecure 5.4 output (a committed signed fixture and a
  TypeScript signer that espsecure verifies). If Espressif changes the block format (ECDSA blocks
  for other chips are skipped), `firmware-image.ts` and its fixture change with it.
- Download tokens live in memory: a server restart drops them, the pager's download fails or times
  out, and it is offered again later.
