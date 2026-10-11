# ADR-0020: Load tests with a Node.js harness on the apps' own clients

Status: Accepted
Date: 2026-10-09
Work package: P8-01a
Requirements: NFR-P01 to NFR-P04, NFR-P08 to NFR-P11, §7.2, S1

## Context

BRD §7.2 asks for the targets of §7.1 at design capacity, "validated by load tests (§18)", and the
tech stack table suggests "load tests (k6 or similar)". The restaurant's traffic is unlike a web
site's:

- 200 live Socket.io connections that each re-read their screen after events;
- 30 pagers on MQTTS with their own credentials and QoS 1 sessions;
- 8 printers that take ESC/POS over raw TCP;
- every device pinned to the installation's own CA (ADR-0011);
- devices that sign challenges with their keys (AUTH-007).

Most targets are end to end: an order sent on a phone until the ticket shows on a kitchen screen
or comes out of a printer, a dish marked ready until a pager buzzes, a server killed until every
client has resynchronised. Measuring them needs the device at both ends.

k6 speaks HTTP and WebSocket. Socket.io, MQTT and raw TCP need xk6 extensions in Go, and the
devices' behaviour (the Engine.IO protocol, the realtime resume protocol, debounced re-reads,
idempotent retries, device-key signatures) would be written a second time, in JavaScript run by
k6's own engine, with no type checks against `@rp/contracts`.

## Decision

- **The harness is TypeScript in `apps/server/test/load/`**, run by Vitest like the other
  performance runs (`RP_PERF=1`, `test/performance/load.perf.test.ts`). Its simulated devices use
  the apps' own `@rp/api-client` (REST and `RealtimeConnection`), the screens' event filters and
  `@rp/ordering`'s `liveRefresh`, `mqtt` for pagers, and `node:net` servers for printers. A
  change to a contract or a client changes the load test with it, and the type checker says so.
- **The server under test runs in a process of its own** (`dist/main.js`), with TLS and the pager
  broker on, on a PostgreSQL as durable as the restaurant PC's (fsync, synchronous commit,
  full-page writes, WAL archiving). The harness's own event-loop delay is measured and reported,
  so a figure distorted by the load generator shows.
- **The load is open-loop**: orders arrive at the peak rate whether or not the server keeps up,
  and people react at their own pace. Every random choice comes from a seed.
- **The same run, small and in-process**, is in the integration suite (`load-rush.int.test.ts`),
  so the harness cannot rot: it must serve every order, KOT, print and alert exactly once, and log
  no server error.
- Devices start with a device token signed at set-up. 200 challenges from one address would trip
  the per-address limit (60 a minute), which in a restaurant every device has to itself.

## Alternatives considered

- **k6 with xk6-mqtt and a Socket.io shim**: a Go toolchain on every machine that runs it, a
  second implementation of the devices' protocols, no shared types.
- **Artillery** (Node.js, Socket.io plugin): no MQTT or raw TCP, YAML scenarios that cannot
  express people reacting to what their screens show.
- **The server in the harness's process** for the full run: one event loop for both sides would
  make every latency the harness's as much as the server's. It is used only for the short run.

## Consequences

- The run needs `pnpm build` first and takes the rush's 25 minutes plus the history's set-up
  (10 to 60 minutes, or 30 s when a set-up restaurant is reused, `RP_LOAD_BASE`); it is opt-in
  and not part of `pnpm check`. Its figures are recorded in `docs/build/performance.md`.
- The lab rig's S1 (P8-01c) can reuse the harness against a real install with real devices next
  to simulated ones.
- One process generates the whole load. At §7.2 it stays well under a core; a much larger load
  would need the devices spread over worker threads.
