# @rp/ui-native

React Native components for the waiter app and the table tablet (P2-01b). They match `@rp/ui-web` in
props, behaviour and colours (NFR-U01): the same `@rp/design-tokens` values, the same order item
state styles, and the same `@rp/domain` menu-selection rules (MENU-012, ORD-014).

Components:

- `Button`, `Money`, `StatusChip`, `Glyph` (decorative text symbols, so no icon font is needed).
- `PinPad`: dots only, progress announced without the digits (AUTH-002, AUTH-004).
- `Sheet`: the bottom sheet for item options, table actions and confirmations.
- `ToastProvider` and `useToast`: the same API as the web toasts; errors stay until dismissed.
- `MenuItemCard`, `QuantityStepper`, `ChoiceGroup`, `ItemOptions` (variants and modifiers) and
  `ComboChoices` (combo slots).

Every app wraps its root in `UiStringsProvider` (the `ui.*` keys of `@rp/i18n`, the same shape as
`@rp/ui-web`) and `ThemeProvider` (theme name and the restaurant accent). Every other label is a prop,
so no component holds UI text (NFR-L02).

Tests run with Jest and React Native Testing Library (`pnpm --filter @rp/ui-native test`), because
Vitest cannot load React Native's Flow sources. Jest maps `@rp/design-tokens` and `@rp/domain` to
their `dist/` builds, so build them first (`pnpm build` does).
