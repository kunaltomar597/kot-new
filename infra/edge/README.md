# infra/edge

The rate limits in front of the cloud services (P8-03c2b; threats CP-D1 and RELAY-D4), and the
check to run against a deployment. Built by: P8-03c2b.

The services limit themselves first, in each instance's memory:

| Where                        | Limit                                                                                         | Code                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Control Plane, per address   | 300 at once, then 30 a second; digital bill pages 60 then 5 a second; `/v1/health` never      | `apps/control-plane/src/http/request-limits.ts` |
| Relay reads, per table token | 40 at once, then 5 a second (menu, order status, service request status)                      | `infra/supabase/src/read-throttle.ts`           |
| Relay reads, per address     | 120 at once, then 20 a second                                                                 | the same                                        |
| QR site, the first view      | one read of the relay per table in 5 seconds, shared by everyone who opens the page meanwhile | `apps/qr-menu/src/site/menu-cache.ts`           |

A refusal is 429 `RATE_LIMITED` with `Retry-After`. Instances do not share memory, so the limits
above are per instance; the edge in front of the services counts across all of them and stops a
flood before it reaches an instance that costs money to run.

## What the edge must do (manual task 32)

Whatever the hosting provider calls it (a CDN's rules, a WAF, a load balancer's policy):

1. **Control Plane host.** Per client address: at most 600 requests a minute to `/v1/*`, 60 a
   minute to `POST /v1/enrolments` and `POST /v1/vendor/*` sign-in routes, 120 a minute to
   `/v1/bills/*`. Over the limit: 429 with `Retry-After`. Never limit `GET /v1/health` (the
   load balancer's probe). Pass the client address on (`X-Forwarded-For`) and set
   `CP_TRUST_PROXY` to the number of proxies in front, since the Control Plane refuses to start
   in staging or production without it while its own limits are on.
2. **Relay (Supabase edge functions).** Per client address: 1,200 requests a minute to
   `/functions/v1/qr-menu`, `/order-status` and `/service-request`; 60 a minute to
   `/submit-order`. The database's per-table order limits (QR-006) stay as they are.
3. **QR site host.** Per client address: 120 page views a minute to `/t/*`. Static files from the
   CDN's cache.
4. **Body sizes** the services already enforce (64 kB, 512 kB for diners) are repeated at the edge
   so a body is refused before it is read.
5. Keep **connection limits and timeouts** at their defaults or tighter (header and body read
   timeouts of 10 seconds); a connection held open without a request costs the edge, not the
   service.

## Checking a deployment

```
node infra/edge/check-edge.mjs https://cloud.example.in/v1/enrolments --method POST --health https://cloud.example.in/v1/health
node infra/edge/check-edge.mjs https://<project>.supabase.co/functions/v1/qr-menu --header "x-table-token: <a test table's token>"
```

It sends 400 requests (20 at a time) and exits 0 only when some were answered 429, every one of
those with `Retry-After`, and the health probe was not limited. Run it against staging after any
change to the edge's rules and before the penetration test (P8-03e). The script's own tests are in
`infra/ci/check-edge.test.mjs` (`pnpm ci:test`).
