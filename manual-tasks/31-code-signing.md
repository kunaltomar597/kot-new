# 31. The Windows code-signing certificate

What it unblocks: signed installers and signed updates (UPD-007, SEC-013, SEC-014). Every
restaurant PC installs, as SYSTEM, whatever this certificate signed, so it is the most valuable key
the vendor holds (threat model "The update pipeline", UPDATE-I1 and UPDATE-E2). Until it exists,
CI builds unsigned test installers, which must never be installed at a restaurant.

Never paste the certificate, its password or anything that unlocks its key into a Claude session
or a commit.

## 1. Buy the certificate (Business Owner)

- An OV or EV code-signing certificate in the company's name, from a CA Windows trusts.
- Since June 2023 the CA/Browser Forum's rules keep a code-signing key on a hardware token or in a
  cloud HSM, which is also what SEC-006 asks. Choose an offer that signs from CI through the CA's
  cloud service (for example DigiCert KeyLocker, SSL.com eSigner, Sectigo's cloud signing) or
  Azure Trusted Signing, not a USB token that has to be plugged into a PC.
- Verification can take weeks; start early (Owner checklist item 3).

## 2. Keep it to `main`

1. Do manual task 1, step 3 first: the GitHub environment `release-signing`, deployable from
   `main` only.
2. Put the signing service's credentials into that environment's secrets (never the repository's
   own secrets: every branch's workflow, a pull request's included, can read those).
3. Put the certificate's subject (`Subject:` in its details, e.g. `CN=..., O=..., L=..., C=IN`)
   into the repository variable `RP_UPDATE_PUBLISHER`, and its issuer (`Issuer:`, the authority
   that signed it) into `RP_UPDATE_ISSUER`. A signed build is refused without both (UPDATE-S2).
4. Tell Claude which signing service it is. Claude changes the "Windows installer" job to sign
   through it (electron-builder's custom `sign` hook calling the service's tool), keeping the
   signing to pushes to `main` (`infra/ci/signing-policy.test.mjs`).

If the CA does give a `.p12` file, its base64 goes into the environment secret
`WINDOWS_CERTIFICATE_P12` and its password into `WINDOWS_CERTIFICATE_PASSWORD`; the job already
uses them.

## 3. Check it

1. Push to `main`; the "Windows installer" job waits for the environment and then signs.
2. Download the `windows-installer` artifact; on a Windows PC, right-click the installer →
   Properties → Digital Signatures: the company's name, "This digital signature is OK".
3. Manual task 14 then installs it on a clean PC.

## Results

```
Certificate: CA ______, type OV / EV, valid until ______
Key held in: cloud HSM / hardware token: ______
Signing service: ______
Environment release-signing limited to main: yes / no
Signed installer checked on a PC (date): ______
```
