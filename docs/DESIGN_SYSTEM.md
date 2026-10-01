# Design System: Restaurant Operations Platform

Every visual decision in one place, so no agent invents one. The source of truth is code:
`packages/design-tokens/src` (values), `packages/ui-web` and `packages/ui-native` (components),
ADR-0009 (approach). This file describes them. If this file and the code disagree, the code wins
and this file is fixed in the same pull request. Final brand colours wait for OI-01; when they
arrive, only `packages/design-tokens/src/themes.ts` changes and its contrast tests guard the result.

## 01 Brand identity

- Personality: calm, clear, quick.
- Who reads it: staff in a hurry (often standing, sometimes with wet or gloved hands) and diners
  who have never seen the app. Design for a glance, not a read.
- Tone in UI copy: plain language, short sentences, no exclamation marks, no jargon. An error says
  what happened and what to do next ("Can't reach the restaurant server. Check the Wi-Fi and try
  again."). Name things the way the floor does: table, KOT, bill, pass.
- Feel: light and dense on the POS and dashboard, dark and large on the KDS, warm and simple on the
  diner surfaces (tablet, QR) where the restaurant's accent colour applies (NFR-U02).
- All copy lives in `packages/i18n/src/catalogues/en.ts` and is read with `t('area.key', values)`
  (NFR-L02). ESLint rejects literal text in JSX.

## 02 Color palette

Components use colour roles, never raw hex values (a test fails on raw colours in `@rp/ui-web`
stylesheets). On the web each role is a CSS variable `--rp-color-<role-in-kebab>`; in React Native
read `themes[name].<role>` through `@rp/ui-native`'s theme.

Three themes: `light` (POS, dashboard, diner surfaces), `dark`, and `kds` (near-black, AAA text,
the KDS default, KDS-011). Choose with `data-theme="light|dark|kds"`; without it the root follows
the operating system.

Light theme (abridged; the full set is in `themes.ts`):

| Role (`--rp-color-…`) | Light     | Use                                           |
| --------------------- | --------- | --------------------------------------------- |
| `background`          | `#f8fafc` | Page background                               |
| `surface`             | `#ffffff` | Cards, panels, table rows                     |
| `surface-raised`      | `#ffffff` | Dialogs, sheets, toasts, menus                |
| `surface-sunken`      | `#f1f5f9` | Inputs, wells, keypad background              |
| `border`              | `#e2e8f0` | Decorative dividers                           |
| `border-strong`       | `#64748b` | Control outlines (≥ 3:1 against surfaces)     |
| `text`                | `#0f172a` | Body text                                     |
| `text-muted`          | `#475569` | Secondary text, captions                      |
| `primary`             | `#1d4ed8` | Primary buttons, links, active states         |
| `primary-hover`       | `#1e40af` | Hover on primary                              |
| `accent`              | `#1d4ed8` | The restaurant's brand colour slot            |
| `focus-ring`          | `#2563eb` | Focus outline                                 |
| `info`                | `#0369a1` | Sent, preparing                               |
| `success`             | `#15803d` | Ready, picked up, confirmations               |
| `warning`             | `#b45309` | Waiting for approval, non-blocking warnings   |
| `danger`              | `#b91c1c` | Errors, destructive actions, cancelled/voided |

Each tone also has `on-<tone>` (text on it), `<tone>-subtle` (tinted background) and `<tone>-text`
(text on the subtle background). The tones are `neutral`, `info`, `success`, `warning`, `danger`.

Rules:

- One primary colour. Tones carry state, never decoration.
- WCAG 2.2 AA for every theme and AAA for KDS text, enforced by tests on the token values
  (`pnpm --filter @rp/design-tokens test`).
- Colour is never the only signal (NFR-U05): every state also has an icon or a word. KDS ticket
  age is green under 10 min, amber 10 to 20, red over 20 (settings, KDS-004), always with text.
- The restaurant accent is set with `accentVariables(hex)` (`ThemeRoot` in `@rp/ui-web`), which
  also picks a readable `on-accent` text colour. It applies to diner surfaces only.
- Dark mode is supported by swapping tokens. Never hard-code a colour for one theme.

Order item states (`ORDER_ITEM_STATE_STYLES`, shared by web and native):

| State            | Tone    | Icon          |
| ---------------- | ------- | ------------- |
| PENDING_APPROVAL | warning | `clock`       |
| SENT             | info    | `send`        |
| PREPARING        | info    | `flame`       |
| READY            | success | `check`       |
| PICKED_UP        | success | `handPlatter` |
| SERVED           | neutral | `checkDouble` |
| REJECTED         | danger  | `xCircle`     |
| CANCELLED        | danger  | `xCircle`     |
| VOIDED           | danger  | `ban`         |

## 03 Typography

System fonts only: nothing is downloaded, so every screen renders offline (NFR-A01) and each
platform uses its own face (Segoe UI on Windows, Roboto on Android).

- Sans: `system-ui, 'Segoe UI', Roboto, 'Noto Sans', 'Helvetica Neue', Arial, sans-serif`
- Mono: `ui-monospace, 'Cascadia Mono', 'Segoe UI Mono', 'Roboto Mono', Menlo, Consolas, monospace`

| Token (`--rp-font-size-…`) | Default | KDS theme | Typical use                  |
| -------------------------- | ------- | --------- | ---------------------------- |
| `xs`                       | 12px    | 16px      | Badges, fine print           |
| `sm`                       | 14px    | 18px      | Secondary text, table cells  |
| `md`                       | 16px    | 20px      | Body                         |
| `lg`                       | 18px    | 24px      | Emphasised body, card titles |
| `xl`                       | 20px    | 28px      | Section titles               |
| `2xl`                      | 24px    | 32px      | Page titles                  |
| `3xl`                      | 30px    | 40px      | Totals, KOT numbers          |
| `4xl`                      | 36px    | 48px      | Hero numbers                 |

Weights: regular 400, medium 500, semibold 600, bold 700. Line heights: tight 1.2, snug 1.35,
normal 1.5. Web sizes are emitted in rem so text scales with the browser setting.

Rules:

- Two families at most (sans and mono). Mono is for codes, references and tabular figures.
- Money is always shown through `Money` / `formatRupees` (₹ with Indian grouping, 1,00,000.00;
  NFR-L03), never formatted by hand. Dates DD-MM-YYYY, time zone Asia/Kolkata.

## 04 Spacing

4 px grid. Use only these tokens (`--rp-space-<n>`; numbers are px on web, dp on native).

| Token      | Value | Typical use                  |
| ---------- | ----- | ---------------------------- |
| `space-1`  | 4px   | Icon gaps                    |
| `space-2`  | 8px   | Inside small components      |
| `space-3`  | 12px  | Input padding                |
| `space-4`  | 16px  | Default gap between elements |
| `space-5`  | 20px  | Roomier gaps                 |
| `space-6`  | 24px  | Card padding                 |
| `space-8`  | 32px  | Between groups               |
| `space-10` | 40px  | Between sections (compact)   |
| `space-12` | 48px  | Between sections             |
| `space-16` | 64px  | Page-level separation        |

Layout: the dashboard puts its navigation beside the page from 60rem and above it on a phone; the
console's margins shrink at 40rem and below.

## 05 Border radius, elevation and layers

| Token         | Value  | Use                 |
| ------------- | ------ | ------------------- |
| `radius-sm`   | 4px    | Badges, small chips |
| `radius-md`   | 8px    | Buttons, inputs     |
| `radius-lg`   | 12px   | Cards, table tiles  |
| `radius-xl`   | 16px   | Dialogs, sheets     |
| `radius-full` | 9999px | Pills, avatars      |

Elevation (`--rp-elevation-<n>`; native uses the matching `androidElevation`):

- `0` none: flat cards use a border instead.
- `1` subtle: raised cards.
- `2` medium: menus, popovers.
- `3` strong: dialogs and sheets.

Z-index tokens (`--rp-z-…`): base 0, sticky 100, banner 200, overlay 300, dialog 400, toast 500.

## 06 Components

Reuse before creating. Web: `packages/ui-web/src/components`. Native: `packages/ui-native/src/
components`. Both take the same props and tokens. A new primitive goes into the library (not an
app) with tests, and gets a line here in the same pull request. Shared ordering behaviour
(MENU-012) lives in `@rp/domain` and `@rp/ordering`, not in a component.

| Group    | Web (`@rp/ui-web`)                                                             | Native (`@rp/ui-native`)                                                    |
| -------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Actions  | `Button`, `IconButton`, `Icon`, `Spinner`                                      | `Button`, `Glyph`                                                           |
| Input    | `PinPad`, `NumberPad`, `TextField`, `Select`, `QuantityStepper`, `ChoiceGroup` | `PinPad`, `TextField`, `QuantityStepper`, `ChoiceGroup`, `SegmentedControl` |
| Ordering | `MenuItemCard`, `ItemOptions`, `ComboChoices`, `TableTile`                     | `MenuItemCard`, `ItemOptions`, `ComboChoices`, `TableTile`                  |
| Overlays | `Dialog`, `Sheet`, `ConfirmDialog`, `ToastProvider` + `useToast`               | `Sheet`, `Toast`                                                            |
| Display  | `Badge`, `StatusChip`, `Money`, `Card`, `Table`, `Tabs`, `QrCode`              | `StatusChip`, `Money`                                                       |
| States   | `EmptyState`, `LoadingState`, `ErrorState`, `ConnectionBanner`                 | (screens in `@rp/mobile-shell`: connection banner, alerts)                  |
| Setup    | `ThemeRoot`, `UiStringsProvider`                                               | theme provider in `theme.tsx`                                               |

Buttons: variants `primary` (one per screen, the main action), `secondary`, `ghost`, `danger`
(destructive, always confirmed) and `accent` (diner surfaces). Sizes `md` (meets 48 px) and `lg`
(primary actions on touch screens). `loading` shows a spinner, keeps the width and blocks a
second press, which matters for anything that submits.

Rules every component follows:

- Interactive elements are at least `--rp-touch-target`: 48 px by default, 64 px in the KDS theme.
- Visible focus ring on every interactive element.
- No UI text inside a library component: labels are props, built-in words come from
  `UiStringsProvider`.
- Inside a `Dialog`, mark the first field with `data-autofocus`, not `autoFocus`.
- Every data-driven screen has designed loading, empty and error states (NFR-U04). Destructive
  actions ask for confirmation with `ConfirmDialog`.
- Manager approvals always use the shared `PinPad` (AUTH-004), on whatever device the action
  started.

## 07 Icons

- One small built-in set in `@rp/ui-web` `Icon` (and `Glyph` on native): 24 px grid, 2 px stroke,
  round caps, no icon dependency, identical on web and native. Names are in `ICON_NAMES`.
- Add a new icon by adding its path to that set (and the native one), not by installing a library.
- Icons are decorative. The text beside them or the control's accessible name carries the meaning.

## 08 Responsive breakpoints and surfaces

| Token (`--rp-breakpoint-…`) | Min width | Notes        |
| --------------------------- | --------- | ------------ |
| `sm`                        | 600px     | Large phones |
| `md`                        | 900px     | Tablets      |
| `lg`                        | 1200px    | Desktops     |

Per surface:

- POS (Electron on the restaurant PC, often a touchscreen): desktop first, touch-sized.
- Manager dashboard: works on a 360 px phone and on desktop (MGR-011), no sideways scrolling
  except tables. Playwright checks both.
- KDS: landscape tablet or TV, `kds` theme, readable from 2 m, 64 px targets (KDS-011).
- Waiter app: Android phone, one hand, ≤ 5 taps to reorder and send, ≤ 2 to approve (NFR-U03).
- Table tablet: 8 to 10 inch Android tablet, large text, first order unaided in ≤ 2 min (TAB-016).
- QR menu: mobile first from 360 px, LCP ≤ 2.5 s on 4G (QR-012), WCAG 2.2 AA.

## 09 Motion

- Durations (`--rp-duration-…`): instant 0, fast 120ms (taps, hovers), normal 200ms (panels,
  dialogs), slow 320ms (page-level).
- Easing (`--rp-easing-…`): `standard` cubic-bezier(0.2, 0, 0, 1), `enter` cubic-bezier(0, 0, 0, 1),
  `exit` cubic-bezier(0.3, 0, 1, 1).
- Visual feedback within 100 ms of a tap, screen transitions within 300 ms (NFR-P07).
- `prefers-reduced-motion` sets every duration to 0 in the token stylesheet.
