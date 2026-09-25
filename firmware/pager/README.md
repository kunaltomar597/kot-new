# firmware/pager: wrist pager firmware (C9)

ESP-IDF (C) project for the ESP32-S3 pager (pilot hardware: LilyGO T-Watch S3 or equivalent,
PGR-004). esp-mqtt over TLS with QoS 1, per-device credentials, vibration patterns, 2×12 text,
acknowledge button, heartbeat, power save, signed OTA with A/B rollback, secure boot and flash
encryption in production.

Built by: P0-H1 (battery prototype), P2-05 (production firmware). Not started yet.
Outside the pnpm workspace; built with the ESP-IDF Docker image in CI.
