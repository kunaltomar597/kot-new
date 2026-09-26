# @rp/ui-web

React 19 component library for the console (POS, KDS, manager dashboard) and the QR menu, built on
`@rp/design-tokens` (NFR-U01). Built in P0-13 (see ADR-0009); P1-08a adds the table tile; P1-08b adds the menu item card and the
variant/modifier/combo selection components (MENU-012).

## Components

- Actions: `Button`, `IconButton`, `Icon`, `Spinner`
- Input: `PinPad` (login and manager overrides, AUTH-004), `NumberPad` (+ `applyNumberPadKey`),
  `TextField`, `Select`
- Overlays: `Dialog`, `Sheet`, `ConfirmDialog` (NFR-U04), `ToastProvider` + `useToast`
- Navigation: `Tabs`
- Display: `Badge`, `StatusChip` (order item states, `ORDER_ITEM_STATE_STYLES`), `Money` (paise via
  `formatRupees`), `Card`, `Table`
- States (NFR-U04): `EmptyState`, `LoadingState`, `ErrorState`, `ConnectionBanner`
- Setup: `ThemeRoot` (theme + accent), `UiStringsProvider`

## Set up in an app

```tsx
import '@rp/design-tokens/tokens.css';
import '@rp/ui-web/styles.css';
import { ThemeRoot, ToastProvider, UiStringsProvider } from '@rp/ui-web';

<UiStringsProvider strings={uiStrings /* from @rp/i18n */}>
  <ToastProvider>
    <ThemeRoot theme="kds">{app}</ThemeRoot>
  </ToastProvider>
</UiStringsProvider>;
```

## Rules

- No UI text inside components (NFR-L02). Labels are props; the few built-in words (keypad button
  names, "Close", the PIN progress announcement) come from `UiStringsProvider`. The English values
  in `fixtures/en-strings.ts` are for tests and the workbench; P0-14 moves them into `@rp/i18n`.
- Interactive elements are at least `--rp-touch-target` (48 px, 64 px in the KDS theme), have
  visible focus, and colour is never the only signal (text or icon always accompanies it).
- Money is integer paise and is only displayed through `Money`/`formatRupees`.
- Inside a `Dialog`, mark the element to focus first with `data-autofocus`, not `autoFocus`
  (React focuses before the native dialog opens).
- Styles are plain CSS in `src/styles/`, in cascade layers; use token variables only.

## Commands

```
pnpm --filter @rp/ui-web test              Vitest + Testing Library + axe (jsdom)
pnpm --filter @rp/ui-web workbench         Storybook on http://localhost:6006
pnpm --filter @rp/ui-web workbench:build   static Storybook in storybook-static/
```

The workbench toolbar switches theme (light, dark, KDS) and accent colour. "Foundations/Themes"
shows the main components in all three themes side by side.
