import type { ThemeName } from '@rp/design-tokens';
import { render } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { EN_STRINGS } from '../fixtures/en-strings.js';
import { ThemeProvider, UiStringsProvider } from '../src/index.js';

/** Renders inside the providers every app sets up (strings from i18n, theme from settings). */
export function renderUi(ui: ReactElement, theme: ThemeName = 'light'): ReturnType<typeof render> {
  return render(
    <UiStringsProvider strings={EN_STRINGS}>
      <ThemeProvider theme={theme}>{ui}</ThemeProvider>
    </UiStringsProvider>,
  );
}
