# Pager firmware updates

How the wrist pagers get new firmware (PGR-011, UPD-001, UPD-003, UPD-007, P2-04b1, ADR-0018):
releasing it in the Control Plane, what each restaurant PC does with it, what a pager does, and
support. The pager's side is built in P2-05.

## In short

- **The vendor releases signed firmware** in the Control Plane as a `PAGER_FIRMWARE` release, on a
  channel, rolled out to a share of the PCs first, paused or halted like a PC release.
- **Each PC fetches and checks it**: HTTPS only, the size and SHA-256 of the release, an ESP-IDF
  image of the `rp-pager` project for the ESP32-S3 with the release's version, and a secure boot v2
  signature by a key built into the software. A release that fails a check is refused for good,
  and the vendor sees it as a failure in the rollout.
- **The PC offers it to each pager when the pager is free**: connected, battery at least 30 % or on
  its charger, no unacknowledged alert, and nobody wears it or the maintenance window (03:00 to
  06:00 by default, `updates.maintenanceWindow`) is open. Two at a time. A manager can press
  "Update now" on the Pagers page to update a worn pager outside the window.
- **The pager downloads the image from the PC** with a one-time link, checks it, boots it from its
  other partition, and goes back to its previous firmware by itself if the new one does not come
  up. A pager that went back is not offered that version again ("Update now" tries again), and the
  vendor's rollout halts by itself when that spreads across PCs.

## Releasing firmware

Needs the firmware signing key (manual task 30). The key never enters the repository or CI logs.

1. Build the firmware (P2-05's CI job) with `PROJECT_VER` set to the release version, e.g.
   `1.2.0`. The image must be the `rp-pager` project for the ESP32-S3.
2. Sign it on the signing machine (or HSM):

   ```
   espsecure sign-data --version 2 --keyfile pager-signing-key.pem \
     --output rp-pager-1.2.0.bin rp-pager-unsigned.bin
   espsecure verify-signature --version 2 --keyfile pager-signing-public.pem rp-pager-1.2.0.bin
   sha256sum rp-pager-1.2.0.bin && stat -c %s rp-pager-1.2.0.bin
   ```

3. Upload `rp-pager-1.2.0.bin` to the release storage (an `https://` address).
4. Publish it to Pilot first, at a small share:

   ```
   CP_ACTOR=ci:release pnpm --filter @rp/control-plane cli release:publish \
     --component PAGER_FIRMWARE --channel PILOT --version 1.2.0 \
     --url https://downloads.example.com/pager/rp-pager-1.2.0.bin \
     --sha256 <hex> --size <bytes> --notes "Longer battery life"
   ```

   or in the vendor web app: Releases → Publish release → What it updates: Pager firmware. Widen
   the rollout from the release's Rollout button once the first restaurants' pagers are fine.

## What the PC does

Every minute, and at once after a heartbeat brings a new release:

1. Downloads it to `<data>/firmware/pager/rp-pager-<version>.bin.partial`, checks size and
   SHA-256, then the image and its signature. It keeps only the image it serves.
2. Records the outcome: `PAGER_FIRMWARE_ACCEPTED` or `PAGER_FIRMWARE_REFUSED` in the audit log,
   and the report for the Control Plane in the next heartbeat.
3. A download that fails (network, HTTP status) is tried again after 5 minutes, doubling up to 6
   hours. A release that fails a check (`SIZE`, `HASH`, `TOO_LARGE`, `NOT_AN_IMAGE`, `WRONG_CHIP`,
   `WRONG_PROJECT`, `VERSION_MISMATCH`, `NOT_SIGNED`, `UNTRUSTED_KEY`, `BAD_SIGNATURE`) is never
   fetched again; publish a new version.
4. On each pager heartbeat, it decides whether to offer the firmware (the rules above). The offer
   goes on the pager's own MQTT topic `rp/<restaurant>/pagers/<device>/ota`.

The Pagers page (Manage → Staff → Pagers) shows the firmware the PC serves, a release on its way
or refused, and for each pager: waiting (and for what), updating, given up (and the last
problem), or nothing when it runs the firmware.

## What a pager does (P2-05)

The protocol, in `@rp/contracts` `pagers.ts` and `docs/api/asyncapi.yaml` (`pagerOta`):

1. Subscribes to its `ota` topic as well as `alerts` (QoS 1).
2. On a `PagerFirmwareOffer` for a version it does not run: downloads
   `https://<the broker's host>:<port><path>` with `esp_https_ota`, pinning the restaurant's CA as
   for MQTT, before `expiresAt`; checks the size and SHA-256 against the offer.
3. Reports in each heartbeat `ota: { version, attempt, state: 'DOWNLOADING' }`, then `'FAILED'`
   with a short `error` when anything fails, until it runs the version or a new offer comes.
4. Sets the new partition to boot and restarts. Secure boot checks the signature. Once connected
   to the broker again it marks the image valid (`esp_ota_mark_app_valid_cancel_rollback`), and
   its heartbeat reports the new `firmware`.
5. If the new image does not come up, the bootloader rolls back. The old firmware then reports
   `ota: { version: <the invalid one>, state: 'ROLLED_BACK' }` (from
   `esp_ota_get_last_invalid_partition()`) in its heartbeats.

## Support

- **"Pager firmware … was refused: The image is signed with a key the pagers do not trust."**:
  the release was signed with the wrong key, or the key is not built into this PC's software.
  Publish a correctly signed new version.
- **"…this software trusts no firmware key yet"** (`NO_TRUSTED_KEY`): the software was released
  without the key digest (manual task 30). It fetches again after an update that has one.
- **A pager waits "for the maintenance window, as someone wears it"**: it updates overnight on its
  charger, or press "Update now".
- **A pager "did not start" the firmware and went back to its own**: it is left alone. Check the
  pager (Wi-Fi at the charging spot, battery), then press "Update now" to try again. If several
  restaurants report it, the vendor's rollout has halted; fix and release a new version.
- **Halting a release** in the vendor web app stops every PC offering it to more pagers. Pagers
  already updated keep it until a newer version comes.
