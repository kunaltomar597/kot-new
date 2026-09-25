# @rp/api-client

The typed client of the local server, used by the console, desktop, waiter app, table tablet and QR
site. Built by P0-14a. Works wherever `fetch` exists (browsers, Electron, Node, React Native).

```ts
import { ApiClient, generateWebCryptoDeviceKey } from '@rp/api-client';

const client = new ApiClient({
  baseUrl: 'https://pos.local:8443',
  credentials: stored, // from secure storage, if the device was paired before
  signer: deviceKey, // the device key: renews device tokens
  onCredentialsChange: persist, // tokens rotate: save them
  onSessionEnded: showPinScreen, // inactivity, expiry, revoked elsewhere
  onDeviceRevoked: showPairingScreen, // unpaired by a manager
});

const { key, keyPair } = await generateWebCryptoDeviceKey(); // keep keyPair in IndexedDB
await client.pair({ code: 'ABCD-EFGH', key });
await client.signInWithPin({ staffId, pin });
const { devices } = await client.api.listDevices(); // one method per contract operationId
```

- REST (`src/client.ts`): typed from the `@rp/contracts` route registry; the request is checked
  before it is sent and the answer after it arrives. Sends the device token (renewed with the device
  key a minute before it expires) and the access token (refreshed 30 s before expiry, or once after
  `TOKEN_EXPIRED`, single flight), a correlation id, and an override token when given. Expiry uses
  the server clock from the `Date` header.
- Errors: `ApiRequestError` (the server said no: `status`, `code`, plain-language `message`),
  `ApiUnavailableError` (offline or timeout, 10 s by default) and `ApiContractError` (a bug or a
  version mismatch).
- Idempotency (ORD-013): `newIdempotencyKey()` when the person commits an action; keep it with the
  draft and resend the same key on every retry.
- Live updates (`src/realtime.ts`, P0-12 protocol): `client.connectRealtime({ onEvent, onSync,
onStatus, onEnded, onResumePoint, resume })`. Events arrive once each (de-duplicated by id); keep
  the resume point to resume after a restart; reload over REST when `onSync` says `fullRefresh`.
  It reconnects by itself (at most 5 s apart), refreshes credentials when a handshake is refused,
  reconnects without the person when their session ends and stops when the device is unpaired.
- Device keys: `generateWebCryptoDeviceKey()` makes a non-extractable ECDSA P-256 key. Browsers
  offer WebCrypto only on https:// or localhost (`DeviceKeyUnavailableError` otherwise); React
  Native apps implement `DeviceKey` with the Android Keystore (P2-01).
- Tests: unit tests with a fake server and a fake socket; `apps/server/test/integration/
api-client.int.test.ts` runs the client against the real server.
