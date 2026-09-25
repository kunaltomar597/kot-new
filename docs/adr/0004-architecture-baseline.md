# ADR-0004: Architecture baseline accepted from the BRD

Status: Accepted
Date: 2026-09-25
Work package: P0-01
Requirements: BRD §10.1, §10.2, Appendix D, NFR-A01, NFR-A04, KDS-001, MGR-001, INT-001 to INT-003

## Context

The BRD (Appendix D) changes the original blueprint in several places. This ADR records those
changes as the baseline so later ADRs can refer to them.

## Decision

- The local server runs as its own Windows service with a watchdog, separate from the POS window,
  so closing the POS never stops tablets, pagers or the KDS.
- One React web console served by the local server provides POS, manager dashboard and KDS modes;
  the KDS is a browser mode, not an Electron app. Electron is only the shell on the restaurant PC.
- Local-first: the local PostgreSQL is the source of truth; the cloud never connects in; outbound
  HTTPS/WSS only.
- Event-driven real time: domain events via an in-process bus with a transactional outbox; Socket.io
  to apps; MQTT (Aedes, TLS, QoS 1) to pagers; outbox/inbox with idempotency keys to the cloud.
- Modular monolith inside the server with ports and adapters (MenuProvider, TableProvider,
  OrderSink, OrderStatusSource) so peripheral modules can later serve third-party POS systems.
- The local database is single-tenant but every record keeps `restaurant_id`; cloud tenant isolation
  uses RLS and CI isolation tests.
- Pager firmware uses ESP-IDF with esp-mqtt (TLS, QoS 1), not PubSubClient.

## Consequences

These are fixed unless a later ADR supersedes one with a reason.
