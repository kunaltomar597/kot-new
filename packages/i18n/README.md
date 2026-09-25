# @rp/i18n

UI text for every app (NFR-L02). English only in v1; another language is one more catalogue with the
same keys, no code changes. Built by P0-14a.

```ts
import { createTranslator } from '@rp/i18n';

const t = createTranslator(); // English, en-IN plural rules and number grouping
t('login.pinFor', { name: 'Asha' }); // "Enter the PIN for Asha"
t('login.attemptsLeft', { count: 1 }); // "1 try left before this login is locked."
```

- Messages live in `src/catalogues/en.ts`, grouped by area. Keys are a typed union (`MessageKey`),
  so a typo does not compile; `CatalogueOf<typeof en>` makes another language match key for key.
- Message syntax is an ICU MessageFormat subset (`src/message-format.ts`): `{name}`,
  `{count, plural, =0 {…} one {# …} other {# …}}`, `{role, select, OWNER {…} other {…}}` and
  `{n, number}`. An apostrophe only quotes before `{`, `}` or `#`, so "You'll" needs no escaping.
- Missing messages or values throw by default (tests and development fail loudly); pass `onError`
  to log instead.
- Money is not formatted here: use `formatRupees` from `@rp/domain` and pass the text in.
- Never write UI text as a JSX literal: ESLint (`packages/config/eslint/ui-text.mjs`) flags text
  children and text props (`label`, `title`, `aria-label`, …) in app and UI-library sources.
