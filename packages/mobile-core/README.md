# @rp/mobile-core

Shared core of the waiter app and the table tablet (P2-01a), free of React Native so it is tested
here with Vitest:

- `KeyValueStore`: the storage interface; the apps pass the Keystore-backed secure store and
  AsyncStorage (P2-01c).
- `createMobileClient`: an `ApiClient` whose credentials are restored from, and written back to,
  the secure store on every change (AUTH-007, SEC-010).
- `PersistentOutbox`: unsent submissions kept with their idempotency key until the server has them;
  refused ones stay until a person dismisses them (WTR-012, ORD-013).
- `findServer` and `ServerTrust` (P2-01d, ADR-0011, SEC-010): the addresses from the pairing QR
  code (or the one typed) are tried at once and the first server to answer wins. Over TLS its CA
  is downloaded through `ServerTrust` (the Android module) and must match the QR code's
  fingerprint, so a stranger on another address cannot stand in for the server; a typed address
  comes back unverified, for a person to compare the fingerprint first. When the QR code names a
  CA, plain-HTTP addresses are not tried.
- `DeviceSession`: pairing with a Keystore key, PIN sign-in and out, the live connection with a
  stored resume point, and forgetting the device when the server unpairs it (P2-01c). Over TLS,
  `pair` pins the server's CA before the code is sent and refuses a CA nobody checked; unpairing
  forgets the pin (P2-01d). It owns the
  device's menu cache and order outbox: the menu is fetched on reconnect and when a newer one is
  published, availability changes apply live, and unsent orders go when the connection is back
  (P2-02b).
- `MenuCache`: the published menu on the device, refreshed on a newer version or reconnect, with
  availability changes applied (MENU-006, MENU-013).
- `AlertCenter` (P2-06a, WTR-006): on a waiter phone (`followAlerts`), the open alerts of the
  person the phone alerts, its holder: whoever last signed in on it, kept after an inactivity
  sign-out so the phone goes on alerting like a pager (AUTH-005). They are read through the
  device's own endpoint when the connection comes up or back (NTF-006) and after an alert event for
  the holder; each alert and each repeat is announced once to the `AlertNotifier` (the Android
  notifications of P2-06b), and acknowledging acknowledges everywhere, the pager included
  (NTF-004). Unpairing or pairing again forgets them.
- `OrderOutbox`: orders from this device on their way to the kitchen (WTR-012, ORD-013). Each is
  kept before it is sent and sent again with the same idempotency key until the server answers;
  orders go only while the person who took them is signed in; a refused order stays with the
  server's reasons until it is taken back to change or discarded. Tested against the real server
  in `apps/server/test/integration/order-outbox.int.test.ts`.

`@rp/mobile-core/testing` holds the test doubles (a fake local server behind `fetch`, a fake
Socket.io client, a fake Keystore, a fake trust module with sample CAs, a fake alert notifier and
sample alerts) used by this package, `@rp/mobile-shell` and the apps.
