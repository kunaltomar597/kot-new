# Threat model: The update pipeline

How code gets from the repository onto every restaurant PC, phone, tablet and pager: CI builds and
signs, the vendor publishes a release and rolls it out from the Control Plane, the PC's update agent
downloads and checks it, and a SYSTEM task installs it with a way back. Written in P8-03b
(2026-10-10). Pager firmware has its own checks in [the pager channel](pager-channel.md); the
licence in [its model](licence-mechanism.md). Related: [ADR-0010](../../adr/0010-supply-chain-ci-and-contract-docs.md),
[ADR-0016](../../adr/0016-client-api-versioning.md), [ADR-0017](../../adr/0017-phone-and-tablet-updates.md),
`docs/runbooks/software-updates.md`.

## Scope

- The repository, its lockfile and its workflows; CI's builds, signing and checks (SEC-013).
- Releases, channels, rollouts, pins and hotfixes at the Control Plane.
- The PC's update agent (`apps/server/src/updates`): download, SHA-256 and Authenticode checks,
  timing, the backup before it, the hand-off to the updater; the updater
  (`infra/installer/windows`): its checks, the install, the health check and the way back.
- The phones and tablets: EAS updates gated by the PC's client API and code-signed, and APKs from
  the PC with their checks.
- The installer's bundled programs (Node.js, PostgreSQL, WinSW) pinned by SHA-256.

## Assets

- The Windows code-signing certificate: whatever it signs, every PC installs as SYSTEM.
- The EAS update-signing keys and the Android app-signing key (manual task 29); the pager firmware
  key (manual task 30).
- The repository, the lockfile and the workflows; CI's secrets.
- The release records at the Control Plane: address, SHA-256, size, version matrix, rollout.
- The installers on the PC, and the update policy built into each installation (the signer every
  update must carry).
- The restaurant's service and its database through an update.

## Entry points

- Pushes and pull requests that run workflows; Dependabot's pull requests; npm and the Actions
  marketplace.
- The Control Plane's vendor endpoints that publish, roll out and pin releases.
- On the PC: the heartbeat's answers and `GET /updates`, the download address, the update request
  file and "Install now".
- On phones: the PC's `/version`, the APK download from the PC, `u.expo.dev`.

## Trust boundaries

1. Pull-request authors ↔ CI's secrets.
2. CI ↔ the Control Plane: a person publishes the release's address and SHA-256.
3. The internet and the Control Plane ↔ the PC.
4. The server's account (`NT SERVICE\RPServer`) ↔ the SYSTEM updater, through a request file.
5. The PC ↔ the phones and tablets: the LAN with the pinned CA.
6. EAS ↔ the phones.

## Data flows

1. CI builds with the frozen lockfile and the pinned programs, signs the installer (on `main`
   only) and writes the version matrix.
2. The vendor publishes the release; the Control Plane offers a newer one to each PC by channel,
   rollout, pin or hotfix.
3. The PC downloads it over HTTPS, checks size, SHA-256 and the Authenticode signer, waits for the
   maintenance window or "Install now" with no open tables, backs up and checks the migrations.
4. It writes the request; the watchdog starts the SYSTEM task; the updater copies the installer to
   an administrators-only folder, checks it again, stops the services, copies the database,
   installs and checks the new version's health for 120 seconds, then keeps it or goes back,
   application and database.
5. The outcome goes into the heartbeat; the Control Plane halts a rollout that fails.

## Threats

### Spoofing

#### UPDATE-S1 A fake Control Plane serves an installer

A compromised Control Plane, or someone between it and the PC, offers an installer of their own.

- Mitigation: the download is HTTPS only, redirects included, and checked for its size and
  SHA-256; the installer must carry a valid Authenticode signature by the publisher built into the
  installation, checked by the agent and again by the updater; production needs an https Control
  Plane.
- Code: `apps/server/src/updates/update-download.ts` (`downloadInstaller`);
  `apps/server/src/updates/authenticode.ts` (`judgeSignature`);
  `infra/installer/windows/RestaurantPlatform.Setup.psm1` (`Test-RPInstallerSignature`).
- Tests: `apps/server/test/unit/updates.test.ts` "refuses plain HTTP, a redirect away from HTTPS
  and a refused request", "accepts only a valid signature by the vendor";
  `infra/installer/windows/tests/SoftwareUpdate.Tests.ps1` "accepts only a valid signature by the
  vendor, or no signature on a test build".
- Risk: likelihood Low, impact High: Medium.
- Status: Mitigated.

#### UPDATE-S2 A certificate with the vendor's name

Someone obtains a code-signing certificate whose subject reads like the vendor's.

- Mitigation: the signer's subject must match exactly, and the certificate must chain to a root
  Windows trusts; the issuer and the thumbprint are not checked.
- Code: `apps/server/src/updates/authenticode.ts` (`judgeSignature`);
  `infra/installer/windows/RestaurantPlatform.Setup.psm1` (`Test-RPInstallerSignature`).
- Tests: `apps/server/test/unit/updates.test.ts` "accepts only a valid signature by the vendor".
- Risk: likelihood Low, impact High: Medium.
- Status: Partly mitigated. Plan: P8-03d by 2026-10-22: the signer is pinned by its issuer as well
  as its subject, on the PC and in the updater.

#### UPDATE-S3 A spoofed update for the phones and tablets

Someone gives the apps an over-the-air update or an APK of their own.

- Mitigation: preview and production builds take only EAS updates signed with the owner's
  certificate, and only when the PC speaks their client API; an APK from the PC is downloaded over
  the pinned CA and checked for its SHA-256, package and version, and Android installs it only over
  the same signer. The keys are manual task 29.
- Code: `apps/waiter-app/app.config.ts`; `packages/domain/src/app-update.ts` (`otaUpdateVerdict`);
  `packages/mobile-native/android/src/main/java/com/rp/mobilenative/ApkInstalls.kt`.
- Tests: `apps/waiter-app/test/app-config.test.tsx` "takes only updates signed with the owner";
  `packages/mobile-native/test/ota-updates.test.ts` "passes on a download refused for its code
  signature"; `packages/mobile-core/test/apk-updates.test.ts` "says when the download fails its
  check, and offers it again".
- Risk: likelihood Low, impact High: Medium.
- Status: Partly mitigated. Plan: manual task 29 by 2026-11-30: the update-signing certificate and
  the app-signing keystore, then the check on a phone and a tablet.

#### UPDATE-S4 Someone posing as vendor staff publishes a release

Someone with a vendor account, or who took one, publishes a release or widens a rollout.

- Mitigation: publishing and rollouts need the vendor role that has `RELEASES_MANAGE`, signed in
  with a password and an authenticator, and are audited; a PC installs only what the vendor's
  certificate signed.
- Code: `apps/control-plane/src/admin/fleet-admin.controller.ts` (`publish`).
- Tests: `apps/control-plane/test/integration/admin.int.test.ts` "creates a tenant and
  installation, publishes a release and revokes, all audited".
- Risk: likelihood Low, impact Medium: Low.
- Status: Accepted: one person can publish; a release can only offer a build the certificate
  signed (UPDATE-S1), and a failing rollout halts by itself.

### Tampering

#### UPDATE-T1 A compromised dependency or Action

A package on npm, or a GitHub Action, is taken over and its new version runs in CI or ships in the
installer.

- Mitigation: the lockfile is frozen; install scripts are blocked except for a reviewed list;
  `pnpm audit` fails on high advisories; CodeQL; Dependabot waits days before proposing an update
  to a package or an Action; licences are checked; an SBOM per build; secret scanning. Every
  Action in every workflow is pinned to a full commit with its version in a comment, one commit per
  Action, and a test refuses a tag, a branch or a short commit (P8-03b3b). What remains: a package
  taken over and not found out within Dependabot's wait, which `pnpm audit` and review must catch;
  the test databases CI starts as service containers are by tag, and get no secrets and no access
  to the checkout.
- Code: `.github/workflows/security.yml`; `.github/workflows/ci.yml`; `.github/dependabot.yml`;
  `infra/ci/check-licenses.mjs` (`findViolations`).
- Tests: `infra/ci/check-licenses.test.mjs` "fails GPL, AGPL and SSPL even with an exception";
  `infra/ci/pinned-actions.test.mjs` "pins every Action in every workflow to a full commit, with
  the version it is", "runs each Action at one commit, in every workflow", "has Dependabot propose
  new pins, after the same wait as for packages".
- Risk: likelihood Low, impact High: Medium.
- Status: Mitigated.

#### UPDATE-T2 An installer changed on the PC before it runs

Someone with the server's account changes the checked installer before the SYSTEM updater runs
it.

- Mitigation: the agent checks the file again before the hand-off; the updater copies it into an
  administrators-only folder, checks the SHA-256 and the signature of that copy, and runs the copy.
- Code: `apps/server/src/updates/update-agent.service.ts` (`UpdateAgentService.prepare`,
  `installerMatches`); `infra/installer/windows/RestaurantPlatform.Setup.psm1`
  (`Invoke-RPUpdateStep`).
- Tests: `infra/installer/windows/tests/SoftwareUpdate.Tests.ps1` "changes nothing when the
  installer is not the one the server checked", "changes nothing when the signature is not
  valid".
- Risk: likelihood Low, impact High: Medium.
- Status: Mitigated.

#### UPDATE-T3 Going back to an older version

Someone gets the PCs to install an older, signed version with a known flaw.

- Mitigation: the Control Plane offers only newer releases, the agent takes only a newer version,
  the updater compares it with the installed one and the health check wants the version asked for.
  The installer's own version (the product version its version resource names, which the build
  writes) must be the version asked for: the agent checks it with the signature after the
  download, and the updater again before it stops anything (P8-03b3b), so an older signed
  installer published under a newer version's name and SHA-256 is refused.
- Code: `packages/domain/src/rollout.ts` (`releaseToOffer`);
  `apps/server/src/updates/update-agent.service.ts` (`isNewerVersion`);
  `apps/server/src/updates/authenticode.ts` (`installerVersionProblem`);
  `infra/installer/windows/RestaurantPlatform.Setup.psm1` (`Get-RPInstallerVersion`,
  `Invoke-RPUpdateStep`, `Wait-RPHealthyServer`).
- Tests: `packages/domain/test/rollout.test.ts` "offers the newest release the rollout reaches,
  and never an older one"; `packages/domain/test/software-update.test.ts` "moves only to a newer
  version"; `infra/installer/windows/tests/SoftwareUpdate.Tests.ps1` "never installs an older
  version, nor without the way back", "changes nothing when the installer is not the version
  asked for"; `apps/server/test/unit/updates.test.ts` "refuses an installer that is not the version
  the release names"; `apps/server/test/integration/update-agent.int.test.ts` "tries a failed
  download again later, and refuses a bad signature or another version".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

#### UPDATE-T4 Changed programs inside the installer

The Node.js, PostgreSQL or WinSW download used to build the installer is replaced.

- Mitigation: each is pinned by version and SHA-256, downloaded over HTTPS and checked at every
  use, including from the cache.
- Code: `apps/desktop/src/packaging/components.ts`; `apps/desktop/src/packaging/download.ts`
  (`fetchVerified`).
- Tests: `apps/desktop/test/packaging.test.ts` "are pinned by version and SHA-256, over HTTPS,
  under licences the policy allows", "refuses a download that does not match, leaving nothing
  behind", "downloads again when the cached file was changed".
- Risk: likelihood Low, impact High: Medium.
- Status: Mitigated.

#### UPDATE-T5 A changed APK on the PC

Someone replaces the phones' APK in the PC's apps folder.

- Mitigation: the PC checks each APK against the release's `apps.json` before offering it, and the
  phone checks the SHA-256 again.
- Code: `apps/server/src/updates/app-builds.service.ts` (`AppBuildsService`).
- Tests: `apps/server/test/integration/app-builds.int.test.ts` "stops offering an APK that changed
  on disk, and offers it again once it matches".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

#### UPDATE-T6 Unreviewed code on main

Someone pushes or merges to `main` without review, or an account without two-factor sign-in is
taken over; `main` is what gets signed.

- Mitigation: none in the repository: branch protection and two-factor sign-in are GitHub's
  settings, which manual task 1 now requires.
- Code: none, these are the repository's settings on GitHub (`manual-tasks/01-github-access.md`).
- Tests: none, GitHub's settings cannot be tested from the repository.
- Risk: likelihood Medium, impact High: High.
- Status: Not mitigated. Plan: manual task 1 by 2026-10-17: protect `main` (pull requests, CI
  checks), require two-factor sign-in, and create the `release-signing` environment.

### Repudiation

#### UPDATE-R1 Who published or changed a rollout

A vendor staff member denies publishing a release or widening its rollout.

- Mitigation: publishing, rollouts and pins are audited with the actor, the SHA-256, the reason and
  before and after, in an append-only log.
- Code: `apps/control-plane/src/releases/releases.service.ts` (`publish`, `updateRollout`, `pin`).
- Tests: `apps/control-plane/test/integration/admin.int.test.ts` "keeps the audit log
  append-only"; `apps/control-plane/test/integration/rollouts.int.test.ts` "halts a rollout by
  itself when the PCs installing it fail, and alerts each failure".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

#### UPDATE-R2 What a PC installed, and who allowed it

A manager denies allowing an update during service, or the vendor cannot tell what a PC runs.

- Mitigation: the hand-off and each outcome are audited on the PC (approver, trigger, signer) and
  reported in the heartbeat.
- Code: `apps/server/src/updates/update-agent.service.ts` (`handOff`, `record`).
- Tests: `apps/server/test/integration/update-agent.int.test.ts` "backs up, then hands a security
  fix the manager approved to the updater"; `apps/server/test/integration/update-exit.int.test.ts`
  "the PC records and reports the rollback".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

#### UPDATE-R3 Which commit a signed installer came from

Nobody can prove which commit and which build made a signed installer.

- Mitigation: CI writes an SBOM per commit; it is not attached to the release, and the release
  does not name its commit or build.
- Code: `.github/workflows/security.yml`.
- Tests: none, provenance is CI's configuration.
- Risk: likelihood Medium, impact Medium: Medium.
- Status: Not mitigated. Plan: P8-03d by 2026-10-22: a build attestation, the SBOM and the commit
  with each release (SEC-013's checklist).

### Information disclosure

#### UPDATE-I1 The signing certificate leaking

The certificate's file and password, kept as CI secrets, are taken by code running in CI.

- Mitigation: only a push to `main` reaches them, through the `release-signing` environment, and
  only the two signing steps; pull requests and forks never do. The key is still a file, where
  SEC-006 asks for a hardware token or a cloud HSM.
- Code: `.github/workflows/ci.yml` (`release-signing`, `WIN_CSC_LINK`).
- Tests: `infra/ci/signing-policy.test.mjs` "gives the certificate only to a push to main, in its
  environment", "uses the certificate in no other workflow, and runs no pull_request_target".
- Risk: likelihood Low, impact High: Medium.
- Status: Partly mitigated (fixed in P8-03b: every pull-request build received the certificate).
  Plan: manual task 31 by 2026-11-30: a certificate whose key stays in an HSM, signed through its
  service from the `release-signing` environment.

#### UPDATE-I2 A PC seeing other PCs' releases

A PC learns of hotfixes or channels meant for others.

- Mitigation: each PC gets its own channel's releases, and a hotfix only when it is the target.
- Code: `apps/control-plane/src/releases/releases.service.ts` (`candidates`).
- Tests: `apps/control-plane/test/integration/rollouts.int.test.ts` "holds a PC at a version, and
  gives a hotfix to its PC only".
- Risk: likelihood Low, impact Low: Low.
- Status: Mitigated.

### Denial of service

#### UPDATE-D1 A failed update stopping the restaurant

An update breaks the PC during service.

- Mitigation: updates install in the maintenance window with no open tables (a security fix
  earlier only with a manager's approval), after a backup and a check of the migrations; the
  updater copies the database, checks the new version for 120 seconds and goes back, application
  and database; a failed version is not tried again by itself and the rollout halts.
- Code: `packages/domain/src/software-update.ts` (`updateTiming`);
  `apps/server/src/updates/update-agent.service.ts` (`prepare`);
  `apps/control-plane/src/releases/releases.service.ts` (`haltIfUnhealthy`).
- Tests: `apps/server/test/integration/update-agent.int.test.ts` "never installs with open
  tables, unless security-critical and approved", "records a rollback, reports it, and does not
  try that version again by itself"; `infra/installer/windows/tests/SoftwareUpdate.Tests.ps1`
  "fails the health check on purpose and rolls back, the restaurant keeping its version";
  `apps/server/test/integration/update-exit.int.test.ts` "fails its health check; the updater goes
  back to 1.1.0 and the database before it".
- Risk: likelihood Low, impact High: Medium.
- Status: Mitigated.

#### UPDATE-D2 An update that locks out older phones

The PC updates and the phones, not yet updated, stop working.

- Mitigation: the server serves the current and the previous client API (N-1) and tells an older
  app to update with 426.
- Code: `apps/server/src/http/client-version.ts` (`clientTooOld`).
- Tests: `apps/server/test/integration/client-compat.int.test.ts` "refuses an app older than that
  with 426 CLIENT_TOO_OLD".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

#### UPDATE-D3 Firmware that stops the pagers

A firmware release leaves the pagers unable to start.

- Mitigation: see [the pager channel](pager-channel.md), PAGER-D5: signature checked on the PC,
  free pagers only, a few at a time, rollouts halted on rollbacks.
- Code: `apps/server/src/pager-firmware/firmware-image.ts` (`verifyFirmwareSignature`).
- Tests: `apps/server/test/unit/pager-firmware-image.test.ts` "refuses an image signed with a key
  the pagers do not trust".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

### Elevation of privilege

#### UPDATE-E1 From the server's account to SYSTEM

Someone who controls the server's account writes an update request that makes the SYSTEM updater
run their program.

- Mitigation: the updater reads only its request, checks it strictly, runs only a newer installer
  signed by the vendor from its own folder, and runs each request once.
- Code: `infra/installer/windows/RestaurantPlatform.Setup.psm1` (`ConvertTo-RPUpdateRequest`,
  `Invoke-RPUpdateStep`).
- Tests: `infra/installer/windows/tests/SoftwareUpdate.Tests.ps1` "trusts nothing in it beyond its
  checks: no other file, hash or version", "copies the updater where only administrators write,
  and registers its task", "runs each request once, and ends one a restart cut short as FAILED".
- Risk: likelihood Low, impact High: Medium.
- Status: Mitigated.

#### UPDATE-E2 A pull request signed as the vendor's

Someone opens a pull request from a branch of the repository; its CI build used to sign it with the
vendor's certificate, and every PC would install that build.

- Mitigation: the Windows installer job signs only for a push to `main`, in the `release-signing`
  environment whose secrets GitHub gives to `main` only; other builds are unsigned test builds
  that take unsigned updates and are never installed at a restaurant.
- Code: `.github/workflows/ci.yml` (`release-signing`, `RP_ALLOW_UNSIGNED_UPDATES`).
- Tests: `infra/ci/signing-policy.test.mjs` "gives the certificate only to a push to main, in its
  environment", "builds everything else as unsigned test builds that take unsigned updates".
- Risk: likelihood Low, impact High: Medium.
- Status: Partly mitigated (fixed in P8-03b: the job had the certificate on every pull request).
  Plan: manual task 1 by 2026-10-17: the certificate's secrets go into the `release-signing`
  environment limited to `main`, never into the repository's secrets, which a pull request's own
  workflow could read.

#### UPDATE-E3 An unsigned test build at a restaurant

A test build, which takes unsigned updates, is installed at a restaurant; then anyone who can
offer it an update runs code as SYSTEM.

- Mitigation: the release guard, a tested function the package step runs, refuses a signed build
  that allows unsigned updates, names no publisher or was staged off Windows; a build with neither
  refuses every update; the runbooks say never to install a test build. Each heartbeat says how
  the PC checks its updates, and the Control Plane alerts on a PC that takes unsigned ones (in the
  webhook and the vendor web app) until a signed build replaces it (P8-03b3b).
- Code: `apps/desktop/src/packaging/nsis.ts` (`updateSettingsFrom`);
  `apps/desktop/src/packaging/release-guard.ts` (`releaseRefusals`, `signedBuild`);
  `apps/desktop/src/packaging/package-cli.ts`; `packages/domain/src/software-update.ts`
  (`updateSigningOf`); `packages/domain/src/fleet-health.ts` (`fleetAlertsDue`);
  `apps/server/src/cloud/heartbeat.service.ts` (`HeartbeatService`).
- Tests: `apps/desktop/test/packaging.test.ts` "names the signer updates must carry, or allows
  unsigned ones on a test build only", "refuses a signed build that takes unsigned updates or
  names no signer", "refuses a signed build staged off Windows, even as a test of the script",
  "counts a build as signed as electron-builder does: WIN_CSC_LINK when set, else CSC_LINK";
  `apps/server/test/unit/updates.test.ts` "takes unsigned installers only on a test build, and
  never a damaged signature"; `apps/server/test/integration/update-agent.int.test.ts` "is
  unavailable without a version from the installer, or a way to check signatures";
  `packages/domain/test/fleet-health.test.ts` "alerts while a PC takes unsigned updates, a test
  build at a restaurant"; `apps/control-plane/test/integration/fleet.int.test.ts` "alerts while a
  PC takes unsigned updates, until a signed build replaces it";
  `apps/server/test/integration/update-exit.int.test.ts` "the PC records and reports the rollback;
  the vendor’s rollout halts by itself".
- Risk: likelihood Low, impact High: Medium.
- Status: Mitigated.
