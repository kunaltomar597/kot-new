# @rp/design-tokens

The design tokens for every app (NFR-U01): colour themes (light, dark, KDS dark), typography,
spacing, radius, elevation, motion, z-index and touch-target sizes, with a restaurant accent slot
(NFR-U02). Built in P0-13; see ADR-0009. Final brand colours wait for OI-01.

## Use

TypeScript (web and React Native):

```ts
import { themes, spacing, touchTarget, fontSize } from '@rp/design-tokens';
themes.kds.background; // '#000000'
```

CSS (web): import once, then choose a theme with `data-theme` on any element (themes nest). Without
`data-theme` the root follows the operating system's light/dark setting.

```ts
import '@rp/design-tokens/tokens.css';
```

```css
.panel {
  background: var(--rp-color-surface);
  padding: var(--rp-space-4);
  min-height: var(--rp-touch-target);
}
```

Restaurant accent: `accentVariables('#c2410c')` returns the accent variables with a readable text
colour; `ThemeRoot` in `@rp/ui-web` applies them.

## Rules

- Components use colour roles (`surface`, `textMuted`, `dangerSubtle`), never raw colours.
- Tests check WCAG 2.2 contrast for every theme (AA; AAA for KDS text). Change a colour and
  `pnpm --filter @rp/design-tokens test` tells you if it still passes.
- Numbers are px on the web and dp on native. The CSS emits font sizes in rem so text scales.
- `dist/tokens.css` is generated from the TS objects by `scripts/write-css.mjs` during the build.
