# Pager firmware fixtures

`rp-pager-1.0.0.bin` is an ESP-IDF app image header for the ESP32-S3 (chip id 9) with the app
description of `rp-pager` 1.0.0, signed for secure boot v2 by Espressif's own tool, so the
server's check (`src/pager-firmware/firmware-image.ts`) is tested against the real format:

```
espsecure generate-signing-key --version 2 --scheme rsa3072 key.pem
espsecure sign-data --version 2 --keyfile key.pem --output rp-pager-1.0.0.bin image.bin
espsecure digest-sbv2-public-key --keyfile key.pem --output digest.bin
```

(esptool 5.4.0, 2026-10-05). The key's digest is in `test/unit/pager-firmware-image.test.ts`; the
private key was thrown away. Other tests sign images with `test/helpers/pager-firmware.ts`, which
espsecure verified the same day (`verify-signature --version 2`, `digest-sbv2-public-key`).
