# LAN TLS: trusting the restaurant's certificate authority

For the installer, support and the restaurant's manager. Background: ADR-0011, SEC-001, SEC-010.

Everything on the restaurant network talks to the server PC over HTTPS (and WSS for live updates).
The server has its own certificate authority (CA), created once when it first starts. Our apps
trust it automatically; each browser that opens the console must be told to trust it once.

## What the server does by itself

- First start: creates the restaurant's CA (valid 10 years) and a certificate for the server,
  covering its LAN addresses, `localhost`, the computer's name and any names in
  `RP_TLS_HOSTNAMES`.
- Every minute: renews the server certificate if it expires within 30 days, if the PC got a new
  address (a new router or DHCP reservation) or if the PC's clock was wrong when it was issued. The
  new certificate is used at once, without a restart. Devices keep working because they trust
  the CA, which does not change.
- Keeps its files in `<RP_DATA_DIR>/tls/`:
  - `ca.crt`: the CA certificate. Public; safe to copy to a USB stick.
  - `ca.sealed`, `server.sealed`: certificates with their private keys, encrypted with a key from
    the secret store. Useless without it. Backups must include this folder and the secret store
    (P7-05); if they are lost, every device must trust a new CA (browsers: repeat this guide;
    apps: pair again).

Settings (environment of the server service, set by the installer):

```
RP_TLS=on                      # serve HTTPS/WSS on PORT (TLS 1.2 or newer)
RP_TLS_HOSTNAMES=pos.local     # optional extra names, comma-separated; restart to apply
```

## The fingerprint: how people know it is the right CA

The fingerprint is a SHA-256 checksum of the CA, 32 pairs of characters like `3A:7F:…:C2`. Before a
device trusts a CA, compare its fingerprint with the one the server PC shows. If someone on the
network tried to slip in their own CA, the fingerprints differ.

Read it on the server PC itself (a connection to `localhost` cannot be intercepted from the
network):

- open `https://localhost:8080/api/v1/tls/ca` in a browser on the server PC and note `sha256`
  (8080 is the default `PORT`; the browser's warning is safe to pass here, `localhost` is this
  PC), or
- look for `Serving HTTPS with the installation CA` in the server log (`caSha256`).

## Our apps: nothing to install

Waiter phones and table tablets get the fingerprint from the pairing QR code
(`{"v":1,"code":"…","ca":"<fingerprint>"}`), fetch the CA from `GET /api/v1/tls/ca`, check that it
matches and from then on trust only that CA (pinning, SEC-010). Pagers are flashed with the CA
(P2-05). The POS on the server PC pins it itself (P0-16).

## Browsers: install the CA once per device

Needed for kitchen screens (KDS) and managers' laptops, tablets and phones.

### 1. Download the CA

On the device, open `https://<server address>:8080/ca.crt` (the address the device will use,
e.g. `https://192.168.1.10:8080/ca.crt`).

The browser warns that the connection is not private. That is expected: the device does not trust
the CA yet. Choose "Advanced" and continue, only for this download; the fingerprint check below
protects you. You can instead copy `ca.crt` from the server PC with a USB stick.

### 2. Install it and check the fingerprint

Android (Chrome), Android 11 or newer:

1. Settings → Security and privacy → More security settings → Encryption and credentials →
   Install a certificate → CA certificate → Install anyway. (Names vary by manufacturer; search
   Settings for "CA certificate".) Android asks for a screen lock if the device has none.
2. Pick `restaurant-ca.crt` from Downloads.
3. Check: Encryption and credentials → Trusted credentials → User → tap
   "Restaurant Operations Platform Local CA …" → compare the SHA-256 fingerprint. If it differs,
   tap Remove and call support.

iPhone and iPad (Safari):

1. Open the link in Safari → Allow (a configuration profile is downloaded).
2. Settings → Profile Downloaded → before Install, tap the certificate → More Details → compare
   the SHA-256 fingerprint. If it differs, tap Remove and call support.
3. Install, then Settings → General → About → Certificate Trust Settings → turn on
   "Restaurant Operations Platform Local CA …".

Windows (Edge, Chrome):

1. Check first, in PowerShell:

   ```powershell
   $c = [Security.Cryptography.X509Certificates.X509Certificate2]::new("$HOME\Downloads\restaurant-ca.crt")
   [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($c.RawData)).Replace('-', ':')
   ```

2. If it matches: double-click the file → Install Certificate → Current User → Place all
   certificates in the following store → Trusted Root Certification Authorities → Finish → Yes.
   (Windows shows a SHA-1 "thumbprint" in its warning; the SHA-256 check above is the one to
   compare.)

macOS (Safari, Chrome): double-click the file (it goes to the login keychain) → open it in Keychain
Access → compare the SHA-256 fingerprint → Trust → When using this certificate: Always Trust.

Firefox (any system) keeps its own list: Settings → Privacy and Security → Certificates → View
Certificates → Authorities → Import → tick "Trust this CA to identify websites" → View to compare
the SHA-256 fingerprint.

Any computer with OpenSSL: `openssl x509 -in restaurant-ca.crt -noout -fingerprint -sha256`.

### 3. Open the console

Open `https://<server address>:8080/`: no warning, the console loads. Pair the device with a code
from a manager as usual.

## When something goes wrong

- "Your connection is not private" / `NET::ERR_CERT_AUTHORITY_INVALID`: this device does not trust
  the CA. Do step 2 again; on iPhone and iPad check Certificate Trust Settings.
- `NET::ERR_CERT_COMMON_NAME_INVALID`: the address typed is not in the certificate. Use the server's
  LAN address or its computer name. After the server's address changed, wait a minute and reload.
  A new name needs `RP_TLS_HOSTNAMES` and a restart of the server.
- `NET::ERR_CERT_DATE_INVALID`: a clock is wrong. Fix the device's date and time; if the server
  PC's clock was wrong, correct it and wait a minute.
- Fingerprints differ: do not trust the certificate. Remove it and tell support; someone may be
  interfering with the network.
- The server PC was reinstalled without its data folder and secret store: it has a new CA. Remove
  the old CA from every browser, repeat this guide, and pair every app again.
- The server stops at start with an error about decrypting or authenticating TLS data: the `tls`
  folder and the secret store come from different installations or backups. Restore both from
  the same backup; do not delete the folder unless you accept a new CA (see above).
