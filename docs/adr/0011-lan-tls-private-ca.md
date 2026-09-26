# ADR-0011: LAN TLS with a per-installation private CA, pinned by our apps

Status: Accepted
Date: 2026-09-26
Work package: P0-15
Requirements: SEC-001, SEC-010, OI-07, NFR-A01, SEC-006

## Context

SEC-001 requires HTTPS/WSS for apps and browsers and MQTTS for pagers on the restaurant LAN, and
leaves the certificate source to an ADR (open item OI-07). Browsers also need a secure context for
WebCrypto, which the console uses to create its device key (P0-14b): today only the server PC
(localhost) can pair a browser.

Forces:

- In-restaurant operations never depend on the internet (NFR-A01): certificate issuance and renewal
  must work offline for months.
- Clients are our own apps (Android waiter app and table tablets, React Native; ESP32 pagers) and
  browsers (KDS screens on Android, manager laptops and phones, the Electron POS on the server PC).
- Our apps can pin whatever we tell them to (SEC-010); browsers only trust what the operating
  system or browser trusts.
- The server usually has a DHCP-reserved LAN IP; the restaurant has no DNS of its own.

The two options named by the BRD:

- (a) a private certificate authority per installation, pinned in our apps and installed on the
  browsers that need it;
- (b) publicly trusted certificates for a per-restaurant hostname (e.g.
  `r-1a2b.pos.example.net` → the LAN IP), issued by the Control Plane with an ACME DNS-01
  challenge.

## Decision

Option (a) is the default and is implemented now; (b) can be added later for manager browsers
without changing the apps.

- At first start the server creates an ECDSA P-256 CA (`CN=Restaurant Operations Platform Local
CA <installation>`, valid 10 years, path length 0, key usage certificate and CRL signing only).
- It issues itself a server certificate from that CA for every LAN address it has (non-internal
  IPv4 addresses and `127.0.0.1`), `localhost`, the computer's host name (also `<name>.local`) and
  any configured names (`RP_TLS_HOSTNAMES`, e.g. `pos.local`). Validity 397 days (inside every
  browser's limit). Checked every minute: renewed 30 days before expiry, at once when the PC has an
  address or name the certificate lacks (devices are configured with the server's address, BRD
  §10.4), and when it is not valid yet (issued while the clock was ahead). A renewed certificate is
  swapped into the running server without a restart.
- Private keys never leave the PC in clear: each certificate and its key are one file under
  `<RP_DATA_DIR>/tls` (`ca.sealed`, `server.sealed`) encrypted with AES-256-GCM under a key from
  the secret store (DPAPI on the restaurant PC, SEC-006). One file per pair means a crash during
  renewal never leaves a certificate with the wrong key. `ca.crt` is a plain copy of the CA
  certificate for people to install.
- `RP_TLS=on` serves HTTPS (and so WSS) on `PORT` with TLS 1.2 as the minimum, set explicitly
  rather than left to Node's default; nothing on the LAN is served without TLS. Development and
  tests keep plain HTTP (`RP_TLS` unset).
- Pinning: `GET /api/v1/tls/ca` returns the CA certificate and its SHA-256 fingerprint; the pairing
  code response carries the fingerprint (`caSha256`, and `ca` in its QR payload), so an app
  scanning the manager's QR code checks the CA it downloads against it and then trusts only that
  CA. React Native apps load the pinned CA into their HTTP and WebSocket client at run time (a
  custom OkHttp client on Android: the static network security configuration cannot hold a
  per-installation CA; P2-01), the Electron POS checks it in `setCertificateVerifyProc` (P0-16),
  Node clients pass it as `ca`.
- Browsers: the KDS and manager browsers download the CA from `https://<server>:<port>/ca.crt` and
  install it once, after comparing its fingerprint with the one the server PC shows (runbook
  `docs/runbooks/lan-tls.md`).

## Alternatives considered

- (b) public certificates via DNS-01: no CA to install on browsers, but issuance and renewal (every
  90 days) need the internet and the Control Plane, a public DNS name leaks the restaurant's LAN
  IP, and an outage of either stops browsers from connecting once a certificate expires, which
  conflicts with NFR-A01. Kept as a later option for manager browsers only.
- Self-signed server certificate without a CA: every renewal or IP change would need every device
  to trust a new certificate; a CA separates long-lived trust from short-lived certificates.
- Plain HTTP on the LAN: violates SEC-001 and blocks WebCrypto in browsers.

## Consequences

- Browsers need a one-time CA installation, documented with fingerprint verification. Android
  Chrome trusts user-installed CAs; iOS needs the profile enabled in Certificate Trust Settings.
- The CA key is the root of LAN trust: losing it (disk failure) means re-pairing apps after a
  restore unless the backup (P7-05) carries the encrypted key and the secret store key.
- MQTTS for pagers (P2-04) uses the same server certificate; the pager firmware pins the CA
  (P0-H1, P2-05).
- The Control Plane could later sign a name-constrained intermediate for option (b) without
  changing clients that pin the root.
- The CA expires after 10 years. Replacing it means every app pins the new CA (re-pairing, or a
  hand-over signed by the old CA) and every browser installs it; this is planned maintenance long
  before expiry, not automatic.
- The certificate lists every IPv4 address of the PC, including virtual adapters (VPN, WSL) whose
  addresses change; that only causes harmless re-issues.
