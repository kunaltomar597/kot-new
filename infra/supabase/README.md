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
  - Tokens and credentials are stored only as SHA-256 hashes.
  - The order rules are triggers.
  - Retention is `relay.purge()`, run hourly by pg_cron.
- `functions/`: edge functions (P5-02).
- `test/`: Vitest suites, which run on a throwaway PostgreSQL 16.
  - `test/setup/supabase-prelude.sql` stands in for Supabase's own roles and publication.
  - The tests act as each role the way PostgREST, Realtime and the edge functions do:
    `SET LOCAL ROLE` plus `request.jwt.claims`.
  - With `RELAY_DATABASE_URL` (a superuser connection), they run against a running Supabase stack
    instead. The `relay-supabase` CI job does this.

```
pnpm --filter @rp/relay test        # isolation (SEC-005, QR-014), roles, tokens, order rules, retention
```

Adding a migration:

- Name it `<UTC timestamp>_<name>.sql`.
- Revoke `EXECUTE` from `PUBLIC` on every new function.
- Enable RLS and add policies for every new table.
- `test/roles.test.ts` fails if a table, policy or grant falls outside the rules.

Deploying to the real projects is
[manual task 20](../../manual-tasks/20-supabase-relay.md).

Built by: P5-01 (database), P5-02 (edge functions).
