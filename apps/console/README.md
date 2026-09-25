# apps/console: web console (C3)

React + TypeScript (Vite), served by the local server. One codebase with role-based modes:

- POS (`/pos`): tables, order entry, billing, shifts, day-end (Phase 1);
- KDS (`/kds`): kitchen station screens, device-authenticated (Phase 1);
- Manager dashboard (`/manage`): live views, management, configuration, reports (Phase 4).

Opened in Electron on the restaurant PC and in browsers on paired devices. Uses `@rp/ui-web`,
`@rp/api-client`, `@rp/i18n`, `@rp/domain`.

Built by: P0-14 (shell), P1-08, P1-09, P1-12, P4-01 to P4-07. Not started yet.
