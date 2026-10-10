# DAST: OWASP ZAP scans of the four surfaces

SEC-017 asks for dynamic application security testing of the QR site, the relay and the Control
Plane; the local server and its console are scanned the same way. Built in P8-03c1 (2026-10-10).
The harness is [`infra/dast`](../../infra/dast/README.md); the findings it judges against are in
[`infra/dast/src/triage.json`](../../infra/dast/src/triage.json).

## What is scanned, and as whom

Each surface runs from its build, as it runs for real, on a throwaway database:

| Surface                  | Started as                                                                                                              | Signed in as                                                                | ZAP gets                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| QR site                  | `next start`, pointed at the relay, on the only origin the relay allows                                                 | nobody (diners do not sign in)                                              | a table's menu, an unknown table code, `/`, the privacy notice and the terms               |
| Relay                    | the functions with Realtime (`@rp/relay/testing`): the diners' restaurant and a second one for the PCs' calls           | a table's code for the diners' calls; the second restaurant's PC credential | every operation of `docs/api/relay.openapi.json`                                           |
| Control Plane            | `dist/main.js` with the vendor web app, a Super Admin set up as the runbook says (setup token, password, authenticator) | that Super Admin                                                            | every operation of `docs/api/control-plane.openapi.json`, the web app's pages, a bill page |
| Local server and console | `dist/main.js` over HTTPS with the installation's CA, the console, the development seed, a POS paired with its key      | the Owner, by PIN, on that POS                                              | every operation of `docs/api/openapi.json`, the console's pages and the CA download        |

ZAP (2.17.0, its Automation Framework) adds the credentials to each request from a file the run
renews every half minute (an access token lasts 15 minutes), imports the OpenAPI operations
(each id given an example: ZAP cannot make one from the ids' pattern and would send an empty
one), spiders the pages, scans everything passively, then attacks it actively at medium
strength. The rules for software none of the surfaces has are off (`RULES_OFF` in
`infra/dast/src/plan.ts`: buffer overflows and format strings, server-side includes, SQL
injection for databases other than PostgreSQL, Log4Shell), and so are DOM-based cross-site
scripting, which drives a browser inside ZAP (the console and the QR site are checked under their
CSP and Trusted Types in Playwright instead), and the user-agent fuzzer, which finds nothing but
differences.

Not attacked, on purpose: the scan's own sign-out (`/api/v1/auth/logout`, the vendor session),
which would end its session, the real-time socket (WebSocket only), and the test relay's stand-in
for Supabase Storage.

## Running it

```
pnpm build
ZAP_PATH=~/zap/ZAP_2.17.0/zap.sh pnpm security:dast                  # an installed ZAP, Java 17+
ZAP_DOCKER_IMAGE=ghcr.io/zaproxy/zaproxy:2.17.0 pnpm security:dast   # its container (Linux)
RP_DAST_TARGETS=relay,qr-site ZAP_PATH=… pnpm security:dast          # some surfaces only
```

The reports are in `infra/dast/reports/`: per surface ZAP's JSON and Markdown report, its log and
plan, and `summary.md` for the run. In CI the `dast` job of `.github/workflows/security.yml` runs
it on every push to `main`, every Monday and by hand, with the ZAP container pinned by digest, and
keeps the reports for 30 days. It does not run on pull requests: the four scans take most of an
hour.

## How findings are judged

The run fails when a finding is open:

- a **High** is never accepted: it is fixed, or shown to be a false positive with the reason;
- a **Medium** or **Low** needs an entry in `triage.json` (false positive or accepted, with the
  reason) that covers every place ZAP saw it; a finding seen somewhere else stays open;
- **Informational** alerts are listed, not judged.

The summary also lists triage entries no finding needed, so a fixed finding's entry is removed.

## Results

The run of 2026-10-10 on this Mac (ZAP 2.17.0, all four surfaces, about nine minutes): no
finding open, no High and no Medium, no answer with a 5xx.

| Surface       | Endpoints ZAP knew | Active scan | High | Medium | Low (triaged) | Informational |
| ------------- | ------------------ | ----------- | ---- | ------ | ------------- | ------------- |
| QR site       | 21                 | 6 s         | 0    | 0      | 1             | 2             |
| Relay         | 15                 | 14 s        | 0    | 0      | 0             | 1             |
| Control Plane | 126                | 1 min 39 s  | 0    | 0      | 1             | 2             |
| Local server  | 443                | 5 min 34 s  | 0    | 0      | 2             | 4             |

### Found and fixed

| What the scans (and the checks around them) found                                                                                                                       | Fixed by                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The API answers of the local server, the Control Plane and the relay had no security headers of their own (PC-I2)                                                       | `API_SECURITY_HEADERS` (server, Control Plane) and `SECURITY_HEADERS` (relay): a CSP of `default-src 'none'` with `base-uri`, `form-action` and `frame-ancestors`, `nosniff`, `DENY`, no referrer; no caching and same-origin only on the server's and the Control Plane's |
| A path outside the API that nothing served got Express's HTML page, and a folder of the web apps' files a redirect page, each with a bare `default-src 'none'` (Medium) | the API's JSON 404 outside the API (`notFoundOutsideApi`), no folder redirects                                                                                                                                                                                             |
| The QR site ran inline scripts under `'unsafe-inline'` (RELAY-T5)                                                                                                       | a nonce per request, every page rendered for its request; no `'strict-dynamic'`, which in Chromium also runs inline scripts that running script creates                                                                                                                    |
| `/_next/static` on the QR site answered an HTML 404 without the CSP (Medium)                                                                                            | the proxy sets the policy on every request                                                                                                                                                                                                                                 |
| The QR site sent no HSTS (SEC-001)                                                                                                                                      | `Strict-Transport-Security: max-age=31536000`                                                                                                                                                                                                                              |
| The console and the vendor web app allowed strings into script and HTML sinks (PC-I4, DESKTOP-I1)                                                                       | Trusted Types with no policy                                                                                                                                                                                                                                               |
| Zod's `new Function` probe broke the CSP (and Trusted Types) on every page load of the three browser apps                                                               | Zod's compiled parsers off there                                                                                                                                                                                                                                           |
| The digital bill page allowed any inline style (`style-src 'unsafe-inline'`, Medium)                                                                                    | its one style block allowed by its hash                                                                                                                                                                                                                                    |
| `/version` named the exact Node.js version to anyone (PC-I2)                                                                                                            | the major line only                                                                                                                                                                                                                                                        |

### Triaged

| Finding                                        | Where                                  | Decision       | Why                                                                                                                                                                      |
| ---------------------------------------------- | -------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Private IP Disclosure (Low)                    | the web apps' scripts                  | false positive | example addresses in help texts (192.168.1.20:8443, 192.168.1.50) that the English catalogue carries                                                                     |
| Private IP Disclosure (Low)                    | `/api/v1/printers` on the local server | false positive | the restaurant's own printers, set up by it, for a person who may manage them, never leaving its network                                                                 |
| Strict-Transport-Security Header Not Set (Low) | every answer of the local server       | accepted       | a LAN certificate from the installation's own CA and no plain-http listener; a browser that remembered HSTS could not open the console after a replaced PC renews the CA |

The informational alerts: comments in the minified scripts that ZAP finds suspicious (`10027`),
"a modern web application" (`10109`), the vendor session's answer (`10112`), a table session's
id in a query (`10024`, an id, no secret) and `no-store` without `must-revalidate` (`10015`).

Seen on the way: the QR site's script carries the whole English catalogue, the POS's texts
included; nothing in it is secret, and it fits the speed budget (QR-012), but P8-04 may split it.

## What the scans do not cover

- **Signed requests.** The Control Plane's endpoints for restaurant PCs need a signature per
  request (ADR-0012), which ZAP cannot make: it attacks them unsigned, and they refuse it.
  `signed-requests.int.test.ts`, `tenant-isolation.int.test.ts` and the authorisation sweep
  (P8-03a) cover them signed.
- **Other kinds of device.** The local server is attacked as a POS with the Owner signed in; the
  endpoints for phones, tablets and kitchen screens refuse a POS. The authorisation sweep calls
  every endpoint as every kind of device and role.
- **Bodies the schemas refuse.** About four answers in five are 4xx: ZAP's generated bodies and
  attacks mostly fail the shared Zod schemas before any handler runs, which is the point of them
  (SEC-004). The integration tests drive the handlers with valid input.
- **The socket and the pager broker** are not HTTP: their handshakes, rooms, limits and ACL are
  in `realtime.int.test.ts`, `pager-broker-limits.int.test.ts` and `authorisation.md`; floods of
  them are P8-03c2.
- **Callbacks over the internet.** ZAP's out-of-band rules (SSRF, Log4Shell) need a callback
  server on the internet, which the scan does not use. No endpoint fetches an address a caller
  gives (CP-I5).
- **The deployments.** The scans run on plain http on this machine (the local server on its own
  HTTPS). The hosts' TLS, HSTS and edge limits are checked where they are set up: the QR site's
  headers and TLS in manual task 21, the relay's on Supabase in manual task 20, the Control
  Plane's when it is hosted; rate limits at the edge are P8-03c2.
- **The penetration test.** DAST finds what a scanner finds. The testers of P8-03e get these
  reports, the threat models and the authorisation sweep as their starting point.
