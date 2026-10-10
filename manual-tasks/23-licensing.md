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
   later. Until one is listed, a signed release refuses to build (the release guard,
   `apps/desktop/src/packaging/release-guard.ts`). Before the first signed release goes out,
   check it accepts a licence the Control Plane signed with the KMS key: the guard can tell a key
   from no key, not the right key from another.
5. Give the Control Plane the key. The signer (`apps/control-plane/src/licences/licence-signer.ts`)
   reads it from `CP_LICENCE_SIGNING_KEY` (PKCS#8 DER, base64) today. Best: once the cloud
   provider is chosen, ask Claude for a KMS adapter there, so the key never leaves the KMS. Until
   then, keep the key in the secret manager and inject it as `CP_LICENCE_SIGNING_KEY` only into
   the Control Plane's service.

## 2. The reactivation master key (vendor, once)

Create a 32-byte random secret in the secret manager, `rp-licence-reactivation-master`, readable
only by the Control Plane, injected as `CP_LICENCE_REACTIVATION_KEY` (base64). It derives each installation's offline reactivation secret (LIC-006).
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

## 4. Day-to-day (vendor staff, until the web app in P7-02)

From the operator host, with the environment's `DATABASE_URL`:

```
pnpm --filter @rp/control-plane cli licence:show --installation <id>
pnpm --filter @rp/control-plane cli licence:set --installation <id> --state GRACE --reason "Invoice 42 overdue"
pnpm --filter @rp/control-plane cli licence:set --installation <id> --state ACTIVE --reason "Paid by UPI"
pnpm --filter @rp/control-plane cli licence:rebind --installation <id> --reason "Motherboard replaced"
pnpm --filter @rp/control-plane cli licence:code --installation <id> --until 2026-11-15
```

A state change reaches an online restaurant within a minute while its licence is not active
(within five minutes otherwise). Read a reactivation code to the Owner only after checking who is
calling; it is shown once. A code reaches 60 days at most (the PC takes none further). The PC
reports the code it took at its next heartbeat; one the vendor never issued opens a licence
tampering alert (`docs/runbooks/control-plane.md`, "Licence tampering").
