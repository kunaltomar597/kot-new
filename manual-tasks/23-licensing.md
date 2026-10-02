# 23. Licensing: the signing key and the security review

What it unblocks: licences that production installations accept (LIC-001, LIC-003), and the
release of the licensing code (NFR-M05: security-sensitive code needs two human reviewers).

Never paste the private key, or anything that unlocks it, into a Claude session or a commit.

## 1. Create the licence-signing key (vendor, once)

1. In the cloud KMS of the Control Plane's provider (India region), create an **Ed25519**
   asymmetric signing key named `rp-licence-signing-1`, usable only for signing, with no export.
2. Give the Control Plane's service identity permission to sign with it, and nobody else except
   two named vendor administrators (break-glass).
3. Export the **public** key as SPKI DER, base64 (one line). It is not secret.
4. Send the public key line to Claude (or open a pull request) to add it to
   `packages/licensing/src/vendor-keys.ts`. Installations accept only licences signed by a key
   listed there; a new key is added next to the old one, and the old one is removed a release
   later.
5. Set the Control Plane's signer to the KMS key (`CP_LICENCE_SIGNER=kms`,
   `CP_LICENCE_KMS_KEY=<key resource name>`).

## 2. The reactivation master key (vendor, once)

Create a 32-byte random secret in the secret manager, `rp-licence-reactivation-master`, readable
only by the Control Plane. It derives each installation's offline reactivation secret (LIC-006).
Losing it means old installations cannot take offline codes until they come online once.

## 3. Review (two people)

Two people who did not write it review, line by line:

- `packages/licensing/` (verification, fingerprint, state, reactivation codes, clock guard);
- the Control Plane's licence signer and issuance;
- the local server's licence agent and where it restricts ordering.

Check in particular: a file signed by another key, edited, from another installation or another
PC is refused; a restriction never starts mid-service; nothing deletes, encrypts or withholds the
restaurant's data in any state; reactivation codes cannot be reused or guessed (attempts are
limited). Record the reviewers' names and the commit reviewed in the pull request.
