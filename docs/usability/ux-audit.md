# UX and accessibility audit (P8-04a)

Requirements: NFR-U03, NFR-U04, NFR-U05, KDS-011, TAB-016. Audited 2026-10-11 on `main`.

## What is checked by tests on every build

| Check                                                                                              | Where                                                                               | Requirement      |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------- |
| Every control is at least the touch target (48 px; 64 px on the KDS theme)                         | `packages/ui-web/test/styles.test.ts`, `packages/ui-native/test/controls.test.tsx`  | NFR-U03, KDS-011 |
| axe-core finds no violation on each console screen (jsdom, contrast off)                           | `apps/console/test/*.test.tsx` through `expectNoAxeViolations`                      | NFR-U05          |
| axe-core WCAG 2.2 AA in a real browser, contrast on: console and QR menu                           | `apps/console/e2e/console.e2e.ts`, `apps/qr-menu/e2e/qr-menu.e2e.ts`                | NFR-U05          |
| Theme colour pairs meet contrast ratios in light, dark and KDS themes                              | `packages/design-tokens/test/color.test.ts`, `themes.test.ts`                       | NFR-U02, NFR-U05 |
| A screen folder with a loading state has an error state; one that lists records has an empty state | `apps/console/test/screen-states.test.ts`                                           | NFR-U04          |
| Error messages are plain language with a next step                                                 | `apps/console/test/messages.test.ts`, `apps/server/test/unit/error-mapping.test.ts` | NFR-U04          |

## Findings

| #   | Finding                                                                                                                                                       | Status                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 1   | Console screen folders all had loading and error states; audit, licence, reports, setup, system and owner show fixed rows or forms, so no empty state applies | Closed (guarded by the test above)                |
| 2   | Colour is never the only carrier of meaning: status chips, table tiles and alerts carry text or an icon as well                                               | Closed (`TableTile.test.tsx`, `display.test.tsx`) |
| 3   | Destructive actions ask for confirmation (void, cancel, deactivate, erase)                                                                                    | Closed (existing dialogs)                         |
| 4   | Contextual help and first-use tips (NFR-U07, Should)                                                                                                          | Open: P8-04b                                      |
| 5   | Usability results with 5 users per role (NFR-U06)                                                                                                             | Open: pilot, `usability-test-scripts.md` [H]      |
| 6   | Screen-reader pass on a real phone (TalkBack) for the QR menu                                                                                                 | Open: manual, needs a person with a phone         |
