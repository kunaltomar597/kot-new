# @rp/mobile-shell

Screens and hooks shared by the waiter app and the table tablet (P2-01c), on top of
`@rp/mobile-core`'s `DeviceSession`:

- `ShellProvider`: the device session, the i18n catalogue (NFR-L02) and the `@rp/ui-native` theme.
- `PairingScreen`: server address and pairing code (AUTH-007).
- `LoginScreen`: staff tiles, optionally limited to some roles, and the PIN pad (AUTH-001).
- `ConnectionBanner`, `Screen` (with a footer that stays put, e.g. Send KOT), `Note`.
- `useLive`: data read again after the events that change it and after a reconnect.
- `useMenu` and `useUnsentOrders`: the menu and the unsent orders the device keeps, at once and
  live (MENU-013, WTR-012, P2-02b).

Tested with Jest and React Native Testing Library against `@rp/mobile-core/testing`'s fake server.
