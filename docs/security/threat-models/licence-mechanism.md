# Threat model: The licence mechanism

The signed licence a restaurant PC holds, how it is bound to that PC, how time is judged, how the
Owner reactivates it offline with the vendor, and what a lapsed licence stops. Here the attacker is
usually the customer, on a PC they administer. Written in P8-03b (2026-10-10). Related:
`docs/runbooks/control-plane.md`, `manual-tasks/23-licensing.md`.

## Scope

- `packages/licensing`: the licence file and its Ed25519 signature, the vendor keys built into the
  software, the PC's fingerprint, the licence states, reactivation codes, the clock guard.
- The Control Plane issuing, renewing, re-binding and suspending licences (`apps/control-plane/src/licences`).
- The PC's licence agent and what it enforces (`apps/server/src/licensing`), and its screens.

## Assets

- The vendor's licence-signing key and the reactivation master key, at the Control Plane.
- The public keys built into the software (`VENDOR_LICENCE_KEYS`).
- On the PC, sealed with its DPAPI key: the licence file, the record of the last time seen, the
  pending restriction, the reactivation counter and the tamper events waiting to be sent; the
  reactivation secret.
- The vendor's revenue, and the restaurant's ability to take orders.

## Entry points

- The heartbeat's answer: the licence, the reactivation secret, the server's time.
- The vendor's licence commands (CLI and web app): change, re-bind, reactivation code.
- On the PC: `POST /licence/reactivate` and `/licence/check` (the Owner), `GET /licence`.
- Everything on a PC its owner administers: the database, the clock, the registry and WMI, the
  environment and the server's JavaScript files.

## Trust boundaries

1. The vendor's Control Plane ↔ a PC the customer controls.
2. The server's account ↔ the PC's administrators.
3. The Owner ↔ the vendor's support, by phone, for a reactivation code.

## Data flows

1. Each heartbeat carries the licence's id, five hashed PC identifiers, whether the PC holds a
   reactivation secret, and tamper events.
2. The Control Plane binds the fingerprint or compares it, and issues or renews a signed licence:
   30 days' validity, the state, the grace, the device limits, a counter.
3. The PC checks the signature against the built-in keys, then the installation, three of the five
   identifiers and the guarded time.
4. The resulting state gates new tables, orders, KOTs and device pairing, from the next business
   day.
5. A reactivation code read over the phone is checked against the reactivation secret and recorded
   in the sealed record.

## Threats

### Spoofing

#### LICENCE-S1 A forged licence

The customer writes their own licence, or points the server at their own key.

- Mitigation: the licence is checked with Ed25519 over its exact text against the vendor keys built
  into the software; production refuses other keys and switching enforcement off; the service
  starts the server in production with none of the variables a person set by hand.
- Code: `packages/licensing/src/signing.ts` (`verifyLicence`); `packages/licensing/src/vendor-keys.ts`
  (`VENDOR_LICENCE_KEYS`); `apps/server/src/config/app-config.ts` (`loadConfig`);
  `apps/server/src/installation/installation.ts` (`inheritedEnvironment`).
- Tests: `packages/licensing/test/licensing.test.ts` "accepts a file signed by a vendor key built
  into the software", "refuses a missing, unknown-key, tampered or malformed file";
  `apps/server/test/unit/app-config.test.ts` "always applies the licence in production, with only
  the keys built in"; `apps/server/test/unit/installation.test.ts` "drops our variables from what a
  child inherits".
- Risk: likelihood Low, impact High: Medium.
- Status: Mitigated.

#### LICENCE-S2 One licence on two PCs

The customer copies the licence, or the whole PC, to a second restaurant.

- Mitigation: the licence names the installation and the hashes of five PC identifiers, and three
  must match; the Control Plane refuses another PC until support re-binds it, audited. A clone of
  the whole PC matches all five, but two PCs sending one installation's heartbeats keep two
  different audit chains, which the Control Plane reports.
- Code: `packages/licensing/src/fingerprint.ts` (`isLicensedPc`);
  `apps/control-plane/src/licences/licences.service.ts` (`forHeartbeat`);
  `packages/domain/src/fleet-health.ts` (`checkChainHead`).
- Tests: `packages/licensing/test/licensing.test.ts` "tolerates two changed identifiers, not
  three"; `apps/control-plane/test/integration/licences.int.test.ts` "follows one part changed,
  refuses another PC until support re-binds it"; `packages/domain/test/fleet-health.test.ts`
  "detects a chain cut back, rewritten or emptied".
- Risk: likelihood Medium, impact Medium: Medium.
- Status: Partly mitigated. Accepted: an administrator can replay the identifiers (MachineGuid is a
  registry value) or clone a virtual machine; the two chains give a clone away once both go
  online, and binding to hardware a customer owns can never be complete.

#### LICENCE-S3 A forged reactivation code

The customer makes their own reactivation codes to stay active offline.

- Mitigation: a code carries the day and a counter under a 56-bit HMAC with the installation's
  reactivation secret; five tries an hour; the counter must be newer; a terminated contract is
  never reactivated. A code reaches 60 days at most: the Control Plane issues none further and the
  PC takes none further. The Control Plane keeps each code's day and counter (never the code);
  the PC reports the last code it took in its heartbeats until one is answered, and a code that
  matches none issued opens a licence tampering alert (SEC-015). The secret is on the PC, so an
  administrator can still make codes offline, each for 60 days at most, until the PC is online.
- Code: `packages/licensing/src/reactivation.ts` (`readReactivationCode`, `lastReactivationDay`);
  `apps/server/src/licensing/licence-agent.service.ts` (`LicenceAgentService.reactivate`,
  `heartbeatReport`); `apps/control-plane/src/licences/licences.service.ts` (`checkReactivation`);
  `apps/control-plane/src/fleet/fleet.service.ts` (`licenceTampering`).
- Tests: `packages/licensing/test/licensing.test.ts` "carries the day and a counter, read back only
  by its installation", "refuses a mistyped code", "reaches 60 days at most, as the vendor issues
  them"; `apps/server/test/integration/licence-agent.int.test.ts` "the Owner reactivates it offline
  with the vendor", "takes no code reaching past 60 days, and reports the code it took until
  delivered"; `apps/control-plane/test/integration/licences.int.test.ts` "checks the code a PC
  took against those issued, and alerts on another".
- Risk: likelihood Low, impact Medium: Low.
- Status: Partly mitigated. Accepted: the secret has to be on the PC for codes to work offline, so
  an administrator of the PC can make codes; each reaches 60 days at most, and the first heartbeat
  after it brings the alert.

### Tampering

#### LICENCE-T1 Editing the licence file

The customer changes the state, the dates or the limits in the stored licence.

- Mitigation: any change breaks the signature: the licence counts as tampered, which restricts,
  and the PC reports it.
- Code: `packages/licensing/src/signing.ts` (`verifyLicence`).
- Tests: `packages/licensing/test/licensing.test.ts` "refuses a missing, unknown-key, tampered or
  malformed file".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

#### LICENCE-T2 Editing the sealed record

The customer changes the record of the last time seen or the pending restriction.

- Mitigation: the record is sealed with AES-GCM; a changed record is reported and a pending
  restriction applies at once. Its key is in the PC's DPAPI store, so an administrator can write a
  valid record.
- Code: `apps/server/src/auth/secret-box.ts`; `apps/server/src/licensing/licence-agent.service.ts`
  (`LicenceAgentService`).
- Tests: `apps/server/test/integration/licence-agent.int.test.ts` "reports a clock set back and an
  edited record, which restricts at once".
- Risk: likelihood Low, impact Medium: Low.
- Status: Accepted: on a PC the customer administers, a sealed record can only make tampering
  harder, not impossible; LICENCE-T3's fix judges time also from what the vendor signed.

#### LICENCE-T3 Holding the clock back

The customer sets the PC's clock back, or keeps it behind, so the licence never expires.

- Mitigation: the PC judges by the latest of its clock, the last judged time moved on by the time
  the server has run since (a monotonic clock nobody can set), the newest licence's issue time and
  the issue time of the licence it holds, which the vendor signed and renews daily while online.
  A clock set back, or held back more than an hour behind the judged time, is reported and, when
  repeated, alerts at the Control Plane. So whenever the restaurant can take orders, the licence's
  end comes on time. The heartbeat answer's server time is not a floor: it is not signed, and a
  wrong one could push the PC's time years ahead; it is compared for CLOCK_SKEW only.
- Code: `packages/licensing/src/clock.ts` (`guardedNow`);
  `apps/server/src/licensing/licence-agent.service.ts` (`LicenceAgentService`).
- Tests: `packages/licensing/test/licensing.test.ts` "never judges by a time earlier than the last
  seen, and reports a clock set back", "moves on while the server runs, whatever the clock says,
  and reports a clock held back", "never falls behind the issue time of the licence held or the
  newest accepted"; `apps/server/test/integration/licence-agent.int.test.ts` "lets a licence
  run out offline with the clock held back, by the time the server runs".
- Risk: likelihood Low, impact Medium: Low.
- Status: Partly mitigated. Accepted: no clock nobody can set runs while the server is stopped on a
  PC the customer administers, so stopping the server between services with the clock held back
  stretches an offline licence by the hours it was off, never more; online the vendor's renewals
  and restrictions arrive as usual.

#### LICENCE-T4 Putting an older licence back

Offline, the customer puts back an older ACTIVE licence file over a newer one that restricts.

- Mitigation: the sealed record keeps the newest issue time accepted; a validly signed file issued
  before it counts as tampered (restricted from the next business day, reported), and the PC never
  keeps an older file the Control Plane sends. Online, the Control Plane sends the latest licence
  again when the PC reports another one. Putting the sealed record back with the file is
  LICENCE-T2's.
- Code: `packages/licensing/src/evaluate.ts` (`isOlderLicence`);
  `apps/server/src/licensing/licence-agent.service.ts` (`LicenceAgentService`).
- Tests: `packages/licensing/test/licensing.test.ts` "counts a signed licence older than the newest
  accepted as tampered"; `apps/server/test/integration/licence-agent.int.test.ts` "never takes a
  licence older than the newest it kept, and counts one put back as tampered";
  `apps/control-plane/test/integration/licences.int.test.ts` "sends nothing new while the licence
  is current, and the same one again if lost".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

#### LICENCE-T5 Patching the server

The server ships as JavaScript on a PC the customer administers; they edit it to skip the checks.

- Mitigation: the installer is signed and Program Files is writable by administrators only; the
  POS window's Electron fuses check its own `app.asar`. The server and `@rp/licensing` have no
  integrity check or obfuscation (LIC-007).
- Code: `apps/desktop/src/packaging/builder-config.ts` (`ELECTRON_FUSES`).
- Tests: `apps/desktop/test/packaging.test.ts` "no Node.js mode, options or debugger, and only its
  checked app.asar".
- Risk: likelihood Medium, impact High: High.
- Status: Not mitigated. Plan: P8-03d by 2026-10-22: decide what LIC-007's integrity checks and
  obfuscation can do on a customer's PC, and how the Control Plane notices a patched PC (the
  heartbeat's version and the files' hashes).

### Repudiation

#### LICENCE-R1 What the vendor did to a licence

A vendor staff member suspends, re-binds or reactivates a licence and it is disputed later.

- Mitigation: every change needs a reason and is audited in the append-only log; a terminated
  contract is never brought back.
- Code: `apps/control-plane/src/licences/licences.service.ts` (`LicencesService`).
- Tests: `apps/control-plane/test/integration/licences.int.test.ts` "never out of a terminated
  contract, and always with a reason"; `apps/control-plane/test/integration/admin.int.test.ts`
  "keeps the audit log append-only".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

#### LICENCE-R2 What happened on the PC

The Owner disputes when the licence restricted or who reactivated it.

- Mitigation: reactivations and state changes are audited on the PC with the actor and device.
- Code: `apps/server/src/licensing/licence-agent.service.ts` (`LicenceAgentService`).
- Tests: `apps/server/test/integration/licence-agent.int.test.ts` "the Owner reactivates it offline
  with the vendor"; `apps/server/test/integration/licence-exit.int.test.ts` "the grace runs out
  offline one evening: restricted only from the next business day".
- Risk: likelihood Low, impact Low: Low.
- Status: Mitigated.

#### LICENCE-R3 Tampering nobody looks at

A PC reports tampering (a clock set back, an edited record, another PC) and nobody at the vendor
notices.

- Mitigation: each report is audited at the Control Plane, and a licence tampering fleet alert goes
  to the webhook (SEC-015): at once for a licence file changed or put back, an edited record,
  another PC, or a reactivation code never issued; for the clock once it is reported three times
  within a week. A person closes it with a reason, and the reports count afresh from then.
- Code: `apps/control-plane/src/heartbeats/heartbeats.service.ts` (`HeartbeatsService`);
  `packages/domain/src/fleet-health.ts` (`tamperAlertDue`);
  `apps/control-plane/src/fleet/fleet.service.ts` (`licenceTampering`).
- Tests: `apps/control-plane/test/integration/licences.int.test.ts` "records what the PC reports as
  tampering, once per heartbeat"; `packages/domain/test/fleet-health.test.ts` "alerts at once for a
  licence or record changed, another PC, or a code never issued", "alerts for the clock only when
  it is reported again and again within a week";
  `apps/control-plane/test/integration/fleet.int.test.ts` "alerts at once for an edited licence or
  another PC, and Support closes it with a reason", "alerts for the clock only once it is reported
  again and again, counting afresh after"; `apps/control-plane-web/test/fleet.test.tsx` "shows what
  the PC reported and lets Support close it with a reason".
- Risk: likelihood Low, impact Low: Low.
- Status: Mitigated.

### Information disclosure

#### LICENCE-I1 Hardware serials leaving the PC

The PC's serial numbers reach the vendor or anyone who reads the heartbeats.

- Mitigation: each identifier is hashed with the installation's id before it leaves; placeholders
  are ignored.
- Code: `packages/licensing/src/fingerprint.ts` (`fingerprintHash`).
- Tests: `packages/licensing/test/licensing.test.ts` "keeps hashes tied to the installation, never
  the identifiers, and ignores placeholders".
- Risk: likelihood Low, impact Low: Low.
- Status: Mitigated.

#### LICENCE-I2 Licence details shown to staff

A waiter reads the restaurant's subscription terms.

- Mitigation: the details (limits, dates, terms) need `LICENSE_VIEW`; staff see only the banners.
- Code: `apps/server/src/licensing/licence.controller.ts` (`LicenceController`).
- Tests: `apps/server/test/integration/licence-agent.int.test.ts` "takes a valid licence from the
  Control Plane, and shows the Owner its details".
- Risk: likelihood Low, impact Low: Low.
- Status: Mitigated.

#### LICENCE-I3 The vendor's signing key leaking

Someone takes the licence-signing key or the reactivation master key and issues licences.

- Mitigation: the keys are configuration of the Control Plane, never in the repository; SEC-006
  wants the signing key in a cloud KMS, which waits for the account. Revoking a leaked key means a
  release without it.
- Code: `apps/control-plane/src/licences/licence-signer.ts` (`LicenceSigner`).
- Tests: none, the key's custody is the KMS's (manual task 23).
- Risk: likelihood Low, impact High: Medium.
- Status: Partly mitigated. Plan: manual task 23 by 2026-11-30: the signing key made in the cloud
  KMS, its public key built in, and two people reviewing the licensing code.

### Denial of service

#### LICENCE-D1 A lapse stopping a dinner service

The licence runs out, or the vendor restricts it, in the middle of a busy evening.

- Mitigation: a restriction starts at the next business day, never mid-service; it stops only new
  tables, orders and KOTs; bills, printing, reports, exports and backups keep working.
- Code: `packages/domain/src/machines/license.ts` (`restrictionEffectiveAt`);
  `apps/server/src/licensing/licence-agent.service.ts` (`assert`).
- Tests: `packages/licensing/test/licensing.test.ts` "never restricts mid-service: from the start of
  the next business day"; `apps/server/test/integration/licence-agent.int.test.ts` "without a
  licence: restricted from the next business day, never mid-service", "once a restriction applies:
  no new tables or orders; bills and reports still work";
  `apps/server/test/integration/licence-exit.int.test.ts` "the next morning: no new tables or
  orders; bills, reports and exports work".
- Risk: likelihood Low, impact High: Medium.
- Status: Mitigated.

#### LICENCE-D2 A failed fingerprint read taken for another PC

The PC's identifiers cannot be read once (a slow or failing PowerShell call), and the licence
believes it is on another PC.

- Mitigation: a read with fewer than three identifiers is unknown: it is not kept, the last read
  that said something stays in use and the PC reads again five minutes later; until a read says
  something the licence does not judge the PC by it. The Control Plane binds, compares and renews
  nothing on an unknown fingerprint, so a PC that never reads one runs out at the licence's end,
  as offline.
- Code: `packages/licensing/src/fingerprint.ts` (`fingerprintKnown`);
  `apps/server/src/licensing/licence-agent.service.ts` (`LicenceAgentService`);
  `apps/control-plane/src/licences/licences.service.ts` (`forHeartbeat`).
- Tests: `packages/licensing/test/licensing.test.ts` "tolerates two changed identifiers, not
  three", "takes a read of fewer than three identifiers for unknown, never for another PC", "judges
  no PC by a read that failed: the licence stands until a read succeeds";
  `apps/server/test/integration/licence-agent.int.test.ts` "judges no PC by a fingerprint read that
  said too little, and reads it again soon";
  `apps/control-plane/test/integration/licences.int.test.ts` "binds and renews nothing on a
  fingerprint read of fewer than three identifiers".
- Risk: likelihood Low, impact Low: Low.
- Status: Mitigated.

#### LICENCE-D3 A release with no vendor keys

A signed release built before the vendor's licence key exists trusts no licence, and every
restaurant that installs it restricts from the next business day.

- Mitigation: the keys' list is empty until manual task 23. The release guard reads the keys
  built into the staged server, what the installer will carry, and refuses a signed build while
  the licence keys or the pager firmware key digests (manual task 30) are empty or not keys
  (P8-03b3b). What remains: a key that is not the one in the KMS still builds; manual task 23
  checks a licence the Control Plane signed against the release before it goes out.
- Code: `packages/licensing/src/vendor-keys.ts` (`VENDOR_LICENCE_KEYS`);
  `apps/server/src/pager-firmware/firmware-keys.ts` (`PAGER_FIRMWARE_KEY_DIGESTS`);
  `apps/desktop/src/packaging/release-guard.ts` (`releaseRefusals`, `stagedKeys`);
  `apps/desktop/src/packaging/package-cli.ts`.
- Tests: `apps/desktop/test/packaging.test.ts` "refuses a signed build without the vendor’s
  licence key or pager firmware key", "reads the update settings and the keys the staged installer
  carries".
- Risk: likelihood Low, impact High: Medium.
- Status: Mitigated.

### Elevation of privilege

#### LICENCE-E1 Switching enforcement off

The customer sets the variables that turn the licence off or add their own key.

- Mitigation: production refuses both, and the service drops variables a person set.
- Code: `apps/server/src/config/app-config.ts` (`loadConfig`).
- Tests: `apps/server/test/unit/app-config.test.ts` "always applies the licence in production, with
  only the keys built in".
- Risk: likelihood Low, impact High: Medium.
- Status: Mitigated.

#### LICENCE-E2 A manager reactivating the licence

A manager types a reactivation code meant for the Owner.

- Mitigation: reactivation and the licence check are the Owner's (`LICENSE_MANAGE`).
- Code: `apps/server/src/licensing/licence.controller.ts` (`LicenceController`).
- Tests: `apps/server/test/integration/licence-agent.int.test.ts` "the Owner reactivates it offline
  with the vendor".
- Risk: likelihood Low, impact Low: Low.
- Status: Mitigated.

#### LICENCE-E3 More devices than the licence allows

The restaurant pairs more devices of a kind than it pays for.

- Mitigation: pairing codes are refused beyond the licence's limit for that kind; pagers are
  [PAGER-E3](pager-channel.md#pager-e3-more-pagers-than-the-licence-allows).
- Code: `apps/server/src/licensing/licence-agent.service.ts` (`limitFor`).
- Tests: `apps/server/test/integration/licence-agent.int.test.ts` "pairs no more devices of a kind
  than the licence allows".
- Risk: likelihood Low, impact Low: Low.
- Status: Mitigated.
