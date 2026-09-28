# ADR-0014: QR codes drawn in the browser with uqr

Status: Accepted
Date: 2026-09-28
Work package: P4-02a
Requirements: AUTH-006, AUTH-007, NFR-A01, NFR-M07

## Context

The Owner adds the restaurant to an authenticator app by scanning a QR code of the `otpauth://`
link the server gives (AUTH-006, P4-02a). Device pairing (AUTH-007, P4-02c) shows its one-time
code as a QR code (the `PairingQrPayload` the phones scan since P2-01d), and the QR menu (P5)
prints table codes.

The QR code must be drawn on the device, offline (NFR-A01): the authenticator secret is inside the
link, so it must never go to an outside QR service, and the restaurant may have no internet. The
dependency must pass the licence allow-list (NFR-M07) and stay small, since the console is served
by the local server to every screen.

## Decision

- Encode with `uqr` (0.1.3, MIT, no dependencies, 27 kB of unminified ES module):
  `encode(text, { ecc, border })` returns the module matrix. We draw it ourselves.
- `@rp/ui-web` `QrCode` draws the matrix as one SVG path: dark modules on white with a four-module
  quiet zone in every theme (cameras read that best), error correction M, `role="img"` with a
  label that says what the code is for. It is sized in CSS pixels and scales down on a phone.
- Nothing is sent anywhere: the link is encoded in the browser that shows it.

## Alternatives considered

- `qrcode` (node-qrcode): MIT, but pulls `yargs`, `pngjs` and `dijkstrajs` for its CLI and image
  output; far more than drawing a matrix needs.
- `qrcode.react`: MIT and small, but it is a React DOM component with its own markup and props;
  the server (printed table codes, P5) could not use its encoder.
- Writing our own encoder: Reed-Solomon, masking and version selection are easy to get subtly
  wrong, and a wrong code fails only on some phones.
- A QR image from the server: works, but moves drawing out of the component library for no gain,
  and the authenticator link would travel as an image as well as text.

## Consequences

- The same `QrCode` serves device pairing (P4-02c) and printed table codes can reuse `uqr` on the
  server side (P5).
- `uqr` is a young library (0.x). The component test checks the finder patterns and quiet zone,
  so an update that breaks the output fails CI; if it is abandoned, the encoder is one call to
  swap.
