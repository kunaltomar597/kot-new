import '@rp/design-tokens/tokens.css';
import '../src/styles/index.css';
import { THEME_NAMES, type ThemeName } from '@rp/design-tokens';
import type { Preview } from '@storybook/react-vite';
import { EN_STRINGS } from '../fixtures/en-strings.js';
import { ThemeRoot } from '../src/components/ThemeRoot.js';
import { ToastProvider } from '../src/components/Toast.js';
import { UiStringsProvider } from '../src/strings.js';

const preview: Preview = {
  globalTypes: {
    theme: {
      description: 'Theme',
      toolbar: { title: 'Theme', icon: 'mirror', items: [...THEME_NAMES], dynamicTitle: true },
    },
    accent: {
      description: 'Restaurant accent colour',
      toolbar: {
        title: 'Accent',
        icon: 'paintbrush',
        items: [
          { value: '', title: 'Default' },
          { value: '#c2410c', title: 'Saffron' },
          { value: '#15803d', title: 'Leaf' },
          { value: '#fde047', title: 'Turmeric' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: 'light', accent: '' },
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story, context) => {
      const theme = context.globals.theme as ThemeName;
      const accent = context.globals.accent as string;
      return (
        <UiStringsProvider strings={EN_STRINGS}>
          <ToastProvider>
            <ThemeRoot
              theme={theme}
              accent={accent || undefined}
              style={{ minHeight: '100vh', padding: 24 }}
            >
              <Story />
            </ThemeRoot>
          </ToastProvider>
        </UiStringsProvider>
      );
    },
  ],
};

export default preview;
