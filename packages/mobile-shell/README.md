# @rp/mobile-shell

Screens and hooks shared by the waiter app and the table tablet (P2-01c), on top of
`@rp/mobile-core`'s `DeviceSession`:

- `ShellProvider`: the device session, the i18n catalogue (NFR-L02) and the `@rp/ui-native` theme.
- `PairingScreen` (AUTH-007, P2-01d): scanning the manager's QR code (`QrScanner`, `expo-camera`,
  loaded only when a person taps Scan) gives the code, the server's addresses and its CA
  fingerprint, so the device finds the server and pins its CA without anything typed. A QR code
  without addresses fills in the code and asks for the address, still checked against its
  fingerprint. With a typed address over TLS, the screen shows the server's certificate
  fingerprint (`formatFingerprint`) for a person to compare with the server PC's before pairing.
  `expo-camera` is a peer dependency: each app installs it.
- `LoginScreen`: staff tiles, optionally limited to some roles, and the PIN pad (AUTH-001).
- `ConnectionBanner`, `Screen` (with a footer that stays put, e.g. Send KOT), `Note`.
- `AlertBanner`, on every `Screen` (P2-06a, WTR-006): the newest open alert of the person the
  phone alerts ("Table 5 · Food ready", with `@rp/ordering` `describeAlert`), how many more, and
  Acknowledge in one tap (NFR-U03); a tap on it lists every open alert with its age, reminders and
  escalation. It shows on the sign-in screen too, naming whose alerts they are, since the phone
  goes on alerting after an inactivity sign-out. `useAlerts` gives the same state to any screen.
  Nothing shows on a device that follows no alerts (the table tablet).
- `useLive`: data read again after the events that change it and after a reconnect.
- `useMenu` and `useUnsentOrders`: the menu and the unsent orders the device keeps, at once and
  live (MENU-013, WTR-012, P2-02b).
- `useOverride`: a manager's approval on the device (AUTH-011, WTR-009, P2-02c). An action is
  tried as the signed-in person; when the server answers `OVERRIDE_REQUIRED`, a manager or the
  owner picks their name and enters their PIN in a sheet, and the action goes again with the
  single-use approval. The twin of the console's `useOverride`.

Tested with Jest and React Native Testing Library against `@rp/mobile-core/testing`'s fake server.
