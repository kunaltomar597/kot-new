# Threat model: The QR relay and site

Diners scan a table's QR code, open the public QR menu site (`apps/qr-menu`) and order; the site
calls the relay's edge functions on Supabase (`infra/supabase`), and the restaurant PC's sync agent
(`apps/server/src/relay`) picks the orders up for a waiter to approve. Written in P8-03b
(2026-10-10). Related: [ADR-0015](../../adr/0015-qr-relay-on-supabase.md),
[authorisation.md](../authorisation.md) "The QR relay".

## Scope

- The QR site: its pages, the cart in the browser, its headers.
- The relay's functions for diners (`qr-menu`, `submit-order`, `order-status`, `service-request`)
  and for restaurant PCs (`server`), the Realtime doorbell and the photo bucket.
- The relay's schema: three roles, Row-Level Security, hashed table tokens and credentials, the
  order rules as triggers, rate limits, idempotency, retention.
- The PC's side: publishing the menu and tables, picking up orders, approval, statuses back, the
  sealed credential; giving a table a new QR code and printing table tents.

## Assets

- Each table's QR token: the right to order for that table.
- Each restaurant's relay credential (256 bits), the short-lived Realtime token it gets, and the
  relay's own secrets: the database login of the functions, the service-role key, the JWT secret.
- Orders as diners sent them, and the rule that a waiter approves every one before the kitchen.
- Diners' data: an optional name, notes, a random browser id.
- Other restaurants' data in the same relay.
- The menu photos in the bucket.
- QR ordering working, the restaurant working without it, and the vendor's Supabase bill.

## Entry points

- `https://<site>/t/<token>`: the site's pages, rendered on the server.
- The diners' functions, which take the table's token in a header and no Supabase login.
- The `server` function, with the restaurant's credential.
- The Realtime socket and the bucket's public addresses.
- On the PC: `relay-cli credential` (the credential on standard input) and "New QR code" for a
  table.
- The printed table tents.

## Trust boundaries

1. The diner's phone ↔ the site's host ↔ the relay's functions.
2. The functions ↔ PostgreSQL: the functions' login switches to the diner's or the writer's role
   for one transaction, with the token's or the credential's scope in the claims.
3. Realtime ↔ Row-Level Security for the restaurant's token.
4. The restaurant PC ↔ the relay: HTTPS, outbound from the PC only.
5. What the relay hands over ↔ the PC, which checks and prices everything again.
6. The QR code on the table ↔ the diner who reads it.

## Data flows

1. The PC publishes the QR menu and the tables' token hashes by content hash, presence and the QR
   settings, and the photos; all through `server`.
2. The browser sends the token, its browser id and the lines to `submit-order`; the order is
   stored as SUBMITTED, and Realtime rings the PC.
3. The PC picks it up (RECEIVED), checks and prices it, and holds it for the table's waiter to
   approve; the status goes back, and the diner's page polls `order-status`.
4. Seven days after an order ended, the relay deletes it.

## Threats

### Spoofing

#### RELAY-S1 Guessing another table's token

Someone on the internet tries tokens against the functions to order for a table, or to read one.

- Mitigation: tokens are 128 random bits made on the PC; the relay stores only their SHA-256 and
  looks a token up only when it is long enough, for an active table of an active restaurant.
- Code: `apps/server/src/floor/table-qr.service.ts` (`newTableToken`);
  `packages/contracts/src/relay/schemas.ts` (`TableToken`);
  `infra/supabase/migrations/20261002130000_relay_schema.sql` (`resolve_table_token`).
- Tests: `infra/supabase/test/tokens.test.ts` "never looks up a token shorter than 128 bits, or
  none at all"; `infra/supabase/test/diner-functions.test.ts` "opens nothing without a valid
  token"; `apps/server/test/integration/table-qr.int.test.ts` "gives each table an unguessable code
  of its own, audited without it".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

#### RELAY-S2 A photographed QR code used from elsewhere

A diner photographs a table's code and orders for it after leaving, or from another table.

- Mitigation: every QR order waits for the waiter looking after the table to approve it, priced
  on the PC; a service request for a table that is not open is refused; a manager gives a table a
  new code, which stops the old one at once.
- Code: `packages/domain/src/machines/order-item.ts` (`initialOrderItemState`);
  `apps/server/src/floor/table-qr.service.ts` (`TableQrService.regenerate`);
  `apps/server/src/relay/relay-orders.service.ts` (`RelayOrdersService`).
- Tests: `apps/server/test/integration/relay-orders.int.test.ts` "waits for the waiter who looks
  after the table, priced here", "says a table that is not open cannot take a request, as at the
  tablet"; `apps/server/test/integration/table-qr.int.test.ts` "stops the printed code when the
  table gets a new one"; `infra/supabase/test/diner-functions.test.ts` "stops a regenerated code at
  once".
- Risk: likelihood Medium, impact Low: Low.
- Status: Accepted: codes do not change by themselves, and orders for a table that is not open
  still reach a waiter (QR-010); the approval is the control.

#### RELAY-S3 A stolen restaurant credential

Someone takes a restaurant's relay credential and acts as its PC: publishes a fake menu, takes
tables out of service, rejects orders or reads diners' names.

- Mitigation: the credential is 256 random bits, stored by the relay as a hash and by the PC
  sealed with its DPAPI key, entered through standard input only; the vendor revokes it or
  suspends the restaurant at once; it reaches only its own restaurant.
- Code: `infra/supabase/migrations/20261002130000_relay_schema.sql` (`verify_credential`,
  `revoke_credential`); `apps/server/src/relay/relay-credential.ts` (`saveRelayCredential`).
- Tests: `infra/supabase/test/server-functions.test.ts` "is needed for every call, and only a live
  one of an active restaurant works"; `infra/supabase/test/tokens.test.ts` "stops a revoked
  credential at once, and only that one"; `apps/server/test/integration/relay-sync.int.test.ts`
  "is kept sealed in the database, never as it is".
- Risk: likelihood Low, impact Medium: Low.
- Status: Partly mitigated. Plan: P8-03e by 2026-10-24: nothing watches how a credential is used;
  the incident plan says how to revoke one and issue the next.

#### RELAY-S4 A fake QR sticker

Someone sticks their own QR code over the restaurant's, pointing at a look-alike site that asks
for payment or details.

- Mitigation: the table tent prints the site's address as text; the real site never takes payment
  and says so in its terms.
- Code: `apps/server/src/floor/table-tents.ts` (`tableTentsPdf`).
- Tests: none, a sticker on a table is outside the software; the guidance is a procedure.
- Risk: likelihood Medium, impact Medium: Medium.
- Status: Not mitigated. Plan: P8-03e by 2026-10-24: guidance for restaurants in the incident
  plan's templates (tents that show tampering, staff who look at them, what to tell diners), with
  the site on the vendor's own recognisable domain (manual task 21).

#### RELAY-S5 Forging a relay role

Someone uses Supabase's public key or a forged token to act as a diner, a writer or a PC.

- Mitigation: the API roles have nothing on the relay's schema; only the `server` function signs
  Realtime tokens, short-lived and for its own restaurant.
- Code: `infra/supabase/src/jwt.ts` (`signHs256`);
  `infra/supabase/migrations/20261002130000_relay_schema.sql` (`relay_writer`, `relay_diner`).
- Tests: `infra/supabase/test/server-functions.test.ts` "signs a short-lived token for its own
  restaurant"; `infra/supabase/test/isolation.test.ts` "reads, writes and calls nothing".
- Risk: likelihood Low, impact High: Medium.
- Status: Mitigated.

### Tampering

#### RELAY-T1 Prices changed in the browser

A diner edits the request to pay less.

- Mitigation: the order request has no price fields and refuses unknown ones; the PC prices every
  line from its own menu (ORD-014).
- Code: `packages/contracts/src/relay/schemas.ts` (`QrSubmitOrderRequest`);
  `apps/server/src/orders/orders.service.ts` (`OrdersService.submit`).
- Tests: `infra/supabase/test/diner-functions.test.ts` "refuses prices or anything else the
  contract does not have"; `apps/server/test/integration/relay-orders.int.test.ts` "waits for the
  waiter who looks after the table, priced here".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

#### RELAY-T2 Another table, or lines the menu cannot serve

A diner sends another table's id, dishes that are not on the menu, or options that do not belong.

- Mitigation: the table comes only from the token; the relay and the PC both check every line
  against the latest menu and store nothing when one fails.
- Code: `infra/supabase/src/db.ts` (`actAsDiner`); `infra/supabase/src/diner.ts`.
- Tests: `infra/supabase/test/isolation.test.ts` "orders only for its own table";
  `infra/supabase/test/diner-functions.test.ts` "reports every line the latest menu cannot serve,
  and stores nothing"; `apps/server/test/integration/relay-orders.int.test.ts` "rejects lines the
  menu here can no longer serve, with the reason, and makes nothing".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

#### RELAY-T3 Changing a sent order or skipping its steps

A diner changes an order after sending it, or a PC skips "received".

- Mitigation: triggers fix what a diner may send and the order of statuses; nobody edits a
  submitted order.
- Code: `infra/supabase/migrations/20261002130000_relay_schema.sql` (`qr_order_rules`,
  `qr_order_submitted`); `infra/supabase/migrations/20261002210000_qr_service_requests.sql`
  (`qr_service_request_rules`).
- Tests: `infra/supabase/test/orders.test.ts` "cannot be submitted with a status or deadline of the
  diner", "cannot be edited by the local server", "never skips receiving";
  `infra/supabase/test/isolation.test.ts` "changes no order and deletes nothing".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

#### RELAY-T4 SQL injection into the relay

Text a diner sends (a note, a name) or a crafted claim changes a relay query.

- Mitigation: queries take bound values only; claims are checked as UUIDs; every definer-rights
  function runs with an empty `search_path`.
- Code: `infra/supabase/src/db.ts`; `infra/supabase/migrations/20261002130000_relay_schema.sql`
  (`claim_uuid`).
- Tests: `infra/supabase/test/isolation.test.ts` "a local server and a diner see no rows";
  `infra/supabase/test/roles.test.ts` "runs every definer-rights function with an empty
  search_path".
- Risk: likelihood Low, impact High: Medium.
- Status: Mitigated.

#### RELAY-T5 Script or printer commands in what diners type

A diner's note or name carries script for the site or the console, or control codes for the
kitchen printer.

- Mitigation: React escapes every text on the site and the console; kitchen tickets print only
  printable ASCII; the site's CSP allows its own scripts and the relay only, with `'unsafe-inline'`
  for Next.js's own.
- Code: `apps/server/src/printing/escpos.ts` (`toPrintable`); `apps/qr-menu/src/proxy.ts`
  (`contentSecurityPolicy`).
- Tests: `apps/server/test/unit/escpos.test.ts` "reduces text to printable ASCII so every printer
  prints it"; `apps/qr-menu/test/site.test.tsx` "allows this site and the relay only".
- Risk: likelihood Low, impact Medium: Low.
- Status: Partly mitigated. Plan: P8-03c by 2026-10-19: a CSP with nonces instead of
  `'unsafe-inline'`, checked by the DAST scan of the site.

#### RELAY-T6 Framing the QR site

A page frames the QR site to trick diners into taps (clickjacking).

- Mitigation: `frame-ancestors 'none'` and `X-Frame-Options: DENY`.
- Code: `apps/qr-menu/src/proxy.ts` (`contentSecurityPolicy`); `apps/qr-menu/next.config.ts`.
- Tests: `apps/qr-menu/test/site.test.tsx` "allows this site and the relay only".
- Risk: likelihood Low, impact Low: Low.
- Status: Mitigated.

#### RELAY-T7 Replayed or doubled orders

A retry, a double tap or a replay sends the same order twice.

- Mitigation: the key is unique per restaurant; a burst of the same submission is stored once, and
  a key used at another table is refused; the PC takes each relay order once.
- Code: `infra/supabase/migrations/20261002130000_relay_schema.sql` (`idempotency_key`).
- Tests: `infra/supabase/test/diner-functions.test.ts` "stores a burst of the same submission
  once", "refuses a key already used at another table";
  `apps/server/test/integration/relay-orders.int.test.ts` "takes an order once however often it is
  picked up"; `apps/server/test/integration/qr-exit.int.test.ts` "drains every queue once the
  internet is back, with nothing lost or doubled".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

#### RELAY-T8 Other files in the photo bucket

A PC's credential uploads something that is not a WebP photo to the public bucket.

- Mitigation: the function takes only files that are WebP by their bytes; the bucket, the photos
  table and the local Supabase configuration allow WebP only, and a bucket made before with JPEG
  and PNG is corrected by the migration (P8-03b4b).
- Code: `infra/supabase/src/server.ts` (`isWebp`); `infra/supabase/config.toml`;
  `infra/supabase/migrations/20261010180000_relay_threats.sql` (`photos_content_type_check`).
- Tests: `infra/supabase/test/roles.test.ts` "takes WebP only, in the table, the bucket and the
  local configuration alike"; `infra/supabase/test/server-functions.test.ts` "takes WebP files of
  the known sizes only, and not too large".
- Risk: likelihood Low, impact Low: Low.
- Status: Mitigated.

### Repudiation

#### RELAY-R1 A diner says "I did not order that"

A diner disputes a dish on the bill that was ordered from their table's code.

- Mitigation: diners are anonymous by design (SEC-019); the relay keeps the browser id, table and
  time for seven days, the PC keeps what the relay sent, and the waiter's approval at the table is
  audited.
- Code: `apps/server/src/orders/order-approvals.service.ts` (`OrderApprovalsService`).
- Tests: `apps/server/test/integration/order-approvals.int.test.ts` "sends it to the kitchen with
  the agreed changes, and clears the alert".
- Risk: likelihood Medium, impact Low: Low.
- Status: Accepted: the waiter confirms each QR order with the table before the kitchen sees it,
  which is the control the BRD asks for (QR-010).

#### RELAY-R2 Who gave a table a new code

A manager denies giving a table a new code, or printing the tents.

- Mitigation: both are audited, without the code itself.
- Code: `apps/server/src/floor/table-qr.service.ts` (`TableQrService`).
- Tests: `apps/server/test/integration/table-qr.int.test.ts` "gives each table an unguessable code
  of its own, audited without it".
- Risk: likelihood Low, impact Low: Low.
- Status: Mitigated.

### Information disclosure

#### RELAY-I1 One restaurant reading another's data

A restaurant's PC, or a diner at one restaurant, reads or changes another restaurant's menu,
tables or orders.

- Mitigation: every relay table has Row-Level Security (enabled, not forced; ADR-0015 was corrected
  in P8-03b) whose policies compare the restaurant and table in the claims; Realtime filters the
  same way.
- Code: `infra/supabase/migrations/20261002130000_relay_schema.sql` (`claim_tenant`,
  `claim_table`); `infra/supabase/migrations/20261002210000_qr_service_requests.sql`.
- Tests: `infra/supabase/test/isolation.test.ts` "cannot add rows for another restaurant", "sees
  only its own order and request queues in Realtime, and nothing else";
  `infra/supabase/test/diner-functions.test.ts` "shows nothing of another table or restaurant";
  `infra/supabase/test/server-functions.test.ts` "cannot touch another restaurant";
  `apps/server/test/integration/qr-exit.int.test.ts` "never sees, takes or changes this
  restaurant".
- Risk: likelihood Low, impact High: Medium.
- Status: Mitigated.

#### RELAY-I2 Other diners' orders, or the tokens' hashes

A diner reads the orders of other tables, or the hashes of the tables' tokens.

- Mitigation: a diner reads only their table's orders; diners' columns leave out the token hash
  and the browser id; order ids are random.
- Code: `infra/supabase/src/diner.ts` (`ORDER_COLUMNS`).
- Tests: `infra/supabase/test/isolation.test.ts` "never reads a table";
  `infra/supabase/test/service-requests.test.ts` "follows the request, and only at its own table".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

#### RELAY-I3 The relay's own secrets

Someone who reads one function's settings in Supabase gets the service-role key and the database
login that can act as any restaurant.

- Mitigation: tokens and credentials are stored only as hashes; the site and the PC hold no
  Supabase key. Supabase gives every function, the diners' included, the same secrets.
- Code: `infra/supabase/src/deno/serve.ts` (`storage`).
- Tests: `infra/supabase/test/isolation.test.ts` "never sees credentials, not even its own";
  `infra/supabase/test/tokens.test.ts` "stores only a hash of each token".
- Risk: likelihood Low, impact High: Medium.
- Status: Partly mitigated. Plan: manual task 20 by 2026-11-30: who may read the project's
  secrets, their rotation, and the audit of the Supabase organisation's members.

#### RELAY-I4 Diners' privacy

A diner's identity, location or orders end up kept or shared beyond what they agreed to (DPDP).

- Mitigation: only an optional name; a random browser id; no IP addresses in the relay's tables;
  no third parties; `no-referrer`; everything deleted seven days after the order ends. The hosts'
  own logs keep IP addresses and the table's code in the address.
- Code: `apps/qr-menu/src/site/storage.ts` (`browserId`);
  `infra/supabase/migrations/20261002130000_relay_schema.sql` (`purge`).
- Tests: `apps/qr-menu/test/site.test.tsx` "keeps one anonymous id for the rate limit";
  `apps/qr-menu/e2e/qr-menu.e2e.ts` "links the privacy notice and the terms, and sends no
  referrer"; `infra/supabase/test/retention.test.ts` "deletes orders 7 days after they were
  received or expired, and old menus".
- Risk: likelihood Medium, impact Low: Low.
- Status: Partly mitigated. Plan: manual task 21 by 2026-11-30: the site's and Supabase's log
  retention, and the legal review of the privacy notice.

#### RELAY-I5 Cross-origin answers from the PCs' function

The `server` function answers browsers from the QR site's origin, though only PCs call it.

- Mitigation: every call needs the restaurant's credential in a header, which no page has; the
  `server` function sends no CORS headers and takes no preflight, so no page can read its answers
  even with one (P8-03b4b).
- Code: `infra/supabase/src/http.ts` (`corsHeaders`, `RoutesOptions`); `infra/supabase/src/server.ts`
  (`server`).
- Tests: `infra/supabase/test/http.test.ts` "sends no CORS headers, even to the QR site, and takes
  no preflight", "still answers the QR site from the diners’ functions";
  `infra/supabase/test/server-functions.test.ts` "is needed for every call";
  `infra/supabase/test/deno-smoke.test.ts` "answers no browser from the PCs’ function".
- Risk: likelihood Low, impact Low: Low.
- Status: Mitigated.

### Denial of service

#### RELAY-D1 Flooding a table with orders

Someone holding a table's code sends junk orders, which use up the table's limit, so the real
diners there cannot order for ten minutes.

- Mitigation: orders are limited per table and per browser, under advisory locks so a burst does
  not slip through; orders the waiter rejected no longer count against the table, only against
  the browser that sent them, so junk blocks the real diners only until the waiter rejects it; a
  manager gives the table a new code, which stops the sender at once (the runbook says when)
  (P8-03b4b).
- Code: `infra/supabase/migrations/20261010180000_relay_threats.sql` (`rate_limit_wait`);
  `apps/server/src/floor/table-qr.service.ts` (`TableQrService.regenerate`);
  `docs/runbooks/qr-relay.md`.
- Tests: `infra/supabase/test/diner-functions.test.ts` "limits orders per table in the window,
  saying when to try again", "limits one browser across tables", "lets no burst slip past the
  limit", "stops counting orders the restaurant rejected against the table, not their browser",
  "stops a regenerated code at once".
- Risk: likelihood Medium, impact Low: Low.
- Status: Mitigated.

#### RELAY-D2 Flooding a table with service requests

Someone holding a table's code calls the waiter or asks for the bill again as soon as staff
close the last request.

- Mitigation: one open request of each kind per table; at most 10 requests in 10 minutes at a
  table, whichever browsers send them (those the restaurant rejected not counted), and 6 from one
  browser anywhere in the restaurant, counted under the table's and the browser's advisory locks
  as orders are (P8-03b4b); a new code for the table stops the sender.
- Code: `infra/supabase/src/service-request.ts`;
  `infra/supabase/migrations/20261010180000_relay_threats.sql` (`service_request_wait`).
- Tests: `infra/supabase/test/service-requests.test.ts` "raises one open request of each kind per
  table, whoever presses", "limits a table to 10 requests in 10 minutes, whoever sends them,
  rejected ones not counted", "limits one browser to 6 requests in 10 minutes across the
  restaurant’s tables", "lets no burst of presses slip past the limit".
- Risk: likelihood Medium, impact Low: Low.
- Status: Mitigated.

#### RELAY-D3 Large bodies before any check

Anyone sends 8 MB bodies to the functions; each is read whole before its size or the token is
checked.

- Mitigation: a body announced as larger than its function's cap is refused before any of it is
  read, and one sent in chunks is refused as soon as more than the cap has arrived; the diners'
  functions take 512 KB at most (the largest order a diner could send is well under it), the
  `server` function 8 MB, a photo 2 MB; a call without a table code or a credential of the right
  form has nothing of its body read. Bodies are read before the database transaction opens, so a
  slow sender holds no connection (P8-03b4b).
- Code: `infra/supabase/src/http.ts` (`readCapped`, `DINER_BODY_MAX_BYTES`, `MAX_BODY_BYTES`);
  `infra/supabase/src/diner.ts` (`tableTokenOf`); `infra/supabase/src/server.ts`
  (`credentialOf`).
- Tests: `infra/supabase/test/http.test.ts` "refuses a body by its announced length before reading
  any of it", "stops reading a body sent without a length as soon as it passes the cap", "reads no
  body of a diner’s call without a table code, or a PC’s without a credential", "fits the largest
  order a diner could send under the diners’ cap"; `infra/supabase/test/deno-smoke.test.ts`
  "refuses a large body, announced or sent in chunks".
- Risk: likelihood Medium, impact Low: Low.
- Status: Mitigated.

#### RELAY-D4 Unthrottled reads and their cost

Anyone with a table's code reads the menu and order status as fast as they can, and every page
view of the site fetches the menu again, which costs the vendor and slows the relay.

- Mitigation: the menu is read only when it changed for a browser that has the latest; nothing
  limits the reads.
- Code: `infra/supabase/config.toml`; `apps/qr-menu/src/site/relay.ts`.
- Tests: none, throttling belongs to the edge in front of the functions and the site.
- Risk: likelihood Medium, impact Medium: Medium.
- Status: Not mitigated. Plan: P8-03c by 2026-10-19: rate limits at the edge (the site's host and
  Supabase), checked by the DAST run.

#### RELAY-D5 The relay or the internet down

The internet line drops or Supabase is down during service.

- Mitigation: nothing in the restaurant depends on the relay (NFR-A01): the PC works, its calls to
  the relay retry and fall back to polling, and the site shows the menu read-only.
- Code: `apps/server/src/relay/relay-realtime.ts` (`RelayRealtime`).
- Tests: `apps/server/test/integration/qr-exit.int.test.ts` "keeps everything in the restaurant
  working while the relay is out of reach"; `apps/server/test/integration/relay-realtime.int.test.ts`
  "falls back to polling when the line drops, and joins again"; `apps/qr-menu/e2e/qr-menu.e2e.ts`
  "the menu stays readable and ordering pauses, with a banner";
  `infra/supabase/test/diner-functions.test.ts` "closes ordering while the restaurant is offline".
- Risk: likelihood Medium, impact Low: Low.
- Status: Mitigated.

### Elevation of privilege

#### RELAY-E1 A browser reaching the database

A diner's browser uses Supabase's Data API to read or write the relay's tables directly
(QR-006).

- Mitigation: the relay's schema is not exposed through the Data API, and its API roles have no
  rights on it.
- Code: `infra/supabase/config.toml`; `infra/supabase/migrations/20261002130000_relay_schema.sql`.
- Tests: `infra/supabase/test/roles.test.ts` "keeps the relay schema out of the Data API", "grants
  nothing on the schema, its tables or its functions to an API role";
  `infra/supabase/test/isolation.test.ts` "reads, writes and calls nothing".
- Risk: likelihood Low, impact High: Medium.
- Status: Mitigated.

#### RELAY-E2 A QR order reaching the kitchen without a waiter

A diner's order goes straight to the kitchen, or is held to fire later.

- Mitigation: a customer's line starts waiting for approval; customer sources cannot hold lines.
- Code: `packages/domain/src/machines/order-item.ts` (`initialOrderItemState`);
  `apps/server/src/orders/orders.service.ts` (`HOLD_NOT_ALLOWED`).
- Tests: `apps/server/test/integration/relay-orders.int.test.ts` "waits for the waiter who looks
  after the table, priced here", "approving opens the table".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

#### RELAY-E3 The functions' login can provision restaurants

The login the edge functions use also holds the provisioning role, so a flaw in a diner's function
could create or change restaurants and credentials.

- Mitigation: the functions switch to the diner's or the writer's role for each transaction, and
  their login can no longer take the provisioning role; the Control Plane has its own login,
  `relay_control_plane`, which can take that role and nothing else (P8-03b4b). Manual task 20
  gives it a password and checks that `relay_edge` is no provisioner.
- Code: `infra/supabase/migrations/20261010180000_relay_threats.sql` (`relay_control_plane`);
  `apps/control-plane/src/support/relay-provisioner.ts` (`PgRelayProvisioner`).
- Tests: `infra/supabase/test/roles.test.ts` "lets the edge functions switch to a writer or a
  diner, never the provisioner, inheriting nothing", "lets only the two logins switch: the
  functions’ to a writer or diner, the Control Plane’s to the provisioner", "lets the Control
  Plane’s login provision a restaurant as the provisioner, and the functions’ login never".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.

#### RELAY-E4 Deleting records through the relay's roles

A diner, a PC or the API roles delete orders or menus.

- Mitigation: no relay or API role may delete; only the database's own retention job does.
- Code: `infra/supabase/migrations/20261002130000_relay_schema.sql` (`purge`).
- Tests: `infra/supabase/test/isolation.test.ts` "deletes nothing";
  `infra/supabase/test/retention.test.ts` "is run by the database itself, never by a relay or API
  role".
- Risk: likelihood Low, impact Medium: Low.
- Status: Mitigated.
