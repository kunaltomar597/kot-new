# @rp/mobile-native

The Android pieces shared by the waiter app and the table tablet (P2-01c):

- `RpDeviceKeyModule.kt`, a local Expo module (autolinked through `expo-module.config.json`): the
  device key is an ECDSA P-256 key created inside the Android Keystore (StrongBox when the phone
  has it) and never leaves it (AUTH-007, SEC-006, SEC-010). JavaScript sees only the public key
  and signatures.
- `KeystoreDeviceKeys`: that key as `@rp/api-client`'s `DeviceKey`. Android signs in DER; the
  server verifies raw `r‖s` (as WebCrypto gives), so `derToRawEcdsa` converts.
- `secureStore()`: `expo-secure-store` (values encrypted with a Keystore key) for credentials.
- `plainStore()`: AsyncStorage for the outbox, the menu cache and the server address.
- `installRandomValues()`: gives Hermes the `crypto.getRandomValues` that `@rp/api-client` builds
  correlation ids and idempotency keys from (ORD-013), from `expo-crypto` (Android
  `SecureRandom`). Each app calls it before creating the device session (P2-02b).

Tests run with Vitest and fake native modules; the Kotlin module is compiled by the Android CI job.
