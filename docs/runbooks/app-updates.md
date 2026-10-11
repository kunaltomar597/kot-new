# Phone and tablet updates

How the waiter app and the table tablet get new versions (UPD-001, UPD-007, WTR-001, P7-04e1,
P7-04e2, ADR-0017). It covers publishing an over-the-air update, new APKs from the restaurant PC,
what each device does with them, and support. MDM can push APKs too.

## In short

- **JavaScript changes go over the air** with EAS Update. Each build profile has its own channel
  (`eas.json`): `development`, `preview` and `production`. An update reaches only builds of the
  same app version (`runtimeVersion: appVersion`).
- **A device asks its restaurant's server first.** An update carries the client API it speaks.
  The phone or tablet takes it only when its server speaks that API (its own or the one before,
  N-1, ADR-0016):
  - an update for a newer server waits until the PC updates in its maintenance window;
  - an update for an older server than the PC serves is never taken.
- **It restarts on the update only when free:**
  - a waiter phone: nobody signed in and the app on screen;
  - a table tablet: between guests, staff mode closed;
  - either: at once when the server refuses the app as it is ("Update this app").

  Otherwise it launches the update at its next cold start.

- **Only signed updates.** Preview and production builds carry the update signing certificate,
  and refuse to build without it. The phone checks each update's signature before using it.

- **New native code comes as a new APK, from the restaurant PC.** The release's APKs travel in the
  PC's installer, so each PC offers the builds of its own release, after it has updated itself.
  A phone offers it on the sign-in screen and on "Update this app", and Android asks the person
  to confirm. A kiosk tablet (device owner) installs it by itself between guests, and opens again
  in kiosk mode.

## Publishing an over-the-air update

Needs the Expo project (`EAS_PROJECT_ID`) and the update signing private key, which stays off the
repository (manual task 29).

1. Build the workspace packages: `pnpm build`.
2. From each app's folder, publish to the channel of the builds that should get it:

   ```
   cd apps/waiter-app
   APP_ENV=production EAS_PROJECT_ID=<id> npx eas-cli update --channel production \
     --message "<what changed>" --private-key-path ~/rp-update-keys/private-key.pem
   ```

   Then the same from `apps/table-tablet` if it changed too.

3. The update records the client API of the commit it was made from (`extra.clientApi`). If the
   commit raised `CLIENT_API_VERSION`, the update waits on each phone until that phone's PC runs
   a release with the new API. To fix something on the API the restaurants run now, publish from
   a commit with that API (a branch from the release).

Each device looks for updates when it connects to its server and every 30 minutes, so a free
device runs a hotfix within about half an hour.

### Rolling back

- `npx eas-cli update:roll-back-to-embedded --channel production` from the app's folder sends
  devices back to the JavaScript inside their APK. Devices follow it without asking the server.
- Or republish an earlier update (`npx eas-cli update:republish`). It is judged like any update.

`expo-updates` also protects each device by itself: if a downloaded update fails to start, the
next launch falls back to the APK's JavaScript. The device reports it to the vendor's error
service through the restaurant's server ("A downloaded update did not start").

## New APKs from the restaurant PC

Needs the Android app-signing keystore in EAS (manual task 29). Every APK of an app must be
signed with the same key: Android installs a new APK only over an app signed with the same key
(UPD-007).

1. Set each app's version in its `package.json` (the build and the version matrix read it).
2. Build the production APKs: `npx eas-cli build -p android --profile production` in
   `apps/waiter-app` and in `apps/table-tablet`. Download them as `waiter-app.apk` and
   `table-tablet.apk` into one folder.
3. Stage the restaurant PC's installer with them:
   `pnpm --filter @rp/desktop package:stage --version <release> --apk <folder>` (or set
   `RP_APK_DIR`). The stage step copies them to the payload's `apps` folder as
   `<kind>-<version>.apk` with `apps.json`: each APK's version, client API, size and SHA-256.
   Without `--apk` the release carries no APK and the PCs offer none.
4. Release the installer as usual (`software-updates.md`). Once a PC has installed it, its
   phones and tablets see the new version within 30 minutes, or at once when they reconnect.

What happens on the devices:

- The PC checks each APK against `apps.json` before offering it. A damaged or missing one is
  not offered; Manage → System lists it under Devices ("Repair the installation").
- The device asks the PC for its own app's build (`GET /api/v1/devices/current/app-build`) when
  it connects, when the server refuses it, and every 30 minutes. It offers a build newer than
  itself whose client API its server speaks.
- It downloads the APK from the PC with its device token, over the pinned LAN certificate, and
  keeps it only if its size and SHA-256 are the PC's and Android reads it as the same app at the
  expected version. Then Android's `PackageInstaller` installs it.
- These routes, and renewing the device token, stay open to an app the server no longer serves
  (N-1), so a refused app can still update itself.
- A phone needs "Install unknown apps" allowed for the app once; the app sends the person to that
  setting. A tablet that is device owner needs nothing; one that is not shows the offer in the
  staff panel, after a manager's PIN.

## Support

- **A phone or tablet says "Update this app"**: its server no longer serves the app. If an
  over-the-air update the server serves is published, the screen says it is on its way, and the
  app restarts on it within a minute or two. If the PC has a newer APK, the screen offers to
  install it (a kiosk tablet installs it by itself). Otherwise install the release's APK by MDM.
- **A new APK is not offered:** Manage → System, Devices: is the version listed for this PC, and
  is it OK? Is the app on the phone already that version (Manage → Devices)? A damaged APK needs
  the installer's repair.
- **Android refuses the APK** ("Android did not install the new version"): the APK was signed
  with another key than the installed app, or the phone lacks space. The error reaches the
  vendor's error service with Android's message.
- **An update does not arrive:**
  - Is it on the device's channel, for its app version?
  - Does the device reach the internet? Updates come from `u.expo.dev`; the restaurant works
    without the internet, it just does not update.
  - Does its server speak the update's client API (Manage → System, "App connection version")?
    An update for a newer API waits for the PC's update.
  - Is somebody signed in on the phone, or are guests at the tablet's table? It waits until they
    are not.
- **Errors**: failed checks and downloads (a refused signature among them) reach the vendor's
  error service, tagged with the app (P7-08d).
