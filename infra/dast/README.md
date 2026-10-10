# infra/dast: DAST with OWASP ZAP (P8-03c1)

SEC-017 asks for dynamic testing of the QR site, the relay and the Control Plane; the local
server and its console are scanned too. `@rp/dast` starts each surface as it runs for real,
signs in where it needs to, and runs OWASP ZAP's Automation Framework on it. Results and the
decisions on each finding: [`docs/security/dast.md`](../../docs/security/dast.md).

| Surface         | Started as                                                                           | ZAP gets                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `qr-site`       | the built site (`next start`) against the relay, on the one origin the relay allows  | its pages: a table's menu, an unknown code, the privacy notice and terms                                    |
| `relay`         | the relay's functions with Realtime, two restaurants (`@rp/relay/testing`)           | `relay.openapi.json`: a table's code for the diners' calls, another restaurant's PC credential for the PCs' |
| `control-plane` | the built Control Plane with the vendor web app, a Super Admin set up by the runbook | `control-plane.openapi.json` as that Super Admin; the app's pages; a bill page                              |
| `local-server`  | the built server over HTTPS with its CA, the console, a paired POS, the Owner by PIN | `openapi.json` as that POS and Owner; the console's pages and the CA download                               |

Each scan: ZAP's request script adds the credentials (`headers.json`, renewed every half minute
while ZAP works, since an access token lasts 15 minutes), the OpenAPI operations are imported
(ids given an example, `src/openapi.ts`), the pages spidered, everything passively scanned, then
actively attacked (strength medium; the rules for software none of the surfaces has are off,
`RULES_OFF` in `src/plan.ts`). Each finding is judged against `src/triage.json`: a High is never
accepted, everything else needs a decision with its reason, everywhere it was seen.

```
pnpm build                                     # the surfaces are run from their builds
ZAP_PATH=~/zap/ZAP_2.17.0/zap.sh pnpm security:dast              # an installed ZAP (Java 17+)
ZAP_DOCKER_IMAGE=ghcr.io/zaproxy/zaproxy:2.17.0 pnpm security:dast  # or its container (Linux)
RP_DAST_TARGETS=qr-site,relay ZAP_PATH=… pnpm security:dast      # some surfaces only
pnpm --filter @rp/dast test                    # the unit tests (the scans skip without RP_DAST)
```

PostgreSQL as for the integration tests (`PG_BIN`, or `TEST_DATABASE_URL`). Reports go to
`reports/` (`RP_DAST_REPORTS`): per surface ZAP's JSON and Markdown, its log and the plan, and
`summary.md` for the run. CI runs it in the `dast` job of `.github/workflows/security.yml` (on
`main`, weekly, by hand) with the ZAP container pinned by digest, and keeps the reports.
