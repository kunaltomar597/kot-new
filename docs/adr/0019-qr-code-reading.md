# ADR-0019: QR codes read with a camera in the browser with jsQR

Status: Accepted
Date: 2026-10-08
Work package: P2-04b2
Requirements: PGR-012, SEC-011, NFR-A01, NFR-M07

## Context

PGR-012: "the manager pairs a pager (scan its QR code/serial) and assigns it to a waiter".
Since P4-02b the Pagers page takes the serial typed, or typed by a USB barcode scanner acting as
a keyboard. Few restaurants own a barcode scanner; every manager has a phone, and many restaurant
PCs have a webcam. So the register dialog reads the pager's QR code with the device's camera: a
phone's browser on the console, or the PC's webcam in the Electron shell, which already allows the
camera to its own server (decision 604).

The browser's `BarcodeDetector` would decode the frames, but Chromium ships it only on Android,
macOS and ChromeOS: Windows Chromium, so the shell on the restaurant PC, has none. The decoding must
run offline (NFR-A01), inside the console's CSP (`script-src 'self'`, no `wasm-unsafe-eval`), and the
dependency must pass the licence policy (NFR-M07).

The pager's side (P2-05) has not been built, so its QR content is set here.

## Decision

- **Decode with `jsqr`** (1.4.0, Apache-2.0, no dependencies, plain JavaScript): each frame is
  drawn on a canvas at most 640 px on its long side and decoded about every 150 ms, dark-on-light
  and light-on-dark (a pager's screen may show its code light on dark). One code path in every
  browser, the shell on Windows included; no worker and no WebAssembly, so the CSP stays as it is.
- **`@rp/ui-web` `QrScanner`** owns the camera: `getUserMedia` with video only (the back camera on a
  phone), the preview mirrored for a camera facing the person, the camera turned off when the
  scanner unmounts, and a `CameraProblem` (UNSUPPORTED, DENIED, NO_CAMERA, BUSY, FAILED) the screen
  explains. `hasCameraApi()` hides the Scan button where the browser has no camera API (a page that
  is not a secure context). Nothing leaves the device.
- **A pager's QR code holds `RP-PAGER:<serial>`** (`@rp/contracts` `PAGER_QR_PREFIX`,
  `pagerQrText`, `pagerSerialFromQr`). Upper case, so the code uses QR's alphanumeric mode: with
  error correction M a serial of up to 11 characters fits version 1 (21 modules) and up to 29
  version 2 (25 modules), easy to read on a small screen (lower case needs byte mode, so a
  larger code for the same serial). A bare serial
  (a supplier's label) is read too. Anything else (a device pairing code, a table's link) is
  "not a pager's code" and the camera keeps looking. A barcode scanner that types the whole text
  into the field leaves only the serial.
- **The Electron shell grants `media` for video only**: a request or check that includes audio is
  refused, as well as the page's own `Permissions-Policy: microphone=()`.

## Alternatives considered

- `BarcodeDetector` where present, jsQR elsewhere: faster on Android, but two decoders to test, and
  the restaurant PC, which matters most, would use jsQR anyway.
- `zxing-wasm` / the `barcode-detector` polyfill (MIT): reads many formats and reads faster, but
  is WebAssembly, so the CSP would need `wasm-unsafe-eval` for a feature that reads one QR code at
  set-up; the WASM file is also larger than jsQR.
- `@zxing/library` (Apache-2.0): a large port of ZXing for every barcode format; we need QR only.
- `qr-scanner` (MIT): wraps a jsQR fork in a web worker and prefers `BarcodeDetector`; a worker
  file to serve and a second decoder for the same result.
- A native camera app or the waiter app scanning for the console: more moving parts than a camera
  in the page that registers the pager.

## Consequences

- The console bundle grows by jsQR (about 130 kB minified). The QR menu and the vendor web app,
  which also use `@rp/ui-web`, do not import `QrScanner`, so their bundles leave jsQR out
  (`sideEffects` in `@rp/ui-web`).
- jsQR has had no release since 1.4.0. It is small and has no dependencies; the tests decode codes
  drawn by `uqr` (ADR-0014), light and dark, so a broken update fails CI, and the decoder is one
  function (`decodeQr`) to swap.
- P2-05 must show `RP-PAGER:<serial>` on the pager's pairing screen and print it on the label
  (`firmware/pager/README.md`).
- A phone's browser opens the camera only on a secure page: the console over HTTPS with the LAN CA
  (ADR-0011). Manual task 14 checks the PC's webcam and a phone.
