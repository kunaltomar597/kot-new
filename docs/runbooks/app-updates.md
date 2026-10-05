# Phone and tablet updates

How the waiter app and the table tablet get new versions (UPD-001, UPD-007, P7-04e1,
ADR-0017). It covers publishing an over-the-air update, what each device does with it, and
support. New APKs (native changes) come through MDM, or through the in-app updater from the
restaurant PC (P7-04e2).

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

## Support

- **A phone or tablet says "Update this app"**: its server no longer serves the app. If an
  over-the-air update the server serves is published, the screen says it is on its way, and the
  app restarts on it within a minute or two. Otherwise install the newer APK (MDM, the in-app
  updater from P7-04e2, or the release's APK).
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
