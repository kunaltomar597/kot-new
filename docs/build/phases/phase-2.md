# Phase 2: Waiter app, notifications, pagers

BRD §17 Phase 2. Exit criteria: alert latency and escalation targets met on the lab rig
(NFR-P03 ≤ 2 s event to pager vibration; escalation after N seconds; acknowledgement stops repeats).

---

## P2-01 React Native foundation

Goal: shared mobile foundation for the waiter app and the table tablet.
Requirements: NFR-U01 (native library), WTR-001 (signed APK, paired device, PIN), WTR-012
(offline drafts), AUTH-007 (Keystore credential), SEC-010, NFR-L02.
Depends on: P0-11, P0-12, P0-13, P0-14 (api-client, i18n).
Deliverables:
- `packages/ui-native`: React Native components matching `ui-web` (same tokens and behaviour): PinPad,
  Button, Sheet, Toast, StatusChip, menu item card, variant/modifier popup and combo picker using
  `@rp/domain` menu-selection (MENU-012).
- `apps/waiter-app` and `apps/table-tablet`: Expo (development builds, not Expo Go), EAS Build
  profiles for signed APKs, EAS Update with code signing, app config per environment.
- Shared mobile core (a `packages/mobile-core` package if it helps): pairing flow storing the device
  key in Android Keystore (expo-secure-store / native module), staff PIN login, token refresh,
  typed socket with resync, offline banner, persistent outbox of unsent submissions keyed by
  idempotency key (never silently discarded), menu cache with version refresh (MENU-013).
- Maestro smoke flows for both apps.
Notes: the Android signing keystore belongs to the Business Owner (OWNER_CHECKLIST item 8). CI builds
use EAS secrets; never commit keystores.
Acceptance: both apps build as development APKs in CI (EAS or local Gradle), pair with a local
server, log in, and show live data.

## P2-02 Waiter app: tables and order taking

Goal: waiters take orders and manage their tables.
Requirements: WTR-002, WTR-003, WTR-007, WTR-008, WTR-009, WTR-010, WTR-012, WTR-014, TBL-003,
ORD-006, ORD-011, NFR-U03 (reorder + send ≤ 5 taps).
Depends on: P2-01, P1-06.
Deliverables: "My tables" home with state, seated time, pending-approval badge and service requests,
toggle to all tables; open table; order taking with categories, search, item details, shared
selection popup, combos, quantity, instructions, Send KOT with per-KOT delivery confirmation; live
item status and mark picked up/served; move table; request bill; cancellations/voids with manager
PIN on the device; out-of-stock shown live; own pager battery/connection status.
Acceptance: Maestro flows for open → order → send → served; offline draft resent on reconnect
without duplicates (idempotency test against the server).

## P2-03 Notification and escalation engine

Goal: events become alerts to the right people and channels, with acknowledgement and escalation.
Requirements: NTF-001 to NTF-009, ORD-005, KDS-006, BRD Appendix C (factory defaults), OI-02.
Depends on: P0-12, P1-02.
Deliverables in `apps/server/src/notifications`: rule model (event type → recipients: responsible
waiter, section waiters, all waiters, managers on duty, cashier, station; channels; N; R), factory
defaults from Appendix C seeded as settings; recipient resolution using shift assignments and
responsible waiter; alert lifecycle (created, delivered, acknowledged, escalated, cleared) with
acknowledgement from any channel acknowledging everywhere; repeat every R until acked; escalation
after N to managers on duty; immediate manager routing when the waiter's pager and app are both
offline (NTF-007); manager nudge (preset or ≤ 40 chars); "On break" routing (S); at-least-once
delivery with device de-duplication and resync; timers that survive a server restart (persisted
deadlines, not in-memory only). Channel adapters: waiter app/POS/dashboard/KDS/tablet via Socket.io;
pager via MQTT (P2-04).
Acceptance: integration tests with a fake clock for repeat, escalation, ack-stops-repeat, offline
bypass, restart during a pending escalation, and the whole Appendix C matrix (table-driven).

## P2-04 MQTT broker and pager server side

Goal: secure, reliable pager messaging from the local server.
Requirements: PGR-005, PGR-007, PGR-008, PGR-011 (distribution), PGR-012, PGR-013, PGR-014,
SEC-012, NFR-P03.
Depends on: P0-11, P0-15 (TLS), P2-03.
Deliverables: Aedes broker embedded in the server with TLS (MQTTS), per-device authentication
(pager credential from pairing), ACL so each pager can only subscribe to its own topic and publish
acks/heartbeats; topic layout documented in AsyncAPI; message format (alert id, type, short text
≤ 2×12 chars, vibration pattern, sequence) with QoS 1 and de-dup IDs; heartbeat ingestion (battery,
RSSI, firmware), offline after 3 missed heartbeats; pager pairing (scan QR/serial) and assignment to
waiters (≤ 30 s re-assignment); low battery alerts; firmware OTA distribution endpoint for signed
images from the Control Plane.
Acceptance: integration tests with an MQTT test client: ACL denies cross-pager reads, QoS 1
redelivery after reconnect, offline detection, latency measured under load.

## P2-05 Pager firmware

Goal: production pager firmware on ESP32-S3.
Requirements: PGR-001 to PGR-014 (device side), SEC-012, ETSI EN 303 645 baseline.
Depends on: P2-04, P0-H1 (battery gate passed).
Deliverables in `firmware/pager` (ESP-IDF, C): Wi-Fi WPA2/WPA3 with power save and light sleep;
esp-mqtt over TLS with pinned CA; pairing mode showing a QR/serial; alert queue with count,
vibration pattern per type, LED, 2×12 text; short press ack, long press scroll; heartbeat every 30 s;
"no connection" icon + single vibration on loss; low-battery warning; OTA with A/B partitions,
signature check and automatic rollback; secure boot v2 and flash encryption config for production;
debug console locked; no default passwords. Unit tests for queue/formatting logic (Unity on host),
hardware-in-the-loop test procedure. A CI job that builds the firmware with the ESP-IDF Docker image.
People needed: flashing and on-device tests.
Acceptance: CI build green; person confirms on devices: alert → vibrate ≤ 2 s, ack round trip, OTA
update and rollback, 14 h battery with production firmware.

## P2-06 Waiter alerts, service-request inbox, manager nudge, "Notify manager"

Goal: nothing is missed on the floor.
Requirements: WTR-005, WTR-006, NTF-004, NTF-008, KDS-006, MGR-008 (basic alert centre in POS),
NFR-U03 (approve ≤ 2 taps).
Depends on: P2-02, P2-03.
Deliverables: Android foreground service + high-priority notifications that are hard to miss when
the app is backgrounded or locked; service-request inbox (Water/Waiter/Bill with table and age;
acknowledge, resolve); every pager alert mirrored in the app with shared acknowledgement; manager
nudge UI in POS/dashboard; KDS "Notify manager" wired to the engine; basic alert centre in POS.
Acceptance: Maestro test for background alert; integration test that acknowledging on the app stops
the pager repeats.

## P2-07 Phase 2 exit test: latency and escalation on the lab rig

Goal: prove NFR-P03, NTF-005, NTF-006 and S5, S14 on real devices.
Depends on: P2-01 to P2-06.
Deliverables: a measurement harness (server timestamps + pager ack timestamps) producing p50/p95
latency, an escalation scenario script, and a report template; CI version with simulated pagers.
People needed: lab rig with 4 pagers, 2 phones, KDS, router.
Acceptance: p95 event → vibration ≤ 2 s on the rig; unacknowledged alerts reach the manager after N;
results recorded in PROGRESS.md.
