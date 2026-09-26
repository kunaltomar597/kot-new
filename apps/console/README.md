# apps/console: web console (C3)

React 19 + TypeScript (Vite, React Router), served by the local server. One codebase with
role-based modes:

- POS (`/pos`): tables, order entry, billing, shifts, day-end (Phase 1);
- KDS (`/kds`): kitchen station screens, device-authenticated (Phase 1);
- Manager dashboard (`/manage`): live views, management, configuration, reports (Phase 4).

Opened in Electron on the restaurant PC (P0-16) and in browsers on paired devices. Uses
`@rp/ui-web`, `@rp/api-client`, `@rp/i18n` and `@rp/domain`. Built by P0-14b (shell); the mode
screens come with P1-08, P1-09, P1-12 and P4-01 to P4-07.

## What the shell does (P0-14b)

- Pairing (`/pair`, AUTH-007): the browser makes a non-extractable ECDSA P-256 key with WebCrypto
  and pairs with a manager's code. WebCrypto exists only on https:// pages or on localhost, so
  until P0-15 a browser can only be paired on the server PC itself.
- Login (`/login`, AUTH-001, AUTH-004): staff tiles, then the `@rp/ui-web` PIN pad (touch or
  keyboard). A KDS device skips login and shows its station (station mode, AUTH-005).
- Modes: people land in their home mode (Owner and Manager: Manage; Cashier and Waiter: POS;
  Kitchen: KDS) and may open the modes their role allows (`src/app/modes.ts`, BRD §4.2 matrix).
- Connection banner (NFR-P11) from the live connection's status; inactivity warning and sign-out
  (AUTH-005) with a keep-alive while the person is using the screen.
- Storage (`src/app/storage.ts`): the key pair (as a key object), device token and device summary
  in IndexedDB; the session in `sessionStorage` (this tab only, so a shared terminal never reopens
  signed in); the resume point in `localStorage`.
- POS floor (`/pos`, P1-08a, TBL-007): `src/pos/` shows every table by section with its state,
  guests, time seated, waiter and amount so far, and reads the overview again after table, order
  and bill events. A free table opens (guests, optional waiter); an occupied one moves.
- POS order entry (`/pos/table/:sessionId`, `/pos/takeaway`, P1-08b): `src/pos/OrderEntry.tsx`
  browses and searches the menu (`menu-view.ts`), chooses options in `ItemDialog` (rules and
  estimated prices from `@rp/domain` menu-selection), keeps the cart (`cart.ts`, never sends
  prices), sends it with one idempotency key per cart (a retry cannot duplicate the order), marks
  refused lines, and lists what was sent with live item states. `src/app/use-live.ts` reads data
  again after the events that change it and after a reconnect.
- Kitchen display (`/kds`, P1-09b): `src/kds/KdsScreen.tsx` shows the station's tickets with
  live age from the server clock, badges, combo grouping and item states; item and ticket steps,
  bump and recall, pick-up at the pass, "Notify manager" for ready food waiting, sounds
  (`sounds.ts`, on after the first touch), an all-day summary and a full-screen notice while
  disconnected. The rules are in `kds-view.ts`.
- `src/app/console-controller.ts` holds the state and actions outside React (tested on its own);
  screens read it with `useSyncExternalStore`. All text comes from `@rp/i18n` (NFR-L02).

## Commands

```
pnpm --filter @rp/console dev          Vite dev server; /api and /socket.io go to RP_SERVER_URL
                                       (default http://127.0.0.1:8080: run the server alongside)
pnpm --filter @rp/console build        build to dist/ (the server serves it with RP_CONSOLE_DIR)
pnpm --filter @rp/console test         unit and screen tests (Vitest, Testing Library, axe)
pnpm --filter @rp/console e2e          Playwright against the built server and console (after
                                       `pnpm build`; uses TEST_DATABASE_URL or a throwaway cluster)
```

The e2e tests (`e2e/`) start PostgreSQL, seed it, run `apps/server/dist/main.js` with the built
console, pair a real Chromium, sign each role in and stop and restart the server to check the
offline banner. In cloud sessions they use the preinstalled Chromium (`/opt/pw-browsers`); CI
installs Playwright's own.
