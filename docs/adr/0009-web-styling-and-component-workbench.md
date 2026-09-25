# ADR-0009: Web styling approach and component workbench

Status: Accepted
Date: 2026-09-25
Work package: P0-13
Requirements: NFR-U01, NFR-U02, NFR-U03, NFR-U05, KDS-011, AUTH-004, NFR-A01, NFR-P07 (tap feedback ≤ 100 ms)

## Context

P0-13 builds the design tokens and the React web component library used by the console (POS,
dashboard, KDS in Chromium and Electron) and later the QR menu (Next.js). The phase plan asks for a
CSS approach that avoids runtime CSS-in-JS (the KDS runs for hours on modest hardware and
re-renders often) and for a component workbench (Storybook or Ladle).

Forces:

- The same tokens must feed React Native (P2-01), so the source of truth has to be plain data, not
  CSS.
- Themes (light, dark, KDS dark) and the restaurant accent must switch at runtime without
  rebuilding CSS (NFR-U02).
- Consumers are Vite (console), Next.js (QR menu) and Electron. The library should not force a
  bundler plugin on them.
- Everything must work offline (NFR-A01): no web fonts or CDN assets.

## Decision

Styling:

- `@rp/design-tokens` defines every token as typed TS objects (colour roles per theme, spacing,
  radius, type, elevation, motion, z-index, touch targets). Its build generates `tokens.css`: CSS
  custom properties named `--rp-<group>-<key>`, with theme blocks selected by
  `data-theme="light|dark|kds"` and an OS-preference fallback. The KDS theme also raises font sizes
  and `--rp-touch-target` to 64 px (KDS-011). `accentVariables()` sets the accent and picks a
  readable text colour for it.
- `@rp/ui-web` uses plain, static CSS files with `rp-` prefixed class names and `data-*` attributes
  for variants, shipped as `@rp/ui-web/styles.css`. All rules live in cascade layers
  (`rp.tokens`, `rp.base`, `rp.components`), so any unlayered app CSS overrides them without
  specificity fights. Components only reference token variables; a test forbids raw colours in the
  stylesheets.
- Components do not import CSS; apps import the two stylesheets once. `sideEffects: ["*.css"]`
  keeps tree shaking correct.
- System font stack only (Segoe UI on Windows, Roboto on Android); nothing is downloaded.
- Contrast is enforced by unit tests on the token values (WCAG 2.2 AA for every theme, AAA for KDS
  text), because jsdom cannot compute colours for axe.

Workbench:

- Storybook 10 (`@storybook/react-vite`), the current major (the phase plan named Storybook 9,
  which is superseded; CSF stories are unchanged). No add-ons: the theme and accent switchers use
  Storybook's built-in toolbar globals. Run with `pnpm --filter @rp/ui-web workbench`; build with
  `workbench:build`. The workbench is not part of `pnpm check` (it is slow and not a gate).

Testing:

- Vitest + Testing Library in jsdom, with axe-core run directly on key components (colour contrast
  rule off, see above). A small shim adds `showModal`/`close` to jsdom's `HTMLDialogElement`.
- Behaviour that needs a real browser (native dialog focus, top layer, touch sizing per theme) was
  checked with Playwright in Chromium against the built workbench; an automated browser suite comes
  with the console's Playwright tests (P0-14).

## Alternatives considered

- CSS Modules: scoped class names, but they need a bundler step in every consumer (and
  `transpilePackages` in Next.js) and give nothing that prefixed classes plus cascade layers do not
  already give a single-team library.
- vanilla-extract: type-safe and zero-runtime, but it adds a compiler plugin to every consumer
  (Vite, Next.js, Storybook) and a second place where tokens are declared.
- Runtime CSS-in-JS (styled-components, Emotion): rejected for KDS performance, as the plan says.
- Tailwind: fast to write, but class soup in shared components and a second token system to keep in
  sync with native.
- Ladle: lighter, but its last release (5.1.1, Nov 2025) pins Vite 6 while the repo uses Vite 8;
  Storybook is actively maintained and supports Vite 8.
- Vitest browser mode in Chromium for all component tests: more faithful, but needs a browser in
  the CI `check` job; revisit when the CI pipeline gains a Playwright job.

## Consequences

- Class names are global; the `rp-` prefix is reserved for this library.
- `ui-native` (P2-01) reads the same TS tokens (numbers are dp) and should reuse
  `ORDER_ITEM_STATE_STYLES`, the icon names and the colour roles so both libraries match.
- Changing a token value is a one-line change that tests check for contrast in every theme.
- Final brand colours (OI-01) only change `themes.ts`; the contrast tests guard the new values.
