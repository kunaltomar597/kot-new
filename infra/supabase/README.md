# infra/supabase: QR relay (C8)

The cloud relay between diners' phones (QR menu) and the restaurant's local server, on Supabase in
the Mumbai region. Design: [ADR-0015](../../docs/adr/0015-qr-relay-on-supabase.md). Package
`@rp/relay`.

- `config.toml`: Supabase CLI settings. For a local stack, run `supabase start --workdir infra`
  (needs Docker). The `relay` schema stays out of the Data API.
- `migrations/`: the relay schema. Applied by `supabase start`, `supabase db push --workdir infra`
  and the tests.
  - Every table has Row-Level Security, with policies for three roles: `relay_server` (a local
    server's Realtime subscription), `relay_writer` (edge functions acting for a local server) and
    `relay_diner` (edge functions acting for a browser).
  - Two logins, both created without a password (manual task 20 gives them one): `relay_edge`
    (the edge functions; it may take `relay_writer` or `relay_diner` only) and
    `relay_control_plane` (provisioning restaurants; it may take `relay_provisioner` only).
  - Tokens and credentials are stored only as SHA-256 hashes.
  - The order rules are triggers. Orders and service requests are limited per table and per
    browser under advisory locks (`relay.rate_limit_wait`, `relay.service_request_wait`).
  - Retention is `relay.purge()`, run hourly by pg_cron.
- `src/`: the edge functions, as Fetch API handlers tested on Node.
  - `qr-menu`, `submit-order` and `order-status` are for diners' browsers (P5-02a);
    `service-request` handles Call waiter and Request bill (P5-05c).
  - `server` is for the restaurant's local server, with its credential (P5-02b): a Realtime
    session, presence with the QR settings, publishing the menu, the tables with their code
    hashes, picking up orders and reporting their status, and menu photos into the
    `menu-photos` Storage bucket with their 90-day sweep (P5-03c).
  - `src/entries/` holds the Supabase entries. `pnpm --filter @rp/relay build` bundles them with
    esbuild into `dist/functions/<name>/index.js`, which `config.toml` names.
  - The request and response schemas are in `@rp/contracts/relay`, documented in
    `docs/api/relay.openapi.json`.
- `test/`: Vitest suites, which run on a throwaway PostgreSQL 16.
  - The function tests call each handler with a `Request`, on a connection logged in as
    `relay_edge`.
  - `deno-smoke.test.ts` runs the real bundles under Deno when `deno` is installed.
  - `startRelay` (`@rp/relay/testing`) runs the functions over HTTP for other packages' tests,
    with an in-memory photo bucket and, given a JWT secret, a stand-in for Realtime (P5-03d).
  - `test/setup/supabase-prelude.sql` stands in for Supabase's own roles and publication.
  - The tests act as each role the way PostgREST, Realtime and the edge functions do:
    `SET LOCAL ROLE` plus `request.jwt.claims`.
  - With `RELAY_DATABASE_URL` (a superuser connection), they run against a running Supabase stack
    instead. The `relay-supabase` CI job does this.

```
pnpm --filter @rp/relay build       # bundle the edge functions
pnpm --filter @rp/relay test        # isolation, roles, tokens, order rules, retention, functions
```

Adding a migration:

- Name it `<UTC timestamp>_<name>.sql`.
- Revoke `EXECUTE` from `PUBLIC` on every new function.
- Enable RLS and add policies for every new table.
- `test/roles.test.ts` fails if a table, policy or grant falls outside the rules.

Deploying to the real projects is
[manual task 20](../../manual-tasks/20-supabase-relay.md).

Operating it: [the QR relay runbook](../../docs/runbooks/qr-relay.md).

Built by: P5-01 (database), P5-02 (edge functions), P5-03c (photos), P5-03d (Realtime), P8-03b4b
(the threat model's fixes: the two logins, the limits, capped bodies, no CORS for PCs, WebP only).
