# @rp/mobile-native

The Android pieces shared by the waiter app and the table tablet (P2-01c):

- `RpDeviceKeyModule.kt`, a local Expo module (autolinked through `expo-module.config.json`): the
  device key is an ECDSA P-256 key created inside the Android Keystore (StrongBox when the phone
  has it) and never leaves it (AUTH-007, SEC-006, SEC-010). JavaScript sees only the public key
  and signatures.
- `KeystoreDeviceKeys`: that key as `@rp/api-client`'s `DeviceKey`. Android signs in DER; the
  server verifies raw `r‖s` (as WebCrypto gives), so `derToRawEcdsa` converts.
- `LanTrust.kt` with `RpLanTrustModule.kt` and `RpLanTrustPackage.kt` (P2-01d, ADR-0011, SEC-010):
  the restaurant's LAN CA pinned at pairing. `RpLanTrustPackage` installs it as the application
  starts, before React Native's first request: Expo's `fetch` and images take their OkHttp client
  from `OkHttpClientProvider`'s factory, XHR and WebSocket (Socket.io) apply the custom client
  builders, and all of them check TLS with one trust manager. For the paired server's host only
  the pinned CA is trusted (a user-installed or public CA cannot stand in); other hosts keep the
  phone's trust store, which development tools need. The pin lives in the app's private
  preferences; a pin that cannot be read trusts nothing for that host. `fetchAuthority` downloads
  `GET /api/v1/tls/ca` with a client that checks no certificate, because nothing is trusted yet:
  it never carries credentials, and the CA it returns is pinned only once its fingerprint,
  computed on the device, matches the QR code or a person has compared it.
- `AndroidServerTrust`: that module as `@rp/mobile-core`'s `ServerTrust`.
- `secureStore()`: `expo-secure-store` (values encrypted with a Keystore key) for credentials.
- `plainStore()`: AsyncStorage for the outbox, the menu cache and the server address.
- `installRandomValues()`: gives Hermes the `crypto.getRandomValues` that `@rp/api-client` builds
  correlation ids and idempotency keys from (ORD-013), from `expo-crypto` (Android
  `SecureRandom`). Each app calls it before creating the device session (P2-02b).

Tests run with Vitest and fake native modules; the Kotlin module is compiled by the Android CI job.
