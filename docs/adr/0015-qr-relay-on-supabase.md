# ADR-0015: QR relay on Supabase: a private schema, role-scoped RLS, writes only through functions

Status: Accepted
Date: 2026-10-02
Work package: P5-01, P5-02 (used by P5-03 to P5-06, P7)
Requirements: SEC-005, QR-001, QR-006, QR-007, QR-008, QR-014, VCP-002, NFR-A01, BRD §9.3, §12

## Context

The QR menu needs a cloud relay (component C8): diners' phones cannot reach the local server, and
the cloud must never connect into the restaurant (BRD §5.1). The BRD names Supabase in the Mumbai
region: Postgres with RLS, Edge Functions for all writes, Realtime and Storage (§13).

SEC-005 and QR-014 set the security bar:

- RLS on every table, deny by default.
- Local servers use per-tenant credentials, never the service-role key. (Edge functions use it
  for Storage only, to write menu photos; P5-03c.)
- Browsers never write tables directly (QR-006).
- An automated test proves that no QR code, token or credential of one restaurant can read or
  write another's menu or orders.

Retention comes from §9.3: QR orders are kept 7 days after import (expired ones 7 days); menu
photos while the item exists plus 90 days.

Supabase's own defaults are too open for this. Tables in `public` are reachable through the Data
API (PostgREST, GraphQL), with grants to `anon` and `authenticated`. Functions are executable by
`PUBLIC`.

The relay must also be testable without Supabase. The build machine and the `check` CI job have
PostgreSQL 16 but no Docker, so everything security-relevant must run on plain PostgreSQL.

## Decision

### A private schema

- All relay data lives in schema `relay`. It is not listed in the Data API schemas
  (`infra/supabase/config.toml`, `[api].schemas`); `public` stays empty.
- `USAGE` on `relay` goes only to the three relay roles below. Default privileges grant nothing.
- Every function has `EXECUTE` revoked from `PUBLIC`.

### Three roles, all `NOLOGIN`

| Role           | Who acts as it                                                        | How                                                                                                                       | May do                                                                                                 |
| -------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `relay_server` | A local server's Realtime subscription                                | `role` claim of a short-lived JWT the `server-session` edge function signs after checking the tenant's credential (P5-02) | `SELECT` its tenant's QR orders                                                                        |
| `relay_writer` | An edge function acting for a verified local server                   | `SET LOCAL ROLE` in the function's transaction                                                                            | Write its tenant's tables, snapshots, photos, presence, settings and order status                      |
| `relay_diner`  | An edge function acting for a browser, after the table token resolved | `SET LOCAL ROLE` in the function's transaction                                                                            | Read its tenant's latest menu, photos, presence and settings; insert and read orders for its own table |

- No role is granted to `authenticator`, so the Data API cannot switch to any of them. A JWT can
  only carry `relay_server`, and only Realtime honours it.
- Leaking a `relay_server` JWT exposes, for its lifetime, the order queue of one restaurant. It
  never gives write access.

### Claims carry the scope

The tenant (and, for a diner, the table) travels in `request.jwt.claims`, the setting PostgREST and
Realtime already use.

- Edge functions set it with `set_config(..., true)` in the same transaction as `SET LOCAL ROLE`.
- Every policy compares rows with `relay.claim_tenant()` and `relay.claim_table()`. An absent or
  malformed claim matches nothing.
- Every policy names its role (`TO relay_writer`, ...). Tables have RLS enabled, not forced: the
  schema's owner and its definer-rights functions (`resolve_table_token`, `rate_limit_wait`,
  `purge`) bypass it by design, and no relay role owns a table. (Corrected in P8-03b; this ADR
  said "enabled and forced" before, which no migration did.)

### Secrets are stored as hashes

- Table tokens: at least 128 random bits, made by the local server (P5-04).
- Tenant credentials: 256 random bits, made by the Control Plane (VCP-002).
- The relay stores `sha256` of each, never the value.
- Lookups go through `SECURITY DEFINER` functions with an empty `search_path`:
  `relay.resolve_table_token` and `relay.verify_credential`.
- Regenerating a table's code replaces its hash, so the old code stops resolving at once (QR-001).
- Suspending a tenant or revoking a credential takes effect on the next call.

### Provisioning (VCP-002)

These functions are `SECURITY DEFINER` and executable by no API role:

- `relay.provision_tenant`
- `relay.add_credential`
- `relay.revoke_credential`
- `relay.set_tenant_status`

The Control Plane calls them over a direct database connection as its own login,
`relay_control_plane`, which may take `relay_provisioner` and nothing else (manual task 20). The
edge functions' login, `relay_edge`, may take `relay_writer` and `relay_diner` only. (Corrected in
P8-03b4b, RELAY-E3: this ADR said a provisioning edge function would do it, and `relay_edge` could
take the provisioner's role too.)

### Order rules live in the table

- A trigger keeps what the diner submitted immutable.
- The same trigger allows only these status moves:
  - `SUBMITTED` to `RECEIVED` or `EXPIRED`
  - `RECEIVED` to `SENT_TO_KITCHEN` or `REJECTED`
  - `SENT_TO_KITCHEN` to itself (item statuses)
- An order past its pickup time can no longer be received (QR-007); the local server then rejects
  it as expired.
- The idempotency key is unique per tenant (ORD-013).

### Retention

`relay.purge(now)` deletes:

- orders 7 days after they were received or expired;
- every menu snapshot but the latest after 1 day;
- a photo's record a day after its files were swept (see Menu photos).

pg_cron runs it hourly where the extension exists (Supabase). The relay is a transient queue; the
local server stays the system of record (AUD-004 applies there).

### Settings travel with the tenant

`relay.tenant_settings` holds the QR settings the relay must enforce (`qr.*`, scope VENDOR). It
uses the same defaults and limits as the local registry. The local server writes it through the
sync agent (P5-03).

### Edge functions are Node-tested TypeScript, bundled for Deno (P5-02)

- Each function is a Fetch API handler (`Request` in, `Response` out) in `infra/supabase/src`,
  with its database behind a two-method interface (one transaction, parameterised queries).
- The functions share code with the rest of the platform instead of copying it:
  - `@rp/contracts/relay` holds the request and response schemas.
  - `@rp/ordering` `resolveOrderLine` is the local server's own line check.
- Vitest runs the handlers on Node, on node-postgres, logged in as `relay_edge`.
- esbuild bundles each entry into `dist/functions/<name>/index.js`. Only the Deno database driver
  (`npm:postgres`) stays an import. `config.toml` points Supabase at the bundles.
- A smoke test runs the real bundles under Deno where Deno is installed. That is how a
  driver-only difference was found: JSON parameters must be cast `::text::jsonb`.
- Diners' functions turn off the platform's JWT check (`verify_jwt = false`) and check the
  table token themselves. Responses are `no-store`, and CORS allows only the QR site's origins.
  The `server` function, which only PCs call, sends no CORS headers at all (RELAY-I5).
- Bodies are read with a cap, refused by their announced length before anything is read and as
  soon as more arrives: 512 KB for the diners' functions, 8 MB for `server` (2 MB for a photo).
  A call without a table code or a credential of the right form has nothing of its body read
  (RELAY-D3, P8-03b4b).
- Rate limits are counted in the database (`relay.rate_limit_wait`), under per-table and
  per-browser advisory locks, so a burst cannot slip past them. Orders the restaurant rejected no
  longer count against their table, only against their browser (RELAY-D1). Service requests have
  their own, `relay.service_request_wait`: 10 a table and 6 a browser in 10 minutes, under the
  same kind of locks (RELAY-D2). Both added in P8-03b4b.
- `relay.expire_orders` runs every minute. An overdue order reads EXPIRED at once in any case.

### The local server's side (P5-02b)

- One function, `server`, with routes: `session`, `presence`, `menu`, `tables`, `orders` and
  `orders/:id/status`.
- Every call carries the restaurant's credential (`Authorization: Bearer`). The function checks
  its hash and acts as `relay_writer` for that restaurant, so a credential never needs to be
  exchanged before a write.
- `session` signs an HS256 JWT for Realtime with the project's JWT secret (`RELAY_JWT_SECRET`, a
  function secret). It carries the role `relay_server` and the tenant, and lasts an hour. Without
  the secret, the answer is 503 and the sync agent polls `orders`.
- Presence carries the `qr.*` settings, so the relay enforces what the restaurant set without
  another call.
- Menus are versioned by the local server's outbox:
  - versions only grow, one publication per restaurant at a time;
  - the same version with the same document is a replay;
  - anything older is refused, with the latest version.
- Tables are sent as the full list. A new hash replaces the old one; tables left out are taken
  out of service, never deleted.
- Transactions follow postgres.js's rule: a failed statement fails the transaction even when
  caught. Recovering needs `Tx.savepoint`, as when receiving an order too late marks it expired
  and keeps that. The Node test adapter enforces the same rule.

### The Realtime doorbell (P5-03d)

- `session` also returns the project's public API key (`SUPABASE_ANON_KEY`, or
  `RELAY_REALTIME_API_KEY` where only a publishable key exists) and the changes to listen for:
  INSERTs on `relay.qr_orders` and `relay.qr_service_requests`, filtered to the restaurant.
- The local server joins one channel on Realtime's socket, on the relay's own host
  (`/realtime/v1/websocket`), speaking the Phoenix protocol (1.0.0, JSON) over Node's WebSocket,
  without a Supabase client library. Realtime applies RLS by taking on the token's role, so
  `relay_server` is granted to `supabase_realtime_admin`.
- A change only rings: the server then picks up through `server/orders` and
  `server/service-requests` as before, so there is one trusted way in and nothing in the message
  is relied on.
- While the doorbell works, polling slows from 5 s to 60 s (a safety net). Heartbeats every 25 s;
  an unanswered one, a refused join, a closed channel or a dropped socket fall back to 5 s
  polling at once and join again with back-off. The token is renewed 5 minutes before it runs
  out, on the same channel.
- The tests use a stand-in for Realtime in `@rp/relay/testing`: the Phoenix socket, the token
  check, and changes from a trigger in the test database, delivered after commit to the
  restaurant's own subscribers. Manual task 20 checks the real one.

### Menu photos (P5-03c)

- The local server sends each QR dish's photo in its three WebP sizes (160, 480 and 960 px, made
  on upload, P1-04) through `server`: `PUT photos/:photoId/:width`. The function checks the
  credential, takes WebP files up to 2 MB only, and stores them in the public `menu-photos`
  bucket under `<tenant>/<photo>/<width>.webp`. The path is the relay's choice, so a restaurant
  can only ever write into its own folder (QR-014).
- Writing to Storage needs the service-role key. Supabase gives it to every edge function
  (`SUPABASE_SERVICE_ROLE_KEY`); the function uses it for Storage calls only, never for the
  database, which stays behind the roles above. Local servers never hold it (SEC-005).
- Photos never change (a new photo has a new id), so each is sent once and the CDN may keep it a
  year. Only photos the relay has are listed in the menu document; the QR page loads them from
  `photoBase`, which `qr-menu` returns. Without Storage (no key), uploads answer 503 `PHOTOS_OFF`
  and the menu goes without photos.
- `POST photos/sweep` gets the photos the menu uses now, when that changes and at least daily.
  The others are marked removed; 90 days later their files are deleted through the Storage API
  (Storage objects cannot be deleted from SQL) and `purged_at` is set. A photo used again within
  the 90 days is restored; after that the sweep lists it as missing and the local server sends it
  again.

### Tested on plain PostgreSQL, and on Supabase in CI

- The migrations use Supabase objects only when present: the `authenticator` and API roles, the
  `supabase_realtime` publication, pg_cron.
- Tests apply a prelude that creates Supabase's API roles as Supabase does. They then act as each
  role exactly as PostgREST and Realtime do: `SET LOCAL ROLE` plus `request.jwt.claims`.
- The `check` CI job runs these tests on PostgreSQL 16.
- The `relay-supabase` job runs the same suite against a local Supabase stack started by the CLI
  (`RELAY_DATABASE_URL`).

## Alternatives considered

- **Tables in `public` behind the Data API, with RLS for `anon` and `authenticated`.** This is the
  usual Supabase setup. But one wrong grant or policy exposes a table to every browser, and the BRD
  wants all writes through functions anyway.
- **Edge functions with the service-role key.** This is simple, but RLS no longer protects
  anything. A bug in a function could read across tenants, and SEC-005 asks for RLS everywhere.
- **Per-tenant Postgres login roles.** This is strong isolation, but one role per restaurant
  complicates provisioning, pooling and migrations. Claims-based RLS gives the same guarantee and
  is what Supabase's tooling expects.
- **Hashing tokens with bcrypt or argon2.** Not needed: the values are 128 or 256 random bits, so a
  fast hash cannot be brute-forced. A slow hash would also make every QR page load slower.

## Consequences

- Edge functions (P5-02) need a direct database connection (`SUPABASE_DB_URL`, through the
  transaction pooler). Each request is one transaction that sets the role and claims first.
- Realtime needs a signed JWT. `server/session` (P5-02b) signs it with the project's JWT secret,
  held as a function secret. If the project moves to asymmetric signing keys only, the signer
  changes to ES256 with an imported key; until then, local servers poll.
- The QR site never talks to the database. Everything it reads or writes goes through functions,
  which can also add caching and rate limits.
- Deploying the schema to the real Supabase project in Mumbai is a manual step
  (`manual-tasks/20-supabase-relay.md`).
