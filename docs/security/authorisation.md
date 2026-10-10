# Authorisation: who may call what

SEC-003, SEC-017 (automated authorisation tests), AUTH-005, AUTH-007 to AUTH-011, SEC-005,
SEC-012, SEC-018. OWASP ASVS V4 (access control) and OWASP API Security Top 10 API1 (object level),
API2 (authentication) and API5 (function level). Written in P8-03a; keep it current when a surface
changes.

The rule on every surface: **deny by default, decided by the server**. Hiding a button in an app is
never the control (AUTH-010). Every endpoint, socket, MQTT topic and relay table names who may use
it, and the tests below call each one the way an attacker would on every build.

## The local server's API

### Four kinds of access

Every endpoint of the restaurant PC is in the route registry (`packages/contracts/src/routes.ts`)
with its `capability`, and its controller declares the same with a decorator
(`apps/server/src/auth/decorators.ts`). The test "route registry matches the controllers"
(`auth-guard.int.test.ts`) fails when the two differ, so the registry and the generated
`docs/api/openapi.json` (`x-capability`, `x-devices`) always say what the server enforces.

| Access       | Who may call                                                                           | Decorator                 |
| ------------ | -------------------------------------------------------------------------------------- | ------------------------- |
| `PUBLIC`     | Anyone. 11 endpoints, each saying why in its description (listed below).               | `@Public()`               |
| `DEVICE`     | A paired device of the kinds the route names (`devices`), nobody signed in.            | `@RequireDevice(devices)` |
| `SESSION`    | Anyone signed in; the service checks anything further (for example Owner only).        | `@RequireSession()`       |
| a capability | Someone signed in whose role the BRD §4.2 matrix (`@rp/domain` permissions) grants it. | `@RequireCapability(c)`   |

A controller method without a decorator is refused and logged as a bug.

### How a request is judged

`AuthenticationMiddleware` works out who is calling before any route runs: the device from its
device token (checked against the device row on every request, so unpairing takes effect at once,
AUTH-008), and the person from the access token, which is bound to its session and to the device it
was issued on (AUTH-005). It never refuses anything itself. The global `PermissionGuard` then
decides, before validation and before any work, and refuses with:

| What is wrong                                                    | Answer                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------- |
| No device credential, or a forged, expired or unpaired device's  | 401 `DEVICE_NOT_RECOGNISED`                                   |
| A kind of device the endpoint does not serve                     | 403 `DEVICE_NOT_ALLOWED`                                      |
| Nobody signed in                                                 | 401 `UNAUTHENTICATED`                                         |
| A person's token presented from another device                   | 401 `DEVICE_MISMATCH`                                         |
| A session that was signed out, revoked, expired or idle too long | 401 `SESSION_REVOKED` / `SESSION_EXPIRED`                     |
| A session on a device staff do not sign in on                    | 403 `DEVICE_NOT_ALLOWED`                                      |
| The role is denied the capability                                | 403 `FORBIDDEN`                                               |
| The capability needs a manager's PIN (§4.2 "PIN")                | 403 `OVERRIDE_REQUIRED`, or `OVERRIDE_INVALID` for a used one |
| An Owner-only action without a fresh password + TOTP (AUTH-006)  | 403 `SECOND_FACTOR_REQUIRED`                                  |

A manager's override is single-use, for one capability, bound to the requester's session and valid
2 minutes (AUTH-011). An override for an action about a record (a voided item, a reopened or voided
invoice, a discount above the limit: `OVERRIDE_RECORD_TYPES`) names its record when it is given
and works on that record only; on another it is refused and not spent (P8-03b2a, PC-T2). When the
matrix says OWN (a waiter's own tables, a cashier's own shift), the
guard lets the request through marked `ownershipRequired` and the service checks the object; see
"Object-level checks".

### Devices

| Device                 | Over HTTPS and the socket | Staff sign in on it  | Acts for                                       |
| ---------------------- | ------------------------- | -------------------- | ---------------------------------------------- |
| POS, manager's browser | yes                       | yes                  | the signed-in person                           |
| Kitchen screen (KDS)   | yes                       | yes, or station mode | the person, or its stations (AUTH-005)         |
| Waiter phone           | yes                       | yes                  | the person; its holder's alerts when nobody is |
| Table tablet           | yes                       | **no**               | its own table only (AUTH-009)                  |
| Pager                  | **no** (MQTT only)        | no                   | its wearer's alerts                            |

`HTTP_DEVICE_TYPES` and `STAFF_DEVICE_TYPES` in `@rp/contracts` hold these lists. A table tablet is
in diners' hands: staff confirm things there with their PIN for that one action (leaving the kiosk,
approving a diner's order at the table), never with a session. Wrong PINs there count against
the tablet, which stops taking them for a while, never against the person (P8-03b2a, MOBILE-D1). Sign-in endpoints refuse tablets and
pagers, and a session on one counts for nothing even if it existed. No pairing code is made for a
pager (`PairableDeviceType`): pagers are registered on the Pagers page with their own MQTT
credential and never hold a device key.

Station mode: when kitchen staff do not sign in individually (`auth.kitchenIndividualLogins` off),
a kitchen screen with nobody signed in may call the endpoints marked `stationMode` whose capability
the KITCHEN role is granted (its tickets and their steps, recall, "notify manager"), for its own
stations only.

### Endpoints open to anyone

Reviewed; widening this list is a security decision, and the sweep test fails until its list is
changed too. The device token is checked before any request body is read: a caller without a paired
device may send at most 16 KB, which every public endpoint needs a few hundred bytes of; only
paired devices may send more (1 MB, and photos, menu files and AI imports on their own paths;
PC-D1, `apps/server/src/http/body-limits.ts`).

| Endpoint                                         | Why it is public                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `GET /health`, `GET /version`                    | The watchdog, support and devices before sign-in; no business data.                                |
| `GET /first-run`, `POST /first-run`              | Nothing to sign in with yet; the POST only from the PC itself and only while no restaurant exists. |
| `GET /tls/ca`                                    | A device needs the CA to pin before pairing (ADR-0011).                                            |
| `POST /devices/pairing-codes/bootstrap`          | The installer pairs the PC's own POS: loopback only, only while no device is paired.               |
| `POST /devices/pair`                             | The one-time code (10 minutes) is the credential; rate-limited (SEC-009).                          |
| `POST /devices/challenge`, `POST /devices/token` | Device authentication: a signature over a fresh challenge with the paired key.                     |
| `GET /photos/:id/:width`                         | Menu photos in `<img>` tags; they are shown to diners anyway.                                      |
| `GET /pager-firmware/:token`                     | A 15-minute token sent to one pager on its own MQTT topic; the image is signed (secure boot).      |

### Object-level checks

The guard decides who may use an endpoint; the services decide which records (OWASP API1). Each has
its tests:

| Check                                                                  | Tests                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A tablet reads and acts on its own table only (AUTH-009)               | `devices.int` "can only act on their own table", `order-approvals.int` "keeps each tablet to its own table", `service-requests.int` "lets a tablet act only for its own table", `recommendations.int` "for its own table only" |
| A waiter approves, moves, merges and cancels on their own tables       | `order-approvals.int`, `table-sessions.int` "lets a waiter move only their own tables", `table-merge.int`, `order-items.int`                                                                                                   |
| A cashier's cash and shift close on their own shift; own reports       | `payments.int` "the cashier on their own shift only", `reports.int` "a cashier sees only their own", "export their own shift report and nothing else"                                                                          |
| Alerts are acknowledged only by those they are for                     | `notifications.int` "does not let someone else acknowledge an alert that is not theirs"                                                                                                                                        |
| Staff changes: nobody changes their own role; managers are the Owner's | `staff.int`                                                                                                                                                                                                                    |

## Real-time connections (Socket.io)

The handshake needs a device token, and a person's token if one is sent must be valid and from that
device; pagers are refused (`realtime.gateway.ts`). Rooms are given by the server from the device
and the person (`realtime/rooms.ts`): a tablet hears only its table, a kitchen screen its stations,
a person their role, own and section rooms. Clients send one message, `resync`, which is
rate-limited. Unpairing, signing out, a changed role or a moved tablet end the connection within 5
seconds (AUTH-008). Tests: `realtime.int` "who may connect", "events reach exactly the rooms allowed
to see them", "live connections end when their credentials do"; `realtime-rooms` unit tests.

## Pagers (MQTT)

Each pager signs in to the PC's broker (MQTTS) with its own credential (peppered Argon2id), and the
ACL lets it subscribe to `rp/<restaurant>/pagers/<itself>/alerts` and `/ota` and publish to its own
`/ack` and `/heartbeat` only (PGR-005, SEC-012). Tests: `pagers.int` "refuses a wrong password and
another pager's topics", "ignores a pager publishing where it may not"; `pager-firmware.int` "keeps a
pager to its own firmware offers".

A pager's button acknowledges only alerts sent to that pager, as its wearer, whoever wears it: a
manager's pager has no manager's reach (P8-03b2b, PAGER-T1); the pager is recorded with the
acknowledgement. Before sign-in the broker limits connections per address, the time to sign in,
packet sizes and Argon2id checks at once; after it, retained, QoS 2 and over-large messages end the
connection. Tests: `pagers.int` "acknowledges only alerts sent to it, also when a manager wears
it"; `pager-broker-limits.int`.

## The QR relay (Supabase)

Browsers never touch the database (QR-006): the diners' edge functions take a table's QR token and
the browser's id, and the local server's function its own credential. Every relay table has
Row-Level Security, deny by default, for three relay roles, none of which the Data API can use
(SEC-005, ADR-0015). Tests: `infra/supabase/test/roles.test.ts`, `isolation.test.ts` (cross-tenant
isolation, tokens), `diner-functions.test.ts` "opens nothing without a valid token".

## The Vendor Control Plane

Three kinds of caller (ADR-0012): `PUBLIC` (7 endpoints that say why, plus the development object
store's 2 signed-URL endpoints, which answer 404 in staging and production), `INSTALLATION` (a
request signed with an enrolled restaurant PC's Ed25519 key, within the time window, with a fresh
nonce), and vendor staff with a session (password and authenticator, VCP-001) whose role allows the
endpoint's capability (`vendorMay`, SEC-018). Restaurant PCs and vendor staff cannot use each other's
endpoints. Tests: `signed-requests.int`, `vendor-staff.int` "lets each role do only what it is
for", and the sweep below.

Object level (SEC-005, ADR-0021): a PC's installation and restaurant come from the row behind its
signature, and every PC endpoint looks its objects up within them; the tables have no Row-Level
Security. `tenant-isolation.int` calls each of the 12 PC endpoints with another restaurant's ids
and fails for a PC endpoint it has no case for.

## The desktop shell

The Electron shell loads only the PC's own console, with context isolation, the sandbox, no
Node.js, no preload and no IPC, so the console has no more power on the PC than in a browser
(SEC-011, `apps/desktop/test/security.test.ts`).

## The sweeps (SEC-017)

Two tests call every endpoint in the registries the way an attacker would and expect the exact
refusal, before any work is done. They run on every build; a new endpoint is swept as soon as it is
registered.

`apps/server/test/integration/authorisation-sweep.int.test.ts`, over all ~250 endpoints of the
restaurant PC (about 3,500 calls, a few seconds):

- only the reviewed endpoints are public;
- no device, an unpaired device (also with the token of someone who was signed in on it);
- every kind of device on each device endpoint it does not serve, pagers included;
- every kind of device with nobody signed in, on every endpoint that needs a person;
- a person's token from another device; a signed-out session;
- each role on each capability §4.2 does not give it (FORBIDDEN, OVERRIDE_REQUIRED, and the
  Owner's second factor);
- a kitchen screen in station mode outside its station's endpoints;
- sign-in on a table tablet or a pager, and a session on a tablet however it was made.

`apps/control-plane/test/integration/authorisation-sweep.int.test.ts`, over the Control Plane's
endpoints: the routes match the registry with their access; no credential; a vendor session on a
PC's endpoint and a PC's signature on a vendor endpoint; a revoked PC; each vendor role without the
capability; a signed-out vendor session.

What an allowed caller may then do is each feature's own tests, including the object-level checks
above. The permission matrix itself is tested row by row in `auth-guard.int` ("every capability row
of the permission matrix").

## Changing who may call what

1. Add or change the route in the registry (`capability`, and `devices` for a device endpoint) and
   the controller's decorator; `pnpm contracts:docs`.
2. A new public endpoint says why in its description (the docs generator refuses one that does
   not) and goes into the sweep's list of public endpoints and the table above.
3. A new OWN capability or bound device needs its object-level test.
4. Mention it in the pull request as security-sensitive (decision 8 in `docs/build/PROGRESS.md`).
