# @rp/mobile-core

Shared core of the waiter app and the table tablet (P2-01a), free of React Native so it is tested
here with Vitest:

- `KeyValueStore`: the storage interface; the apps pass the Keystore-backed secure store and
  AsyncStorage (P2-01c).
- `createMobileClient`: an `ApiClient` whose credentials are restored from, and written back to,
  the secure store on every change (AUTH-007, SEC-010).
- `PersistentOutbox`: unsent submissions kept with their idempotency key until the server has them;
  refused ones stay until a person dismisses them (WTR-012, ORD-013).
- `MenuCache`: the published menu on the device, refreshed on a newer version or reconnect, with
  availability changes applied (MENU-006, MENU-013).
