# Security

The security documents of the Restaurant Operations Platform (BRD §8, P8-03). BRD §8 defines
security as measurable compliance with recognised standards plus an independent penetration test;
these documents are the evidence for that, with links to the code and the tests that prove each
point.

| Document                                           | What it covers                                                                                                                                                              | Requirements                         | WP     |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------ |
| [authorisation.md](authorisation.md)               | Who may call what, on every surface (REST, socket, MQTT, relay, Control Plane), and the tests that check it on every build                                                  | SEC-003, SEC-017, AUTH-010, AUTH-009 | P8-03a |
| [Threat models (STRIDE)](threat-models/README.md)  | LAN and local server, pager channel, QR relay and site, update pipeline, licence, Control Plane, desktop, phones and tablets; `pnpm security:threats` checks their evidence | SEC-000                              | P8-03b |
| [DAST](dast.md)                                    | OWASP ZAP scans of the QR site, the relay, the Control Plane and the local server; each finding fixed or triaged; the flood tests of the local server from the LAN          | SEC-017, SEC-009                     | P8-03c |
| ASVS L2, MASVS, ETSI EN 303 645 and CIS checklists | Each control with its evidence; the Electron review; the MDM policy                                                                                                         | §8.1, SEC-010, SEC-011               | P8-03d |
| Incident response plan; penetration-test pack      | Severities, contacts, CERT-In 6-hour and DPDP reporting; scope, rules and accounts for the testing firm                                                                     | SEC-016, SEC-017                     | P8-03e |

Related, elsewhere:

- [ADR-0011](../adr/0011-lan-tls-private-ca.md) LAN TLS with the installation's own CA;
  [ADR-0012](../adr/0012-control-plane-installation-identity.md) signed requests from restaurant
  PCs; [ADR-0015](../adr/0015-qr-relay-on-supabase.md) the QR relay and its Row-Level Security;
  [ADR-0010](../adr/0010-supply-chain-ci-and-contract-docs.md) the CI security baseline.
- [Vendor access policy](../runbooks/vendor-access-policy.md) (SEC-018, AUTH-014, UPD-009).
- Security-sensitive pull requests that the human review in P8-03 must look at are listed under
  decision 8 in `docs/build/PROGRESS.md`.
