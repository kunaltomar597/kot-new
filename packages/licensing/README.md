# @rp/licensing

Vendor-signed licence files and the licence state a restaurant experiences (LIC-001 to LIC-007),
used by the local server. Apps never verify a licence: they get their entitlements from the server
(LIC-003).

- `signing.ts`: the licence file is the payload's exact JSON text with the vendor's Ed25519
  signature and the signing key's id. `verifyLicence` accepts only files signed by a vendor key
  built into the software (several, for rotation). The signing key lives only in the cloud KMS;
  `signLicence` is what the Control Plane's signer does.
- `fingerprint.ts`: five hardware identifiers, kept only as SHA-256 hashes tied to the
  installation; three of five must match (LIC-004).
- `evaluate.ts`: `evaluateLicence` turns the verified file, this PC and the time into the state
  of LIC-005 and what the restaurant can do. A restriction applies only from the next business
  day after it is first decided.
- `reactivation.ts`: 16-character offline reactivation codes read over the phone (LIC-006).
- `clock.ts`: the clock guard: never judge by a time earlier than the last seen (LIC-007).

Built by: P7-01a. Security-sensitive: two human reviewers before release (NFR-M05, manual task
23).
