# packages/config

Shared tool presets. The base configs live at the repository root (`tsconfig.base.json`,
`eslint.config.mjs`, `.prettierrc.json`); framework presets live here.

- `tsconfig.react.json`: TypeScript preset for React web packages (DOM libs, `react-jsx`). Used by
  `packages/ui-web` (P0-13); `apps/console` extends it in P0-14.

React ESLint rules (hooks, React Compiler checks, jsx-a11y) are in the root `eslint.config.mjs` and
apply to every `.tsx` file. A React Native preset is added in P2-01.

- `eslint/ui-text.mjs`: the `no-restricted-syntax` selectors that keep UI text out of JSX literals
  (NFR-L02), applied by the root config to app and UI-library sources and tested in
  `packages/i18n/test/ui-text-rule.test.ts`.
