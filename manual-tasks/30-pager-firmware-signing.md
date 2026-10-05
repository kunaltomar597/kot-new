# 30. Pager firmware: the signing key and the first release

What it unblocks: pager firmware updates through the restaurant PC (PGR-011, PGR-010, UPD-007,
P2-04b1, ADR-0018). Until the key's digest is built into the software, every PC refuses to pass
firmware on ("this software trusts no firmware key yet"), and production pagers cannot be
updated over the air.

Never paste the private key, or anything that unlocks it, into a Claude session or a commit.

## 1. Create the firmware signing key (vendor, once)

The pagers use ESP-IDF secure boot v2 with an RSA-3072 key. The pager's eFuses hold the key's
digest, so losing the key means no pager can be updated any more, and leaking it means anyone can
make firmware the pagers run. Keep it offline or in an HSM.

1. On an offline machine with esptool 5 (`pip install esptool`):

   ```
   espsecure generate-signing-key --version 2 --scheme rsa3072 pager-signing-key.pem
   espsecure extract-public-key --version 2 --keyfile pager-signing-key.pem pager-signing-public.pem
   espsecure digest-sbv2-public-key --keyfile pager-signing-key.pem --output digest.bin
   xxd -p digest.bin | tr -d '\n'
   ```

   (or create it in an HSM and use `espsecure`'s `--hsm` options).

2. Back up the private key in two places only the two named vendor administrators can reach.
3. Send the **digest** (64 hexadecimal characters, not secret) to Claude, or open a pull request
   adding it to `apps/server/src/pager-firmware/firmware-keys.ts`. PCs pass on only firmware signed
   by a key listed there. Up to three keys may be listed (the pagers have three key slots), so a
   key can be rotated: add the new one, release, burn it into the pagers, then remove the old one
   a release later.
4. Burn the same digest into each production pager's eFuse when secure boot is enabled
   (P2-05's flashing procedure, manual task 15). A development pager without secure boot accepts
   any image, so test the PC's check with a signed image anyway.

## 2. The first release

1. Build and sign the firmware as `docs/runbooks/pager-firmware.md` says ("Releasing firmware").
2. Publish it to the Pilot channel at a small share, with the CLI or the vendor web app.
3. On the pilot PC, open Manage → Staff → Pagers: "Pager firmware 1.x.y is on this PC" appears
   within a heartbeat and a minute. A refusal says why.
4. Leave a pager on its charger, not worn: it updates within a minute or two. Press "Update now"
   on a worn pager to update it at once.
5. Fill in the results below.

## Results

| Check                                                          | Result | Notes |
| -------------------------------------------------------------- | ------ | ----- |
| Key digest added to the software (release version)             |        |       |
| Pilot PC shows the firmware as served                          |        |       |
| Unworn pager on its charger updated by itself (minutes)        |        |       |
| Worn pager updated with "Update now"                           |        |       |
| A deliberately broken image rolled back and showed "went back" |        |       |
| An image signed with another key refused by the PC             |        |       |
