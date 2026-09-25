# apps/server: local server (C1)

NestJS on Node.js LTS, Prisma, PostgreSQL (C2), Socket.io, Aedes MQTT. Runs on the restaurant PC as a
Windows service separate from the POS window (ADR-0004). It is the single source of truth for the
restaurant and hosts the web console.

Modules (one Nest module each, under `src/`): config, logging, errors, health, database, audit, auth,
devices, realtime (event bus, outbox, Socket.io), settings, floor (tables, sessions), menu, orders,
kitchen (stations, printers, KOT printing), billing, payments (shifts, day-end), reports,
notifications, mqtt (pagers), service-requests, recommendations, sync (QR relay), licensing, backup,
updates, diagnostics.

Built by: P0-07 (skeleton), P0-08 to P0-12, then Phases 1 to 7. Not started yet.
Business rules come from `@rp/domain`; request/response/event shapes from `@rp/contracts`.
